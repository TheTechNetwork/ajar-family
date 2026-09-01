/**
 * Sign-in is TWO steps now, and this file is about the seam between them.
 *
 * The ceremonies themselves are proved elsewhere, against real captured
 * authenticator output (domain/passkeys.test.ts) and inside workerd
 * (test/passkey-workerd.test.mjs). What those cannot show is whether the HTTP
 * surface actually WITHHOLDS a session until the second step happens — which is
 * the entire value of a second factor, and is a property of routing and token
 * kinds rather than of crypto.
 *
 * So these tests seed an enrolled passkey directly and then ask the questions a
 * password-holding attacker would ask: does the password alone get me anything
 * that works? Can the half-finished token be spent anywhere else? Can a session
 * I already have be used to finish somebody's login?
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

/** An account with a passkey already on it. The credential's bytes never have to
 *  be real here: nothing in these tests verifies a signature. */
async function parentWithPasskey(app: App, email = "p@e.com", id = "cred-1") {
  const user = await app.auth.register(email, "correct-horse", "P");
  await app.repo.createWebAuthnCredential({
    id, userId: user.id, publicKeyCose: "AAAA", alg: -7, signCount: 0,
    label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });
  return user;
}

test("a password alone yields no session when a passkey is enrolled", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await parentWithPasskey(app);

  const res = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;

  assert.equal(body.mfaRequired, true);
  assert.deepEqual(body.methods, ["passkey"]);
  // THE assertion in this file. Anything token-shaped in this response that a
  // client might store and send would make the passkey optional in practice.
  assert.equal(body.accessToken, undefined, "the password step must not hand back an access token");
  assert.equal(body.refreshToken, undefined, "nor a refresh token");
  assert.ok(typeof body.mfaToken === "string");
});

test("the half-finished token opens nothing else", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await parentWithPasskey(app);

  const login = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  const mfa = (login.body as { mfaToken: string }).mfaToken;

  // A representative spread: identity, the family surface, and the routes that
  // manage the second factor itself — the last of which would let someone with
  // a password enrol their OWN passkey and complete the login honestly.
  for (const [method, path] of [
    ["GET", "/v1/me"],
    ["GET", "/v1/me/sessions"],
    ["POST", "/v1/families"],
    ["GET", "/v1/me/passkeys"],
    ["POST", "/v1/me/passkeys/options"],
  ] as const) {
    const res = await call(r, method, path, { name: "F" }, mfa);
    assert.equal(res.status, 401, `${method} ${path} accepted a half-finished sign-in`);
  }
});

test("a full session cannot be spent as the second half of a sign-in", async () => {
  // The inverse of the test above, and the reason mfa is its own token kind: if
  // the passkey routes took any bearer token, a parent's own live session on a
  // shared computer would finish a login started with their password elsewhere.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await app.auth.register("nopasskey@e.com", "correct-horse", "P");
  const session = await call(r, "POST", "/v1/auth/login", { email: "nopasskey@e.com", password: "correct-horse" });
  const access = (session.body as { accessToken: string }).accessToken;
  assert.ok(access, "an account with no passkey still signs in");
  assert.equal((session.body as { passkeyRequired: boolean }).passkeyRequired, true,
    "and is told it owes an enrolment");

  await app.repo.createWebAuthnCredential({
    id: "c", userId: user.id, publicKeyCose: "AAAA", alg: -7, signCount: 0,
    label: "k", backedUp: true, createdAt: new Date().toISOString(),
  });
  assert.equal((await call(r, "POST", "/v1/auth/passkeys/login/options", {}, access)).status, 401);
  assert.equal((await call(r, "POST", "/v1/auth/passkeys/login", { credential: {} }, access)).status, 401);
});

test("changing the password invalidates a half-finished sign-in", async () => {
  // Someone has the old password and is mid-login; the parent changes it. The
  // mfa token carries the tokenVersion, so the step they were about to complete
  // dies with everything else.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await parentWithPasskey(app);

  const login = await call(r, "POST", "/v1/auth/login", { email: "p@e.com", password: "correct-horse" });
  const mfa = (login.body as { mfaToken: string }).mfaToken;

  await app.auth.changePassword(user.id, "correct-horse", "a-better-password");

  assert.equal((await call(r, "POST", "/v1/auth/passkeys/login/options", {}, mfa)).status, 401);
});

test("the challenge route refuses an account with no passkey", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await app.auth.register("bare@e.com", "correct-horse", "P");
  // Hand-mint the mfa token this account would never legitimately receive.
  const { issueToken } = await import("../auth/tokens.js");
  const mfa = await issueToken("test", { kind: "mfa", userId: user.id, tv: user.tokenVersion }, 300);

  const res = await call(r, "POST", "/v1/auth/passkeys/login/options", {}, mfa);
  assert.equal(res.status, 400);
});

test("enrolment and listing need a real session, and the list hides the key", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await app.auth.register("q@e.com", "correct-horse", "Q");
  const login = await call(r, "POST", "/v1/auth/login", { email: "q@e.com", password: "correct-horse" });
  const access = (login.body as { accessToken: string }).accessToken;

  assert.equal((await call(r, "GET", "/v1/me/passkeys")).status, 401, "unauthenticated listing is refused");

  await app.repo.createWebAuthnCredential({
    id: "cred-9", userId: user.id, publicKeyCose: "SECRET-LOOKING-KEY", alg: -7, signCount: 4,
    label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });
  const list = await call(r, "GET", "/v1/me/passkeys", undefined, access);
  assert.equal(list.status, 200);
  const rows = list.body as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "iPhone");
  assert.equal(rows[0]!.publicKeyCose, undefined, "the stored key is not part of the public shape");
});

test("a malformed ceremony body is a 400, not a 500", async () => {
  // Everything here arrives from a browser API we do not control, and the crypto
  // sits directly behind it. The validator is what keeps a wrong shape from
  // reaching it at all.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await parentWithPasskey(app, "m@e.com", "cred-m");
  const login = await call(r, "POST", "/v1/auth/login", { email: "m@e.com", password: "correct-horse" });
  const mfa = (login.body as { mfaToken: string }).mfaToken;

  for (const body of [
    {},
    { credential: "not an object" },
    { credential: { id: "abc", rawId: "abc", type: "public-key", response: {} } },
    // Not base64url — a field that reaches the decoder as something else is
    // exactly the input a fuzzer would send.
    { credential: { id: "abc", rawId: "abc", type: "public-key",
      response: { authenticatorData: "!!!", clientDataJSON: "abc", signature: "abc" } } },
    // Wrong credential type.
    { credential: { id: "abc", rawId: "abc", type: "password",
      response: { authenticatorData: "abc", clientDataJSON: "abc", signature: "abc" } } },
  ]) {
    const res = await call(r, "POST", "/v1/auth/passkeys/login", body, mfa);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test("removing the only passkey is refused over HTTP too", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const user = await app.auth.register("z@e.com", "correct-horse", "Z");
  const login = await call(r, "POST", "/v1/auth/login", { email: "z@e.com", password: "correct-horse" });
  const access = (login.body as { accessToken: string }).accessToken;
  await app.repo.createWebAuthnCredential({
    id: "only", userId: user.id, publicKeyCose: "AAAA", alg: -7, signCount: 0,
    label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });

  const res = await call(r, "DELETE", "/v1/me/passkeys/only", undefined, access);
  assert.equal(res.status, 409);
  assert.ok(await app.repo.getWebAuthnCredential("only"), "and it is still there");
});
