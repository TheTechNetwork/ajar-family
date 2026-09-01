/**
 * Signing up, through the real router.
 *
 * Two things were wrong and they were the same thing. An address was never
 * proved to belong to the person who typed it — a typo'd address silently
 * received nothing, so the parent was notified of nothing and could not reset —
 * and `POST /v1/auth/register` answered **201 for a free address and 409 for a
 * taken one**, which is a working "does this person have an Ajar account?"
 * oracle for anyone holding a list of addresses.
 *
 * Now registering ALWAYS answers 202 with one body, no account exists until the
 * link in that inbox is opened, and the only place the truth is told is the
 * mailbox itself. What is asserted here: the two branches are indistinguishable
 * end to end (status, body, AND whether the caller can then sign in), the code
 * really arrives by email, it is single-use and superseded by a newer one, it is
 * not stored in the clear, and none of it locks an existing account out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import { InMemoryMailSender } from "../push/mail.js";
import { VERIFY_TTL_MINUTES } from "../domain/services.js";
import type { HttpRequest, HttpResponse } from "./router.js";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string,
              body?: unknown, token?: string, ip = "9.9.9.1"): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: { "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

/** The confirmation code as it appears in the email we actually send. */
function codeFrom(mail: InMemoryMailSender): string {
  const found = /[A-Za-z0-9_-]{40,}/.exec(mail.sent.at(-1)!.text);
  assert.ok(found, "the email carries a high-entropy confirmation code");
  return found[0];
}

async function fixture(ip = "9.9.9.1") {
  const mail = new InMemoryMailSender();
  const app = await App.create({ mail, config: { authSecret: "test" } });
  return { app, r: buildRouter(app), mail, ip };
}

test("sign-up: 202 with an identical body whether or not the address is taken", async () => {
  const { app, r, mail } = await fixture("9.9.9.2");
  await app.auth.register("taken@e.com", "correct-horse", "Existing");

  const free = await call(r, "POST", "/v1/auth/register",
    { email: "free@e.com", password: "correct-horse", displayName: "New" }, undefined, "9.9.9.2");
  const taken = await call(r, "POST", "/v1/auth/register",
    { email: "taken@e.com", password: "attacker-guess", displayName: "New" }, undefined, "9.9.9.2");

  assert.equal(free.status, 202);
  assert.equal(taken.status, 202, "a taken address must be indistinguishable from a free one");
  assert.deepEqual(free.body, taken.body, "identical bodies too, not just identical statuses");

  // Both branches send exactly one message, and with the SAME subject: the mail
  // provider can read subject lines, and two subjects would hand it the answer.
  assert.equal(mail.sent.length, 2);
  assert.equal(mail.sent[0]!.subject, mail.sent[1]!.subject);
  assert.equal(mail.sent[0]!.to, "free@e.com");
  assert.equal(mail.sent[1]!.to, "taken@e.com");
  assert.match(mail.sent[1]!.text, /already has one/, "only the owner's inbox is told");
  assert.doesNotMatch(mail.sent[1]!.text, /[A-Za-z0-9_-]{40,}/, "and it carries no code to redeem");
});

test("sign-up cannot be turned into an oracle by signing in afterwards", async () => {
  // The obvious follow-up attack: register the victim's address with a password
  // of your choosing, then try to log in with it. Succeeding would mean the
  // address was free — so registering must create NOTHING until the inbox
  // answers, and it must not disturb the account that is already there.
  const { app, r } = await fixture("9.9.9.3");
  await app.auth.register("victim@e.com", "the-real-password", "Victim");

  for (const email of ["victim@e.com", "nobody@e.com"]) {
    await call(r, "POST", "/v1/auth/register",
      { email, password: "attacker-guess", displayName: "A" }, undefined, "9.9.9.3");
    const login = await call(r, "POST", "/v1/auth/login",
      { email, password: "attacker-guess" }, undefined, "9.9.9.3");
    assert.equal(login.status, 401, `${email}: signing up must not mint a usable password`);
  }
  assert.equal((await call(r, "POST", "/v1/auth/login",
    { email: "victim@e.com", password: "the-real-password" }, undefined, "9.9.9.3")).status, 200,
    "and the real account is untouched");
});

test("the emailed code creates the account, signs the parent in, and marks them verified", async () => {
  const { app, r, mail } = await fixture("9.9.9.4");
  const reg = await call(r, "POST", "/v1/auth/register",
    { email: "new@e.com", password: "correct-horse", displayName: "New" }, undefined, "9.9.9.4");
  assert.equal(reg.status, 202);
  assert.equal(await app.repo.getUserByEmail("new@e.com"), null, "no account exists until the inbox answers");

  const code = codeFrom(mail);
  const done = await call(r, "POST", "/v1/auth/verify", { token: code }, undefined, "9.9.9.4");
  assert.equal(done.status, 201);
  const tokens = done.body as { accessToken: string; refreshToken: string };
  assert.ok(tokens.accessToken && tokens.refreshToken, "the parent is signed straight in");

  const me = (await call(r, "GET", "/v1/me", undefined, tokens.accessToken, "9.9.9.4")).body as
    { email: string; emailVerified: boolean; emailVerifiedAt?: string };
  assert.equal(me.email, "new@e.com");
  assert.equal(me.emailVerified, true, "/v1/me reports the address as confirmed");
  assert.ok(me.emailVerifiedAt);

  // The password they chose at sign-up is the one that works afterwards.
  assert.equal((await call(r, "POST", "/v1/auth/login",
    { email: "new@e.com", password: "correct-horse" }, undefined, "9.9.9.4")).status, 200);

  // The raw code is not what we stored — only its SHA-256 is.
  const { createHash } = await import("node:crypto");
  assert.equal(await app.repo.getPendingRegistrationByHash(code), null,
    "the raw code is not a key into the store");
  assert.ok(await app.repo.getPendingRegistrationByHash(createHash("sha256").update(code).digest("base64url")),
    "the stored row is keyed by base64url(SHA-256(raw))");
});

