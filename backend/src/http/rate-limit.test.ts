/**
 * Rate limiter: allows up to `limit` per window, then blocks; and the router
 * actually 429s the sensitive endpoints after the budget is spent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "./rate-limit.js";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import { Router, ok, err, type HttpRequest } from "./router.js";

test("RateLimiter allows up to the limit, then blocks", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), false, "4th over budget");
  assert.equal(rl.allow("other"), true, "a different key has its own budget");
});

test("clientKey does not trust x-forwarded-for unless an operator says to", () => {
  // This test used to assert the opposite and the opposite was the hole: a
  // client that rotates X-Forwarded-For gets a fresh bucket per request, so on
  // the self-hosted binary there was no limit on login, register, forgot, reset
  // or enrollment redeem — and each login attempt costs 600,000 PBKDF2
  // iterations, so it was a CPU amplifier too.
  assert.equal(clientKey({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }), "shared");
  assert.equal(clientKey({ "x-real-ip": "9.9.9.9" }), "shared");
  assert.equal(clientKey({}), "shared");

  // Cloudflare sets this at the edge and strips a client copy, so it is
  // trustworthy without opting in.
  assert.equal(clientKey({ "cf-connecting-ip": "1.2.3.4" }), "1.2.3.4");
  // ...and it wins over headers a client could have sent.
  assert.equal(clientKey({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), "1.2.3.4");

  // Behind a proxy the operator controls, opted in explicitly.
  assert.equal(clientKey({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, true), "9.9.9.9");
  assert.equal(clientKey({ "x-real-ip": "9.9.9.9" }, true), "9.9.9.9");
  assert.equal(clientKey({}, true), "shared");
});

test("rotating a forwarded header does not buy extra attempts", () => {
  const lim = new RateLimiter(3, 60_000);
  const attempt = (i: number) => lim.allow(clientKey({ "x-forwarded-for": `10.0.0.${i}` }));
  assert.ok(attempt(1) && attempt(2) && attempt(3), "the first three are allowed");
  assert.equal(attempt(4), false, "a fresh header value is still the same bucket");
  assert.equal(attempt(5), false);
});

test("a before() guard applies to every route (baseline limit)", async () => {
  const r = new Router();
  r.get("/anything", async () => ok({ ok: true }));
  let n = 0;
  r.before(() => (n++ >= 2 ? err(429, "slow down", "RATE_LIMITED") : null));
  const call = () => r.handle({
    method: "GET", path: "/anything", query: new URLSearchParams(),
    headers: {}, params: {}, json: async () => ({}) as never,
  } as HttpRequest);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429, "guard short-circuits before dispatch");
  // The guard even fires for unmatched paths (blocks scanning), not just 404.
  const miss = await r.handle({ method: "GET", path: "/nope", query: new URLSearchParams(), headers: {}, params: {}, json: async () => ({}) as never } as HttpRequest);
  assert.equal(miss.status, 429);
});

test("login endpoint 429s after too many attempts", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const call = () => r.handle({
    method: "POST", path: "/v1/auth/login", query: new URLSearchParams(),
    headers: { "cf-connecting-ip": "5.5.5.5" }, params: {},
    json: async () => ({ email: "x@y.com", password: "whatever" }) as never,
  } as HttpRequest);

  let sawRateLimit = false;
  for (let i = 0; i < 12; i++) {
    const res = await call();
    if (res.status === 429) { sawRateLimit = true; break; }
  }
  assert.equal(sawRateLimit, true, "repeated login attempts are eventually rate-limited");
});
