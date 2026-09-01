/**
 * Malformed input, through the real router.
 *
 * Request bodies used to be typed and nothing more — `req.json<{ email: string }>()`
 * is a compile-time assertion and a run-time no-op — so nothing was rejected at
 * the edge:
 *
 *  - a body that was not JSON threw out of `req.json()` and the router, correctly
 *    treating an unexpected throw as a bug, answered **500 internal error**. A
 *    client typo was reported as a server fault, and it polluted any 5xx alerting;
 *  - a well-formed body with wrong types sailed past into the domain, where some
 *    fields are checked and some are not — so `decision: 123` reached the
 *    approval path and a rule was written with an action nothing can enforce.
 *
 * Every route that reads a body now reads it through http/validate.ts. What is
 * asserted here: 400 not 500, never a crash, a message with no internals in it,
 * and nothing written when the body is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

type Router = ReturnType<typeof buildRouter>;

function call(router: Router, method: string, path: string,
              body?: unknown, token?: string, ip = "8.8.8.1"): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: { "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

/** A body that is not JSON at all: exactly what both transport adapters do when
 *  `JSON.parse` fails on the bytes that arrived. */
function callUnparseable(router: Router, method: string, path: string, token?: string, ip = "8.8.8.1"): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  return router.handle({
    method, path: url.pathname, query: url.searchParams,
    headers: { "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    params: {},
    json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); },
  });
}

async function fixture(ip = "8.8.8.1") {
  const app = await App.create({ config: { authSecret: "test", categoryAdminToken: "ops-secret" } });
  const r = buildRouter(app);
  await app.auth.register("v@e.com", "correct-horse", "V");
  const access = ((await call(r, "POST", "/v1/auth/login", { email: "v@e.com", password: "correct-horse" }, undefined, ip))
    .body as { accessToken: string }).accessToken;
  const famId = ((await call(r, "POST", "/v1/families", { name: "F" }, access, ip)).body as { id: string }).id;
  const childId = ((await call(r, "POST", `/v1/families/${famId}/children`, { displayName: "Kid" }, access, ip))
    .body as { id: string }).id;
  return { app, r, access, famId, childId, ip };
}

test("a body that is not JSON is a 400 on every route that reads one", async () => {
  const { r, access, famId, childId } = await fixture("8.8.8.2");
  const routes: Array<[string, string, boolean]> = [
    ["POST", "/v1/auth/login", false],
    ["POST", "/v1/auth/refresh", false],
    ["POST", "/v1/auth/forgot", false],
    ["POST", "/v1/auth/reset", false],
    ["POST", "/v1/auth/verify", false],
    ["POST", "/v1/auth/verify/request", false],
    ["POST", "/v1/auth/password", true],
    ["POST", "/v1/families", true],
    ["POST", `/v1/families/${famId}/parents`, true],
    ["POST", `/v1/families/${famId}/children`, true],
    ["PUT", `/v1/families/${famId}/children/${childId}`, true],
    ["PUT", `/v1/families/${famId}/children/${childId}/defaults`, true],
    ["POST", `/v1/families/${famId}/rules`, true],
    ["POST", `/v1/families/${famId}/enroll`, true],
    ["POST", "/v1/enroll/redeem", false],
    ["POST", "/v1/me/endpoints", true],
  ];
  for (const [method, path, authed] of routes) {
    const res = await callUnparseable(r, method, path, authed ? access : undefined, "8.8.8.2");
    assert.equal(res.status, 400, `${method} ${path}: unreadable JSON must be a 400, not a 500`);
    const body = JSON.stringify(res.body);
    assert.match(body, /not valid JSON/);
    assert.doesNotMatch(body, /SyntaxError|Unexpected token|position 0/, "no internals in what a parent reads");
  }
});

test("sign-up refuses a body of the wrong shape rather than acting on it", async () => {
  const { app, r } = await fixture("8.8.8.3");
  const bad: unknown[] = [
    {},                                                              // nothing at all
    { email: "p@e.com" },                                            // no password, no name
    { email: "not-an-email", password: "correct-horse", displayName: "P" },
    { email: 42, password: "correct-horse", displayName: "P" },
    { email: "p@e.com", password: { $ne: null }, displayName: "P" }, // an object where text belongs
    { email: "p@e.com", password: "correct-horse", displayName: "x".repeat(500) },
    [{ email: "p@e.com", password: "correct-horse", displayName: "P" }], // an array, not an object
    "just a string",
    null,
  ];
  for (const body of bad) {
    const res = await call(r, "POST", "/v1/auth/register", body, undefined, "8.8.8.3");
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(typeof (res.body as { error: string }).error === "string");
  }
  assert.equal(await app.repo.getUserByEmail("p@e.com"), null, "and nothing was created along the way");
});

