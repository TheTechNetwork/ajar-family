/**
 * The associated-domains file the parent iOS/macOS app needs before it can use
 * a passkey at all.
 *
 * WHY THIS IS TESTED AND NOT JUST WRITTEN. Sign-in is password-then-passkey:
 * `/v1/auth/login` returns an `mfa` token instead of a session as soon as an
 * account has a passkey, and signup enrols one as step two of five. The app
 * finishes that step with `ASAuthorizationPlatformPublicKeyCredentialProvider`,
 * which refuses unless Apple can fetch THIS file and find the app id in it. So
 * a regression here is not a missing file — it is every parent with a passkey
 * locked out of the phone app, reported to them as an unreadable error.
 *
 * The 404 is as load-bearing as the 200 and is asserted for that reason: an
 * empty `apps` array is a positive, cached statement to Apple that no app may
 * claim this domain. "Not configured yet" has to stay retryable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

const PATH = "/.well-known/apple-app-site-association";

function get(router: ReturnType<typeof buildRouter>): Promise<HttpResponse> {
  const url = new URL(PATH, "http://localhost");
  const req: HttpRequest = {
    method: "GET", path: url.pathname, query: url.searchParams,
    headers: { "cf-connecting-ip": "1.1.1.1" },
    params: {}, json: async () => ({}) as never,
  };
  return router.handle(req);
}

const routerWith = async (appleAppIds?: string) =>
  buildRouter(await App.create({ config: { authSecret: "test", appleAppIds } }));

test("404s when no app ids are configured, rather than publishing an empty allow-list", async () => {
  const res = await get(await routerWith());
  assert.equal(res.status, 404);
  // Not a 200 with `{ webcredentials: { apps: [] } }`: Apple caches that, and it
  // says "no app may use these passkeys" rather than "ask me again later".
  assert.notEqual(JSON.stringify(res.body), JSON.stringify({ webcredentials: { apps: [] } }));
});

test("serves the configured app ids, unauthenticated", async () => {
  const res = await get(await routerWith("ABCDE12345.family.ajar.parent"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { webcredentials: { apps: ["ABCDE12345.family.ajar.parent"] } });
});

test("accepts several app ids, comma separated, and tolerates spacing", async () => {
  // One environment variable has to carry the parent app and anything later
  // (a Mac-only build, a TestFlight-only bundle id). Whitespace is tolerated
  // because the value is typed into a dashboard by a human.
  const res = await get(await routerWith(" ABCDE12345.family.ajar.parent , ABCDE12345.family.ajar.filter "));
  assert.deepEqual(res.body, {
    webcredentials: { apps: ["ABCDE12345.family.ajar.parent", "ABCDE12345.family.ajar.filter"] },
  });
});

test("an empty or whitespace-only setting is treated as unconfigured", async () => {
  // The failure this guards: a deploy that sets APPLE_APP_IDS="" to "turn it
  // off" would otherwise publish the empty allow-list the first test exists to
  // prevent.
  for (const value of ["", "   ", ",", " , "]) {
    assert.equal((await get(await routerWith(value))).status, 404, `for ${JSON.stringify(value)}`);
  }
});

test("does not claim Universal Links", async () => {
  // Claiming `applinks` would route ordinary https://ajar.family links — the
  // marketing site, the signup flow, the console — into an app that has no
  // screen for any of them.
  const res = await get(await routerWith("ABCDE12345.family.ajar.parent"));
  assert.equal((res.body as Record<string, unknown>).applinks, undefined);
});