test("a confirmation code is single-use and a newer one supersedes it", async () => {
  const { r, mail } = await fixture("9.9.9.5");
  await call(r, "POST", "/v1/auth/register",
    { email: "once@e.com", password: "correct-horse", displayName: "O" }, undefined, "9.9.9.5");
  const first = codeFrom(mail);
  await call(r, "POST", "/v1/auth/register",
    { email: "once@e.com", password: "correct-horse", displayName: "O" }, undefined, "9.9.9.5");
  const second = codeFrom(mail);
  assert.notEqual(first, second);

  assert.equal((await call(r, "POST", "/v1/auth/verify", { token: first }, undefined, "9.9.9.5")).status, 401,
    "the superseded code no longer works");
  assert.equal((await call(r, "POST", "/v1/auth/verify", { token: second }, undefined, "9.9.9.5")).status, 201);
  assert.equal((await call(r, "POST", "/v1/auth/verify", { token: second }, undefined, "9.9.9.5")).status, 401,
    "and a used code cannot be replayed");
  assert.equal((await call(r, "POST", "/v1/auth/verify", { token: "nope" }, undefined, "9.9.9.5")).status, 401,
    "garbage is refused the same way");
});

test("an expired confirmation code is refused and leaves no account behind", async () => {
  const { app, r } = await fixture("9.9.9.9");
  const { createHash } = await import("node:crypto");
  const raw = "expired-code-with-plenty-of-entropy-0000";
  await app.repo.createPendingRegistration({
    id: "expired-1", email: "late@e.com", displayName: "L",
    passwordHash: (await app.repo.getUserByEmail("nobody@e.com"))?.passwordHash ?? "unused",
    tokenHash: createHash("sha256").update(raw).digest("base64url"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - VERIFY_TTL_MINUTES * 60_000 - 60_000).toISOString(),
  });
  assert.equal((await call(r, "POST", "/v1/auth/verify", { token: raw }, undefined, "9.9.9.9")).status, 401);
  assert.equal(await app.repo.getUserByEmail("late@e.com"), null, "an expired sign-up never becomes an account");
  assert.ok(VERIFY_TTL_MINUTES <= 60, "confirmation codes are short-lived — they travel in clear text");
});

test("an existing unverified parent keeps every capability and can confirm later", async () => {
  // The alpha's accounts are all unverified and must stay fully usable —
  // verification is reported, never enforced. This is the additive claim.
  const { app, r, mail } = await fixture("9.9.9.6");
  await app.auth.register("alpha@e.com", "correct-horse", "Alpha");
  const access = ((await call(r, "POST", "/v1/auth/login",
    { email: "alpha@e.com", password: "correct-horse" }, undefined, "9.9.9.6")).body as { accessToken: string }).accessToken;

  const me = (await call(r, "GET", "/v1/me", undefined, access, "9.9.9.6")).body as { emailVerified: boolean };
  assert.equal(me.emailVerified, false, "an alpha account reads as unconfirmed");

  const fam = await call(r, "POST", "/v1/families", { name: "F" }, access, "9.9.9.6");
  assert.equal(fam.status, 201, "and can still do the whole job");
  const famId = (fam.body as { id: string }).id;
  const kid = await call(r, "POST", `/v1/families/${famId}/children`, { displayName: "Kid" }, access, "9.9.9.6");
  assert.equal(kid.status, 201);
  assert.equal((await call(r, "POST", `/v1/families/${famId}/rules`, {
    target: "DOMAIN", value: "example.com", action: "BLOCK", scope: { type: "FAMILY" },
  }, access, "9.9.9.6")).status, 201);

  // They can confirm whenever they like, and it changes nothing but the flag.
  const asked = await call(r, "POST", "/v1/auth/verify/request", { email: "alpha@e.com" }, undefined, "9.9.9.6");
  assert.equal(asked.status, 202);
  const confirmed = await call(r, "POST", "/v1/auth/verify", { token: codeFrom(mail) }, undefined, "9.9.9.6");
  assert.equal(confirmed.status, 200, "confirming an existing account returns no new session");
  const after = (await call(r, "GET", "/v1/me", undefined, access, "9.9.9.6")).body as { emailVerified: boolean };
  assert.equal(after.emailVerified, true);
  assert.equal((await call(r, "GET", `/v1/families/${famId}/children`, undefined, access, "9.9.9.6")).status, 200,
    "the session they already had is untouched");
});

test("re-sending a confirmation is 202 for an unknown address too, and sends nothing", async () => {
  const { app, r, mail } = await fixture("9.9.9.7");
  await app.auth.register("known@e.com", "correct-horse", "K");
  const known = await call(r, "POST", "/v1/auth/verify/request", { email: "known@e.com" }, undefined, "9.9.9.7");
  const unknown = await call(r, "POST", "/v1/auth/verify/request", { email: "nobody@e.com" }, undefined, "9.9.9.7");
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(mail.sent.length, 1, "only the real account got an email");
  assert.equal(mail.sent[0]!.to, "known@e.com");
});

test("sign-up is rate-limited like the other auth routes", async () => {
  const { r } = await fixture("9.9.9.8");
  let sawRateLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await call(r, "POST", "/v1/auth/register",
      { email: `flood${i}@e.com`, password: "correct-horse", displayName: "F" }, undefined, "9.9.9.8");
    if (res.status === 429) { sawRateLimit = true; break; }
  }
  assert.equal(sawRateLimit, true, "sign-up cannot be used to flood inboxes");
});
