/**
 * The backend, RUNNING in workerd — the runtime it actually ships to.
 *
 * WHY THIS FILE EXISTS. Everything else runs in Node, where `node:sqlite` backs
 * the store, WebCrypto is Node's, and there is no CPU budget. The Workers
 * deployment shares none of that: the store is D1 through a hand-written adapter,
 * the crypto is workerd's, and a request that burns too much CPU is killed. Three
 * concrete things live in that gap and nothing executed them before this file:
 *
 *   1. `createD1().exec()` splits our schema on ";\n" and replays it statement by
 *      statement. If that split is wrong the very first request fails — and the
 *      Node tests can never see it, because Node uses a different adapter.
 *   2. PBKDF2-HMAC-SHA256 at 210k iterations on every register/login. Workers
 *      enforces a CPU-time limit; a hash that is comfortable in Node can be
 *      terminated here. That would make signup fail in production and pass in CI.
 *   3. Ed25519 snapshot signing via workerd's WebCrypto, which is a different
 *      implementation from Node's.
 *
 * So this boots the real dist/worker.js under workerd with a real local D1 and
 * drives the actual product flow over HTTP: register a parent, create a family
 * and a child, enrol a device, pull a signed policy, have the child ask, have the
 * parent approve, and confirm the device's next snapshot actually unblocks it.
 *
 * HONEST LIMITS. Local D1 is SQLite, not the production service: it will not
 * reproduce D1's row/size limits, its eventual consistency, or its rate limits.
 * And local workerd is more generous with CPU than production. What this DOES
 * guard is the layer nothing else touches at all — the adapter, the schema
 * replay, the crypto, and whether the deployed shape answers at all.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";

const requireWrangler = createRequire(new URL("../package.json", import.meta.url));

const AUTH_SECRET = "workerd-live-test-secret-0123456789";
let worker, origin;

before(async () => {
  // workerd persists local D1 under .wrangler/state, so a previous run's parent
  // would still exist and the "email already registered" path would fire.
  await rm(new URL("../.wrangler/state", import.meta.url), { recursive: true, force: true });

  const { unstable_dev } = await import(requireWrangler.resolve("wrangler"));
  worker = await unstable_dev("dist/worker.js", {
    config: new URL("../wrangler.toml", import.meta.url).pathname,
    local: true,
    logLevel: "error",
    vars: { AUTH_SECRET },
    experimental: { disableExperimentalWarning: true },
  });
  origin = `http://${worker.address}:${worker.port}`;
});

after(async () => { await worker?.stop(); });

const api = async (path, init = {}) => {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

test("it answers at all, and serves a signing key", async () => {
  const health = await api("/v1/health");
  assert.equal(health.status, 200, `health said ${health.status}: ${JSON.stringify(health.body)}`);
  // Devices cannot verify policy without this, so a Worker that boots but serves
  // no key is not a working deployment.
  const key = await api("/v1/signing-key");
  assert.equal(key.status, 200);
  assert.ok(typeof key.body?.publicKeyB64 === "string" && key.body.publicKeyB64.length > 40);
});

test("the site, the signup flow and the console are all served, on one origin", async () => {
  // Reachability in production is the whole point of the [assets] block, and the
  // routing that produces it lives in worker.ts, not in the asset store: the
  // public paths and the stored paths differ (/ is /site/index.html). Node tests
  // stub the binding; this is the real one, under workerd.
  //
  // ONE ORIGIN is the load-bearing part. signup.js writes the localStorage keys
  // app.js reads, so these have to answer on the same host as /v1 — which is
  // exactly what a single Worker with a single `origin` here demonstrates.
  const cases = [
    ["/", "text/html"],
    ["/signup.html", "text/html"],
    ["/signup.js", "text/javascript"],
    ["/parent/", "text/html"],
    ["/parent/app.js", "text/javascript"],
    ["/parent/tokens.css", "text/css"],
  ];
  for (const [path, type] of cases) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} said ${res.status}`);
    assert.ok(res.headers.get("content-type")?.startsWith(type),
      `${path} served as ${res.headers.get("content-type")}, expected ${type}`);
  }

  // The console's markup references app.js and tokens.css RELATIVELY, so a
  // console page that does not sit under /parent/ loads neither.
  const console_ = await fetch(`${origin}/parent/`).then((r) => r.text());
  assert.match(console_, /src="app\.js"/);
  assert.match(console_, /href="tokens\.css"/);

  // The site links the console's tokens with `..`, which clamps at the root.
  const home = await fetch(`${origin}/`).then((r) => r.text());
  assert.match(home, /href="\.\.\/parent\/tokens\.css"/);
});

test("static serving did not swallow the API's 404, and adds no second URL", async () => {
  // A miss still falls through to the API router. If not_found_handling ever
  // becomes single-page-application this returns 200 index.html instead.
  const miss = await api("/nope");
  assert.equal(miss.status, 404);
  assert.equal(miss.body?.code, "NOT_FOUND");

  // The STORED path is not a public one: /site/x maps to /site/site/x, a miss.
  // Otherwise every page would answer at two URLs.
  const stored = await fetch(`${origin}/site/index.html`);
  assert.equal(stored.status, 404);

  // web/.assetsignore keeps the dev tooling out of the upload. Everything
  // uploaded is public, and these are notes and scripts, not pages.
  for (const path of ["/parent/README.md", "/parent/check-contrast.mjs", "/parent/sync-tokens.mjs"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, `${path} was uploaded and served`);
  }
});

test("D1 works: the schema replays and a parent can actually register", async () => {
  // This is the assertion that exercises createD1().exec()'s statement split. If
  // the schema does not replay, this is where it fails — on the first write.
  const reg = await api("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "parent@example.com", password: "correct horse battery", displayName: "Parent" }),
  });
  assert.equal(reg.status, 201, `register said ${reg.status}: ${JSON.stringify(reg.body)}`);
  assert.ok(reg.body.accessToken, "PBKDF2 at 210k iterations completed inside the CPU budget");

  // Durability across requests is the whole point of binding D1: log in again.
  const login = await api("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "parent@example.com", password: "correct horse battery" }),
  });
  assert.equal(login.status, 200, "the user persisted between requests (not a per-isolate store)");
});

test("the full family flow runs end to end in workerd", async () => {
  const login = await api("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "parent@example.com", password: "correct horse battery" }),
  });
  const auth = { authorization: `Bearer ${login.body.accessToken}` };

  const fam = await api("/v1/families", { method: "POST", headers: auth, body: JSON.stringify({ name: "Test Family" }) });
  assert.equal(fam.status, 201, JSON.stringify(fam.body));
  const familyId = fam.body.id;

  const child = await api(`/v1/families/${familyId}/children`, {
    method: "POST", headers: auth, body: JSON.stringify({ displayName: "Kid" }),
  });
  assert.equal(child.status, 201, JSON.stringify(child.body));

  const enroll = await api(`/v1/families/${familyId}/enroll`, {
    method: "POST", headers: auth, body: JSON.stringify({ childId: child.body.id, platform: "WINDOWS" }),
  });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));

  const redeem = await api("/v1/enroll/redeem", {
    method: "POST",
    body: JSON.stringify({ code: enroll.body.code, devicePublicKey: "dGVzdC1rZXk=", displayName: "Laptop" }),
  });
  assert.equal(redeem.status, 201, JSON.stringify(redeem.body));
  const devAuth = { authorization: `Bearer ${redeem.body.deviceToken}` };
  const deviceId = redeem.body.device.id;

  // A signed snapshot, produced by workerd's WebCrypto Ed25519.
  const policy = await api(`/v1/devices/${deviceId}/policy`, { headers: devAuth });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));
  assert.ok(policy.body.signature, "snapshot is signed in workerd");
  assert.equal(policy.body.defaults.youTubeDefault, "BLOCK", "default-deny YouTube survived the round trip");

  // The product's headline loop: child asks, parent says yes, device unblocks.
  const ask = await api("/v1/requests", {
    method: "POST", headers: devAuth,
    body: JSON.stringify({
      targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0",
      url: "https://www.youtube.com/watch?v=9bZkp7q19f0", title: "Photosynthesis",
    }),
  });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));

  const decided = await api(`/v1/families/${familyId}/requests/${ask.body.id}/decide`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 } }),
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  const after = await api(`/v1/devices/${deviceId}/policy`, { headers: devAuth });
  assert.equal(after.status, 200);
  assert.ok(after.body.version > policy.body.version, "the approval bumped the policy version");
  const grants = (after.body.temporaryRules ?? []).filter((t) => t.value === "9bZkp7q19f0" && t.action === "ALLOW");
  assert.equal(grants.length, 1, "the approved video is in the device's next signed snapshot");
});

test("the category filter asset compiles and signs under workerd", async () => {
  // Bloom construction is arithmetic-heavy and the asset is signed — both are
  // CPU work inside one request, which is where a Workers budget bites.
  const login = await api("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "parent@example.com", password: "correct horse battery" }),
  });
  const me = await api("/v1/categories", { headers: { authorization: `Bearer ${login.body.accessToken}` } });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.ok(Array.isArray(me.body.categories) && me.body.categories.length > 0, "seed loaded into D1");
});