test("an approval decision with the wrong types is refused, not written", async () => {
  // The concrete regression: `decision: 123` used to pass straight through and
  // produce a rule carrying an action no client can enforce.
  const { app, r, access, famId, childId } = await fixture("8.8.8.4");
  const code = ((await call(r, "POST", `/v1/families/${famId}/enroll`,
    { childId, platform: "WINDOWS" }, access, "8.8.8.4")).body as { code: string }).code;
  const dev = (await call(r, "POST", "/v1/enroll/redeem",
    { code, devicePublicKey: "pk", displayName: "PC" }, undefined, "8.8.8.4")).body as { device: { id: string } };
  const request = await app.approvals.createRequest({
    familyId: famId, childId, deviceId: dev.device.id, targetType: "DOMAIN", targetValue: "example.com",
  });

  for (const body of [
    { decision: 123, scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: 30 } },
    { decision: "ALLOW", scope: "EVERYTHING", duration: { kind: "MINUTES", minutes: 30 } },
    { decision: "ALLOW", scope: "THIS_DOMAIN", duration: "FOREVER" },
    { decision: "ALLOW", scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: -5 } },
    { decision: "ALLOW", scope: "THIS_DOMAIN" },
  ]) {
    const res = await call(r, "POST", `/v1/families/${famId}/requests/${request.id}/decide`, body, access, "8.8.8.4");
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await app.repo.listTemporaryRules(famId), [], "no grant was minted by a refused decision");
  assert.equal((await app.repo.getAccessRequest(request.id))!.status, "PENDING", "and the request is still open");
});

test("policy writes reject unusable values instead of storing them", async () => {
  const { app, r, access, famId, childId } = await fixture("8.8.8.5");
  const badRules: unknown[] = [
    { target: "NOT_A_TARGET", value: "example.com", action: "BLOCK", scope: { type: "FAMILY" } },
    { target: "DOMAIN", value: "example.com", action: "MAYBE", scope: { type: "FAMILY" } },
    { target: "DOMAIN", value: "example.com", action: "BLOCK", scope: { type: "PLANET" } },
    { target: "DOMAIN", value: "example.com", action: "BLOCK" },
    { target: "DOMAIN", value: ["example.com"], action: "BLOCK", scope: { type: "FAMILY" } },
    { target: "DOMAIN", value: "example.com", action: "BLOCK", scope: { type: "FAMILY" }, priority: "high" },
  ];
  for (const body of badRules) {
    assert.equal((await call(r, "POST", `/v1/families/${famId}/rules`, body, access, "8.8.8.5")).status, 400,
      `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await app.repo.listRules(famId), [], "nothing unusable reached the rule table");

  // Defaults and time zones are the same story.
  assert.equal((await call(r, "PUT", `/v1/families/${famId}/children/${childId}/defaults`,
    { webDefault: "ALLOW", youTubeDefault: "SOMETIMES" }, access, "8.8.8.5")).status, 400);
  assert.equal((await call(r, "PUT", `/v1/families/${famId}/children/${childId}`,
    { timezone: 17 }, access, "8.8.8.5")).status, 400);
  assert.equal((await call(r, "POST", "/v1/me/endpoints",
    { kind: "CARRIER_PIGEON", token: "x" }, access, "8.8.8.5")).status, 400);
});

test("a valid body still works, and unknown fields are ignored rather than refused", async () => {
  // Forward compatibility: a newer client sending a field this build does not
  // read yet must not be turned away by the validator.
  const { r, access, famId } = await fixture("8.8.8.6");
  const res = await call(r, "POST", `/v1/families/${famId}/rules`, {
    target: "DOMAIN", value: "example.com", action: "BLOCK", scope: { type: "FAMILY" },
    somethingTheFutureAdded: { nested: true },
  }, access, "8.8.8.6");
  assert.equal(res.status, 201);
});

test("the category dataset import validates its body behind the admin gate", async () => {
  const { r, access } = await fixture("8.8.8.7");
  const admin = (body: unknown) => r.handle({
    method: "PUT", path: "/v1/categories/dataset", query: new URLSearchParams(),
    headers: { "cf-connecting-ip": "8.8.8.7", authorization: `Bearer ${access}`, "x-admin-token": "ops-secret" },
    params: {}, json: async () => body as never,
  });
  for (const body of [{}, { categories: [] }, { categories: { social: "tiktok.com" } }, { categories: { social: [42] } }]) {
    assert.equal((await admin(body)).status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal((await admin({ categories: { social: ["tiktok.com"] } })).status, 200);
});
