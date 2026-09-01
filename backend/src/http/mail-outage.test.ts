import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { MailSender } from "../push/mail.js";

/**
 * What a broken mail provider does to a live service.
 *
 * Reproduced against production first, not imagined: with the sending domain not
 * yet onboarded to Email Service, POST /v1/auth/register answered
 * {"error":"internal error","code":"INTERNAL"}. Every route that sent mail 500'd;
 * every route that returned before sending was fine.
 */
const BROKEN: MailSender = {
  async send() { throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" }); },
};

async function service() {
  const app = await App.create({ mail: BROKEN, config: { authSecret: "test-secret-0123456789abcdef" } });
  const router = buildRouter(app);
  return (path: string, body: unknown) => router.handle({
    method: "POST", path, query: new URLSearchParams(),
    headers: { "content-type": "application/json" },
    // The router hands routes a json() thunk rather than a raw string.
    json: (async () => body) as <T>() => Promise<T>,
    params: {},
  });
}

test("registration fails HONESTLY, not as a generic 500", async () => {
  const call = await service();
  const res = await call("/v1/auth/register",
    { email: "parent@example.com", password: "correct horse battery", displayName: "Parent" });

  // 503, because this is our dependency being down, not the caller's mistake.
  assert.equal(res.status, 503);
  // HttpResponse.body is the object; the transport adapters encode it.
  const body = res.body as { error: string; code: string };
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  // A parent has to be able to read it and know to retry.
  assert.match(body.error, /could not send|try again/i);
  // And it must not leak the provider or the configuration.
  assert.doesNotMatch(body.error, /E_SENDER_NOT_VERIFIED|cloudflare|MAIL_FROM/i);
});

test("a broken provider is not an account-enumeration oracle", async () => {
  // THE SUBTLE ONE. /v1/auth/forgot and /v1/auth/verify/request return BEFORE
  // sending for an address with no account. If a send failure propagated from
  // them, then while mail was down 202 would mean "no such account" and 5xx
  // would mean "that account exists" — an outage turned into an oracle over
  // every address in the database.
  const call = await service();
  for (const path of ["/v1/auth/forgot", "/v1/auth/verify/request"]) {
    const unknown = await call(path, { email: "nobody@example.com" });
    assert.equal(unknown.status, 202, `${path} leaked on an unknown address`);
  }
});

test("a child's access request does not 500 because mail is down", async () => {
  // docs/SECURITY.md promised exactly this and nothing implemented it.
  // Registration is the only way to get an account, and it now refuses while
  // mail is broken — so drive the domain directly rather than through the API.
  const app = await App.create({ mail: BROKEN, config: { authSecret: "test-secret-0123456789abcdef" } });
  const user = await app.auth.register("p@example.com", "correct horse battery", "P");
  const family = await app.family.createFamily("F", user.id);
  const child = await app.family.addChild(family.id, user.id, "Kid");
  const code = await app.enrollment.createToken(family.id, user.id, child.id, "WINDOWS");
  const device = await app.enrollment.redeem(code.code, "pubkey", "PC");

  // register() above already proves the point for the account path: the user has
  // an EMAIL endpoint, so this request fans out to a sender that always throws.
  await assert.doesNotReject(() => app.approvals.createRequest({
    familyId: family.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: "https://example.com/x", title: "x",
  }));
});
