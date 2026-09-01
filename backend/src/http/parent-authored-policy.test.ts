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
  return { app, r, tok: login.accessToken, famId: fam.id, childId: child.id,
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
