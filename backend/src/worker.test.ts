import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { assetCandidates, type Env } from "./worker.js";

/**
 * The Worker's ROUTING, not its handlers — the part that only exists on
 * Cloudflare and that a green build says nothing about.
 *
 * The case this file exists for is `blocked.*`. Workers Assets serves a matching
 * file BEFORE Worker code runs by default, and asset routing knows nothing about
 * hostnames: under that default `blocked.ajar.family/` hands out the home page,
 * past the single-purpose guard entirely. Two things stop that — the guard
 * running before the assets binding is consulted (asserted here) and
 * `run_worker_first = true` making the Worker run at all (asserted here too,
 * because it is config and no amount of correct code substitutes for it).
 */

// An assets binding that claims EVERY path exists. Anything that reaches it is
// served, so a test that still expects a refusal is testing the guard and not
// the happy accident of web/ containing no such file.
const alwaysServes: Env["ASSETS"] = {
  async fetch(request: Request) {
    return new Response(`asset for ${new URL(request.url).pathname}`, {
      status: 200, headers: { "content-type": "text/html" },
    });
  },
};
const env = (): Env => ({ AUTH_SECRET: "test-secret-0123456789abcdef", ASSETS: alwaysServes });

test("public paths map onto the uploaded web/ layout", () => {
  assert.deepEqual(assetCandidates("/"), ["/site/index.html", "/parent/index.html"]);
  assert.deepEqual(assetCandidates("/signup.html"), ["/site/signup.html", "/parent/signup.html"]);
  // The console keeps its prefix: its markup references app.js relatively.
  assert.deepEqual(assetCandidates("/parent/"), ["/parent/index.html"]);
  assert.deepEqual(assetCandidates("/parent"), ["/parent/index.html"]);
  assert.deepEqual(assetCandidates("/parent/app.js"), ["/parent/app.js"]);
  assert.deepEqual(assetCandidates("/parent/tokens.css"), ["/parent/tokens.css"]);
  // The stored prefix is not itself a public path — it maps to /site/site/...,
  // so the site is reachable at exactly one URL rather than two.
  assert.deepEqual(assetCandidates("/site/index.html"), ["/site/site/index.html", "/parent/site/index.html"]);
});

test("blocked.* still serves ONLY the block page, assets included", async () => {
  for (const path of ["/", "/signup.html", "/signup.js", "/parent/", "/parent/app.js", "/parent/tokens.css"]) {
    const res = await worker.fetch(new Request(`https://blocked.ajar.family${path}`), env());
    assert.equal(res.status, 404, `blocked.ajar.family${path} was served`);
    assert.equal((await res.json() as { code: string }).code, "NOT_FOUND");
  }
});

test("the API host serves the same paths from assets", async () => {
  for (const path of ["/", "/signup.html", "/parent/app.js"]) {
    const res = await worker.fetch(new Request(`https://api.ajar.family${path}`), env());
    assert.equal(res.status, 200, `api.ajar.family${path} did not serve`);
  }
});

test("no asset can shadow a /v1 route", async () => {
  // The binding above would answer /v1/health with HTML. The API must win.
  const res = await worker.fetch(new Request("https://api.ajar.family/v1/health"), env());
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { status: string }).status, "ok");
});

test("wrangler.toml runs the Worker before the assets, which is what enforces the guard", async () => {
  const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  // Without this the runtime serves a matching asset and never calls fetch(),
  // so every assertion above holds in Node and none of them holds in production.
  assert.match(toml, /^run_worker_first = true$/m);
  // A redirect from the asset router would expose the INTERNAL /site/... path.
  assert.match(toml, /^html_handling = "none"$/m);
  // A miss has to come back 404 so the API router still produces /blocked.
  assert.match(toml, /^not_found_handling = "none"$/m);
});
