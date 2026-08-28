/**
 * Rate limiter: allows up to `limit` per window, then blocks; and the router
 * actually 429s the sensitive endpoints after the budget is spent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "./rate-limit.js";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest } from "./router.js";

test("RateLimiter allows up to the limit, then blocks", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), false, "4th over budget");
  assert.equal(rl.allow("other"), true, "a different key has its own budget");
});

test("clientKey prefers forwarded IP headers, falls back to shared", () => {
  assert.equal(clientKey({ "cf-connecting-ip": "1.2.3.4" }), "1.2.3.4");
  assert.equal(clientKey({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }), "9.9.9.9");
  assert.equal(clientKey({}), "shared");
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
