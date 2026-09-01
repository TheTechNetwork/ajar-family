/**
 * What the parent decided, told to the device.
 *
 * THE BUG THIS ENDPOINT CLOSES. A "Not now" writes a temporary BLOCK grant that
 * expires after ONCE_GRANT_TTL_MS — five minutes — and the block pages could
 * only work out "declined" by finding such a rule in the signed snapshot, which
 * the policy builder drops the moment it expires. So a child who was refused saw
 * the answer for five minutes at most, and then the page went back to "waiting
 * on a parent" for as long as the ask was remembered: seven days.
 *
 * That is the worst thing a block screen can do — a refused child left believing
 * nobody looked — so the load-bearing test here is the one that advances the
 * clock past the grant and asserts the answer is STILL reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import { ONCE_GRANT_TTL_MS } from "../domain/services.js";
import type { HttpRequest, HttpResponse } from "./router.js";

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

interface Answer { requestId: string; targetType: string; targetValue: string; answer: string; askedAt: string }

async function fixture() {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await app.auth.register("p@e.com", "correct-horse", "P");
  const parent = ((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" }))
    .body as { accessToken: string }).accessToken;
  const fam = (await call(r, "POST", "/v1/families", { name: "F" }, parent)).body as { id: string };

  const mkChild = async (displayName: string) => {
    const child = (await call(r, "POST", `/v1/families/${fam.id}/children`, { displayName }, parent)).body as { id: string };
    const code = (await call(r, "POST", `/v1/families/${fam.id}/enroll`,
      { childId: child.id, platform: "WINDOWS" }, parent)).body as { code: string };
    const redeemed = (await call(r, "POST", "/v1/enroll/redeem",
      { code: code.code, devicePublicKey: "pk", displayName: `${displayName}'s PC` })).body as
      { device: { id: string }; deviceToken: string };
    return { childId: child.id, deviceId: redeemed.device.id, token: redeemed.deviceToken };
  };

  return { app, r, parent, famId: fam.id, mkChild };
}

const ask = (c: Awaited<ReturnType<typeof fixture>>, dev: { token: string }, value: string) =>
  call(c.r, "POST", "/v1/requests", { targetType: "YOUTUBE_VIDEO", targetValue: value }, dev.token);

const answers = async (c: Awaited<ReturnType<typeof fixture>>, dev: { deviceId: string; token: string }) =>
  ((await call(c.r, "GET", `/v1/devices/${dev.deviceId}/answers`, undefined, dev.token))
    .body as { answers: Answer[] }).answers;

test("a refusal is still reported long after its grant has expired", async () => {
  const c = await fixture();
  const kid = await c.mkChild("Jane");

  const req = (await ask(c, kid, "dQw4w9WgXcQ")).body as { id: string };
  assert.deepEqual(await answers(c, kid), [], "an ask nobody has answered is not an answer");

  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${req.id}/decide`,
    { decision: "BLOCK", scope: "THIS_REQUEST", duration: { kind: "ONCE" } }, c.parent);

  const now = await answers(c, kid);
  assert.equal(now.length, 1);
  assert.equal(now[0]!.answer, "closed");
  assert.equal(now[0]!.requestId, req.id);

  // THE POINT. Past the grant's expiry, where the old inference stopped working
  // and the block page silently reverted to "waiting on a parent".
  const realNow = Date.now;
  try {
    const later = realNow() + ONCE_GRANT_TTL_MS + 60_000;
    Date.now = () => later;
    const after = await answers(c, kid);
    assert.equal(after.length, 1, "the answer outlives the grant that carried it");
    assert.equal(after[0]!.answer, "closed");
  } finally {
    Date.now = realNow;
  }
});

test("an approval reads as opened", async () => {
  const c = await fixture();
  const kid = await c.mkChild("Jane");
  const req = (await ask(c, kid, "abc12345678")).body as { id: string };

  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${req.id}/decide`,
    { decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 } }, c.parent);

  const [a] = await answers(c, kid);
  // "opened"/"closed", not APPROVED/DENIED: this is read by a screen a child
  // looks at, and the product settled on open/closed (BRAND.md §6.1).
  assert.equal(a!.answer, "opened");
});

test("a device never sees a sibling's answers", async () => {
  // A device token is not a parent session. Whatever a brother was refused is
  // not readable from his sister's laptop.
  const c = await fixture();
  const jane = await c.mkChild("Jane");
  const bob = await c.mkChild("Bob");

  const bobsReq = (await ask(c, bob, "bobvideo123")).body as { id: string };
  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${bobsReq.id}/decide`,
    { decision: "BLOCK", scope: "THIS_REQUEST", duration: { kind: "ONCE" } }, c.parent);

  assert.deepEqual(await answers(c, jane), [], "Jane's device sees nothing of Bob's");
  assert.equal((await answers(c, bob)).length, 1);
});

test("one device's token cannot read another device's answers", async () => {
  const c = await fixture();
  const jane = await c.mkChild("Jane");
  const bob = await c.mkChild("Bob");

  const res = await call(c.r, "GET", `/v1/devices/${bob.deviceId}/answers`, undefined, jane.token);
  assert.equal(res.status, 403);
});

test("a parent session is not a device token here", async () => {
  // The endpoint is device-scoped on purpose. A parent has richer views
  // elsewhere; accepting a user token here would make the scoping above
  // decorative.
  const c = await fixture();
  const kid = await c.mkChild("Jane");
  const res = await call(c.r, "GET", `/v1/devices/${kid.deviceId}/answers`, undefined, c.parent);
  assert.equal(res.status, 401);
});

test("the payload carries the answer and nothing about who decided or how widely", async () => {
  const c = await fixture();
  const kid = await c.mkChild("Jane");
  const req = (await ask(c, kid, "scopeleak12")).body as { id: string };

  await call(c.r, "POST", `/v1/families/${c.famId}/requests/${req.id}/decide`,
    { decision: "ALLOW", scope: "WHOLE_FAMILY", duration: { kind: "ALWAYS" } }, c.parent);

  const [a] = await answers(c, kid);
  const keys = Object.keys(a!).sort();
  assert.deepEqual(keys, ["answer", "askedAt", "requestId", "targetType", "targetValue"],
    "the child learns they were answered and which way — the scope, the duration and the parent are not theirs");
});
