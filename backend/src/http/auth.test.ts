/**
 * Auth flow through the real router: register -> login -> authed request ->
 * refresh -> logout revokes -> password change. Self-contained passwords, no IdP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string, body?: unknown, token?: string): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

test("password auth: register, login, refresh, revoke on logout", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  // Register requires a password of adequate length.
  const short = await call(r, "POST", "/v1/auth/register", { email: "p@e.com", password: "short", displayName: "P" });
  assert.equal(short.status, 400, "too-short password rejected");

  const reg = await call(r, "POST", "/v1/auth/register", { email: "p@e.com", password: "correct-horse", displayName: "P" });
  assert.equal(reg.status, 201);
  const tokens = reg.body as { accessToken: string; refreshToken: string; tokenType: string };
  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.accessToken && tokens.refreshToken);

  // Duplicate registration conflicts.
  assert.equal((await call(r, "POST", "/v1/auth/register", { email: "p@e.com", password: "another-one", displayName: "P" })).status, 409);

  // Wrong password is rejected; correct one logs in.
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "nope" })).status, 401);
  const login = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  assert.equal(login.status, 200);
  const access = (login.body as { accessToken: string }).accessToken;

  // Authed request works with the access token, fails without.
  assert.equal((await call(r, "GET", "/v1/me")).status, 401);
  assert.equal((await call(r, "GET", "/v1/me", undefined, access)).status, 200);

  // Refresh mints a new usable access token.
  const refresh = await call(r, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(refresh.status, 200);
  const access2 = (refresh.body as { accessToken: string }).accessToken;
  assert.equal((await call(r, "GET", "/v1/me", undefined, access2)).status, 200);

  // Logout revokes EVERY outstanding token (bumps tokenVersion).
  assert.equal((await call(r, "POST", "/v1/auth/logout", undefined, access)).status, 200);
  assert.equal((await call(r, "GET", "/v1/me", undefined, access)).status, 401, "access token revoked");
  assert.equal((await call(r, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken })).status, 401, "refresh token revoked");
});

test("password change verifies the current password and revokes old sessions", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const reg = await call(r, "POST", "/v1/auth/register", { email: "c@e.com", password: "first-password", displayName: "C" });
  const access = (reg.body as { accessToken: string }).accessToken;

  // Wrong current password rejected.
  assert.equal((await call(r, "POST", "/v1/auth/password", { currentPassword: "wrong", newPassword: "second-password" }, access)).status, 401);

  // Correct change returns fresh tokens and revokes the old one.
  const changed = await call(r, "POST", "/v1/auth/password", { currentPassword: "first-password", newPassword: "second-password" }, access);
  assert.equal(changed.status, 200);
  const newAccess = (changed.body as { accessToken: string }).accessToken;
  assert.equal((await call(r, "GET", "/v1/me", undefined, access)).status, 401, "old token revoked by password change");
  assert.equal((await call(r, "GET", "/v1/me", undefined, newAccess)).status, 200, "new token works");

  // The new password logs in; the old one no longer does.
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "c@e.com", password: "first-password" })).status, 401);
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "c@e.com", password: "second-password" })).status, 200);
});
