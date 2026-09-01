/**
 * Auth flow through the real router: login -> authed request -> refresh ->
 * logout revokes -> password change. Self-contained passwords, no IdP.
 *
 * Accounts are created here with `app.auth.register`, the account-creation
 * primitive. The HTTP sign-up path no longer hands back tokens at all — it
 * answers 202 and emails a link, because a 201-vs-409 split told anyone who
 * asked which addresses have accounts. That path has its own file:
 * auth-verify.test.ts.
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

test("password auth: sign in, refresh, revoke on logout", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  // Sign-up still refuses a password too short to be worth hashing, and says so
  // without depending on whether the address is known.
  const short = await call(r, "POST", "/v1/auth/register", { email: "p@e.com", password: "short", displayName: "P" });
  assert.equal(short.status, 400, "too-short password rejected");

  await app.auth.register("p@e.com", "correct-horse", "P");
  const first = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  assert.equal(first.status, 200);
  const tokens = first.body as { accessToken: string; refreshToken: string; tokenType: string };
  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.accessToken && tokens.refreshToken);

  // Wrong password is rejected; correct one logs in.
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "nope" })).status, 401);
  const login = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  assert.equal(login.status, 200);
  const access = (login.body as { accessToken: string }).accessToken;

  // Authed request works with the access token, fails without.
  assert.equal((await call(r, "GET", "/v1/me")).status, 401);
  assert.equal((await call(r, "GET", "/v1/me", undefined, access)).status, 200);

  // Refresh mints a new usable access token (same session as `tokens`).
  const refresh = await call(r, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(refresh.status, 200);
  const access2 = (refresh.body as { accessToken: string }).accessToken;
  assert.equal((await call(r, "GET", "/v1/me", undefined, access2)).status, 200);

  // Per-device logout revokes ONLY the current session. `access` is the second
  // sign-in; logging it out must NOT kill the first one.
  assert.equal((await call(r, "POST", "/v1/auth/logout", undefined, access)).status, 200);
  assert.equal((await call(r, "GET", "/v1/me", undefined, access)).status, 401, "this device's token revoked");
  assert.equal((await call(r, "GET", "/v1/me", undefined, access2)).status, 200, "the other session survives");

  // logout-all revokes everything (bumps tokenVersion + revokes all sessions).
  assert.equal((await call(r, "POST", "/v1/auth/logout-all", undefined, access2)).status, 200);
  assert.equal((await call(r, "GET", "/v1/me", undefined, access2)).status, 401, "all sessions revoked");
  assert.equal((await call(r, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken })).status, 401, "refresh revoked too");
});

test("per-device sessions: list and remotely revoke one device", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await app.auth.register("s@e.com", "correct-horse", "S");

  // Two logins = two sessions ("phone" and "laptop" via X-Device-Label).
  const login = (label: string) => r.handle({
    method: "POST", path: "/v1/auth/login", query: new URLSearchParams(),
    headers: { "x-device-label": label }, params: {},
    json: async () => ({ email: "s@e.com", password: "correct-horse" }) as never,
  });
  const phone = (await login("Phone")).body as { accessToken: string };
  const laptop = (await login("Laptop")).body as { accessToken: string };

  // The phone lists both sessions and sees which one is current.
  const list = (await call(r, "GET", "/v1/me/sessions", undefined, phone.accessToken)).body as Array<{ id: string; label: string; current: boolean }>;
  assert.ok(list.length >= 2, "phone + laptop sessions are both listed");
  assert.equal(list.filter((s) => s.current).length, 1, "exactly one session is current");
  const laptopId = list.find((s) => s.label === "Laptop")!.id;

  // Phone remotely signs out the laptop; laptop's token dies, phone survives.
  assert.equal((await call(r, "DELETE", `/v1/me/sessions/${laptopId}`, undefined, phone.accessToken)).status, 200);
  assert.equal((await call(r, "GET", "/v1/me", undefined, laptop.accessToken)).status, 401, "laptop revoked");
  assert.equal((await call(r, "GET", "/v1/me", undefined, phone.accessToken)).status, 200, "phone still signed in");
});

test("password change verifies the current password and revokes old sessions", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await app.auth.register("c@e.com", "first-password", "C");
  const access = ((await call(r, "POST", "/v1/auth/login", { email: "c@e.com", password: "first-password" }))
    .body as { accessToken: string }).accessToken;

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
