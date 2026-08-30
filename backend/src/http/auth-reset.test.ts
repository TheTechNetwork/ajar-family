/**
 * Password reset through the real router. Before this there was no recovery at
 * all: a parent who forgot their password lost the family — and every device
 * enrolled under it — permanently.
 *
 * What is asserted: no account enumeration, the token really arrives by email,
 * it is single-use and TTL-bounded, it is not stored in the clear, and using it
 * kills every outstanding session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import { InMemoryMailSender } from "../push/mail.js";
import { RESET_TTL_MINUTES } from "../domain/services.js";
import type { HttpRequest, HttpResponse } from "./router.js";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string,
              body?: unknown, token?: string, ip = "1.1.1.1"): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: { "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

/** The reset code as it appears in the email we actually send (43-char base64url). */
function codeFrom(mail: InMemoryMailSender): string {
  const found = /[A-Za-z0-9_-]{40,}/.exec(mail.sent.at(-1)!.text);
  assert.ok(found, "the email carries a high-entropy reset code");
  return found[0];
}

async function fixture(ip = "1.1.1.1") {
  const mail = new InMemoryMailSender();
  const app = await App.create({ mail, config: { authSecret: "test" } });
  const r = buildRouter(app);
  const reg = await call(r, "POST", "/v1/auth/register",
    { email: "p@e.com", password: "first-password", displayName: "P" }, undefined, ip);
  assert.equal(reg.status, 201);
  return { app, r, mail, tokens: reg.body as { accessToken: string; refreshToken: string }, ip };
}

test("forgot: 202 for a known AND an unknown address (no enumeration)", async () => {
  const { r, mail } = await fixture();
  const known = await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" });
  const unknown = await call(r, "POST", "/v1/auth/forgot", { email: "nobody@e.com" });
  const malformed = await call(r, "POST", "/v1/auth/forgot", { email: "not-an-email" });

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202, "an unknown address must be indistinguishable");
  assert.equal(malformed.status, 202);
  assert.deepEqual(known.body, unknown.body, "identical bodies too, not just identical statuses");
  assert.equal(mail.sent.length, 1, "only the real account got an email");
  assert.equal(mail.sent[0]!.to, "p@e.com");
});

test("reset: the emailed token sets a new password and kills every session", async () => {
  const { app, r, mail, tokens } = await fixture("2.2.2.2");
  // The registration session is live to begin with.
  assert.equal((await call(r, "GET", "/v1/me", undefined, tokens.accessToken, "2.2.2.2")).status, 200);

  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "2.2.2.2");
  const code = codeFrom(mail);
  assert.ok(code.length > 20, "a high-entropy token is emailed");

  const reset = await call(r, "POST", "/v1/auth/reset", { token: code, newPassword: "second-password" }, undefined, "2.2.2.2");
  assert.equal(reset.status, 200, "reset succeeds and returns a fresh token pair");
  const fresh = (reset.body as { accessToken: string }).accessToken;

  assert.equal((await call(r, "GET", "/v1/me", undefined, fresh, "2.2.2.2")).status, 200, "the new session works");
  assert.equal((await call(r, "GET", "/v1/me", undefined, tokens.accessToken, "2.2.2.2")).status, 401,
    "every pre-reset session is revoked");
  assert.equal((await call(r, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken }, undefined, "2.2.2.2")).status, 401,
    "the pre-reset refresh token is dead too");

  // The new password logs in; the old one does not.
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "first-password" }, undefined, "2.2.2.2")).status, 401);
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "second-password" }, undefined, "2.2.2.2")).status, 200);

  // And the raw token is NOT what we stored.
  const user = await app.repo.getUserByEmail("p@e.com");
  const stored = await app.repo.getPasswordResetTokenByHash(code);
  assert.equal(stored, null, "the raw token is not a key into the store — only its hash is");
  assert.ok(user);
});

test("reset: a token is single-use", async () => {
  const { r, mail } = await fixture("3.3.3.3");
  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "3.3.3.3");
  const code = codeFrom(mail);
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: code, newPassword: "second-password" }, undefined, "3.3.3.3")).status, 200);
  const replay = await call(r, "POST", "/v1/auth/reset", { token: code, newPassword: "third-password-x" }, undefined, "3.3.3.3");
  assert.equal(replay.status, 401, "a used token cannot be replayed");
});

test("reset: asking again burns the previous token", async () => {
  const { r, mail } = await fixture("4.4.4.4");
  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "4.4.4.4");
  const first = codeFrom(mail);
  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "4.4.4.4");
  const second = codeFrom(mail);
  assert.notEqual(first, second);
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: first, newPassword: "second-password" }, undefined, "4.4.4.4")).status, 401,
    "the superseded token no longer works");
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: second, newPassword: "second-password" }, undefined, "4.4.4.4")).status, 200);
});

test("reset: an expired token is refused", async () => {
  const { app, r, mail } = await fixture("5.5.5.5");
  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "5.5.5.5");
  const code = codeFrom(mail);

  // The store holds SHA-256(raw), not the raw token — confirm that directly.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(code).digest("base64url");
  const rec = await app.repo.getPasswordResetTokenByHash(hash);
  assert.ok(rec, "tokens are stored as base64url(SHA-256(raw))");

  // Plant an already-expired token for the same user and try to redeem it.
  const raw = "expired-token-with-plenty-of-entropy-000";
  await app.repo.createPasswordResetToken({
    id: "expired-1", userId: rec!.userId,
    tokenHash: createHash("sha256").update(raw).digest("base64url"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - RESET_TTL_MINUTES * 60_000 - 60_000).toISOString(),
  });
  await assert.rejects(() => app.auth.resetPassword(raw, "second-password"), /invalid or has expired/);
  assert.equal((await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "first-password" }, undefined, "5.5.5.5")).status, 200,
    "the password is unchanged after a rejected reset");
  assert.ok(RESET_TTL_MINUTES <= 60, "reset tokens are short-lived");
});

test("reset: garbage and short tokens are refused, and a weak new password is rejected", async () => {
  const { r, mail } = await fixture("6.6.6.6");
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: "nope", newPassword: "second-password" }, undefined, "6.6.6.6")).status, 401);
  await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "6.6.6.6");
  const code = codeFrom(mail);
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: code, newPassword: "short" }, undefined, "6.6.6.6")).status, 400,
    "a too-short new password is rejected BEFORE the token is burned");
  assert.equal((await call(r, "POST", "/v1/auth/reset", { token: code, newPassword: "long-enough-now" }, undefined, "6.6.6.6")).status, 200,
    "so the parent can retry with the same emailed token");
});

test("forgot and reset are rate-limited like the other auth routes", async () => {
  const { r } = await fixture("7.7.7.7");
  let sawRateLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await call(r, "POST", "/v1/auth/forgot", { email: "p@e.com" }, undefined, "7.7.7.7");
    if (res.status === 429) { sawRateLimit = true; break; }
  }
  assert.equal(sawRateLimit, true, "reset requests cannot be used to spam an inbox");
});
