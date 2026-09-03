/**
 * A parent deciding something WITHOUT being asked.
 *
 * `POST /v1/families/:id/rules` and `PUT .../children/:childId/defaults` have
 * existed — implemented, tested at the service layer, published in the OpenAPI —
 * since the policy engine landed, and no client ever called either one. So every
 * child sat on the posture hardcoded at `addChild` (websites open, YouTube
 * closed), the console could delete rules it had no way to create, and "block
 * all social media" was unreachable from every screen in the product.
 *
 * These tests are the round trip the console now performs: author it over HTTP,
 * then evaluate the device's signed snapshot with the shared evaluator and see
 * the answer change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";
import { evaluate } from "@ajar/shared/policy";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string,
              body?: unknown, token?: string): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

async function fixture() {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await app.auth.register("p@e.com", "correct-horse", "P");
  const login = (await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" }))
    .body as { accessToken: string; userId: string };
  const fam = (await call(r, "POST", "/v1/families", { name: "F" }, login.accessToken)).body as { id: string };
  const child = (await call(r, "POST", `/v1/families/${fam.id}/children`, { displayName: "Kid" },
    login.accessToken)).body as { id: string };
  const code = (await call(r, "POST", `/v1/families/${fam.id}/enroll`,
    { childId: child.id, platform: "WINDOWS" }, login.accessToken)).body as { code: string };
  const dev = (await call(r, "POST", "/v1/enroll/redeem",
    { code: code.code, devicePublicKey: "pk", displayName: "PC" })).body as
    { device: { id: string }; deviceToken: string };
  return { app, r, tok: login.accessToken, userId: login.userId, famId: fam.id, childId: child.id,
           deviceId: dev.device.id, deviceToken: dev.deviceToken };
}

const at = (snap: unknown, url: string, childId: string, deviceId: string) =>
  evaluate(snap as never, { url, childId, deviceId, nowMs: Date.now() }).action;

test("a parent can close a site nobody asked about, and the device sees it", async () => {
  const c = await fixture();
  const snapshot = async () => (await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`,
    undefined, c.deviceToken)).body;

  assert.equal(at(await snapshot(), "https://tiktok.com/@nasa", c.childId, c.deviceId), "ALLOW",
    "the shipped posture opens the whole web except YouTube");

  const created = await call(c.r, "POST", `/v1/families/${c.famId}/rules`, {
    target: "DOMAIN", value: "tiktok.com", action: "BLOCK", scope: { type: "FAMILY" },
  }, c.tok);
  assert.equal(created.status, 201);

  assert.equal(at(await snapshot(), "https://tiktok.com/@nasa", c.childId, c.deviceId), "BLOCK");
  assert.equal(at(await snapshot(), "https://example.com/", c.childId, c.deviceId), "ALLOW",
    "closing one site does not close the web");
});

test("a parent can close the web by default, and open one site back", async () => {
  const c = await fixture();
  const snapshot = async () => (await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`,
    undefined, c.deviceToken)).body;

  const read = await call(c.r, "GET", `/v1/families/${c.famId}/children/${c.childId}/defaults`,
    undefined, c.tok);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { webDefault: "ALLOW", youTubeDefault: "BLOCK" },
    "the console can SHOW the current posture, not just overwrite it");

  const put = await call(c.r, "PUT", `/v1/families/${c.famId}/children/${c.childId}/defaults`,
    { webDefault: "BLOCK", youTubeDefault: "BLOCK" }, c.tok);
  assert.equal(put.status, 200);

  assert.equal(at(await snapshot(), "https://example.com/", c.childId, c.deviceId), "BLOCK");

  await call(c.r, "POST", `/v1/families/${c.famId}/rules`, {
    target: "DOMAIN", value: "khanacademy.org", action: "ALLOW",
    scope: { type: "CHILD", childId: c.childId },
  }, c.tok);

  assert.equal(at(await snapshot(), "https://khanacademy.org/math", c.childId, c.deviceId), "ALLOW");
  assert.equal(at(await snapshot(), "https://example.com/", c.childId, c.deviceId), "BLOCK");

  const back = (await call(c.r, "GET", `/v1/families/${c.famId}/children/${c.childId}/defaults`,
    undefined, c.tok)).body;
  assert.deepEqual(back, { webDefault: "BLOCK", youTubeDefault: "BLOCK" });
});

test("changing the posture bumps the policy version, so devices re-sync", async () => {
  // A setting that does not reach the device is a setting that does not exist.
  const c = await fixture();
  const before = await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, c.deviceToken);
  const v = (before.body as { version: number }).version;

  await call(c.r, "PUT", `/v1/families/${c.famId}/children/${c.childId}/defaults`,
    { webDefault: "BLOCK", youTubeDefault: "BLOCK" }, c.tok);

  const poll = await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy?since=${v}`,
    undefined, c.deviceToken);
  assert.notEqual((poll.body as { upToDate?: boolean }).upToDate, true,
    "the device must be told its policy changed");
  assert.ok((poll.body as { version: number }).version > v);
});

test("a parent can take back a 30-minute yes before minute 31", async () => {
  // There was no way to. A permanent decision could be deleted; a timed grant
  // could not, and the console said so in a comment. The moment a parent most
  // wants this control is the moment they realise they got it wrong.
  const c = await fixture();
  const snapshot = async () => (await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`,
    undefined, c.deviceToken)).body;

  const req = (await call(c.r, "POST", "/v1/requests", {
    targetType: "DOMAIN", targetValue: "gamesite.example", url: "https://gamesite.example/play",
  }, c.deviceToken)).body as { id: string };
  await call(c.r, "POST", `/v1/families/${c.famId}/rules`, {
    target: "DOMAIN", value: "gamesite.example", action: "BLOCK", scope: { type: "FAMILY" },
  }, c.tok);
  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${req.id}/decide`, {
    decision: "ALLOW", scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: 30 },
  }, c.tok);
  assert.equal(at(await snapshot(), "https://gamesite.example/play", c.childId, c.deviceId), "ALLOW");

  const live = (await call(c.r, "GET", `/v1/families/${c.famId}/grants`, undefined, c.tok))
    .body as { id: string; value: string }[];
  assert.equal(live.length, 1, "the console can see what is open on a timer");
  const grant = live[0]!;
  assert.equal(grant.value, "gamesite.example");

  const before = (await snapshot() as { version: number }).version;
  const gone = await call(c.r, "DELETE", `/v1/families/${c.famId}/grants/${grant.id}`,
    undefined, c.tok);
  assert.equal(gone.status, 200);

  const after = await snapshot() as { version: number };
  assert.ok(after.version > before, "the device must be told, not left holding it until it expires");
  assert.equal(at(after, "https://gamesite.example/play", c.childId, c.deviceId), "BLOCK");
  assert.deepEqual((await call(c.r, "GET", `/v1/families/${c.famId}/grants`, undefined, c.tok)).body, []);
});

test("an expired grant is not offered as something to take back", async () => {
  const c = await fixture();
  const req = (await call(c.r, "POST", "/v1/requests", {
    targetType: "DOMAIN", targetValue: "gamesite.example",
  }, c.deviceToken)).body as { id: string };
  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${req.id}/decide`, {
    decision: "ALLOW", scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: 30 },
  }, c.tok);

  // Reach past the HTTP layer to age it — a list that mixes "still open" with
  // "over" is a list a parent has to read carefully at exactly the wrong moment.
  const grants = await c.app.policy.listActiveGrants(c.famId, c.userId,
    Date.now() + 31 * 60_000);
  assert.deepEqual(grants, []);
});

test("an ask nobody answered ages out instead of sitting in the list for ever", async () => {
  // "EXPIRED" has been declared in the model and published in the OpenAPI since
  // the beginning, and nothing ever set it. So "Waiting on you" only grew, and
  // filled with things a child wanted three weeks ago and stopped caring about.
  const c = await fixture();
  const req = (await call(c.r, "POST", "/v1/requests", {
    targetType: "DOMAIN", targetValue: "gamesite.example",
  }, c.deviceToken)).body as { id: string };

  assert.equal(((await call(c.r, "GET", `/v1/families/${c.famId}/requests?status=PENDING`,
    undefined, c.tok)).body as unknown[]).length, 1);

  const n = await c.app.approvals.expireStaleRequests(c.famId, Date.now() + 4 * 24 * 3600_000);
  assert.equal(n, 1);

  assert.deepEqual((await call(c.r, "GET", `/v1/families/${c.famId}/requests?status=PENDING`,
    undefined, c.tok)).body, [], "it leaves the list a parent is asked to act on");
  const expired = (await call(c.r, "GET", `/v1/families/${c.famId}/requests?status=EXPIRED`,
    undefined, c.tok)).body as { id: string }[];
  assert.equal(expired.length, 1, "and is still there as history, under the status the API publishes");
  assert.equal(expired[0]!.id, req.id);

  // A fresh ask is untouched — the sweep is about abandonment, not tidiness.
  await call(c.r, "POST", "/v1/requests", {
    targetType: "DOMAIN", targetValue: "other.example",
  }, c.deviceToken);
  assert.equal(await c.app.approvals.expireStaleRequests(c.famId), 0);
});
