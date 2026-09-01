/**
 * The pages a product about other people's children has to have.
 *
 * There was no LICENSE, no privacy notice, no terms and no consent surface —
 * on a product that stores a child's first name, their time zone, and a record
 * of everything they were refused. The signup form collected an email and a
 * child's name with no policy link anywhere on it.
 *
 * And the category data's CC BY-SA attribution — a DISTRIBUTION obligation, not
 * a courtesy — lived only inside the signed filter asset, where it technically
 * travelled with the data and was visible to nobody.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest } from "./router.js";
import { CATEGORY_DATA_ATTRIBUTION } from "@ajar/shared/categories";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("the attribution the licence requires is served, from the same constant the asset carries", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const req: HttpRequest = {
    method: "GET", path: "/v1/categories/attribution", query: new URLSearchParams(),
    headers: {}, params: {}, json: async () => ({}) as never,
  };
  const res = await r.handle(req);
  assert.equal(res.status, 200, "a credit gated behind a login is not a credit");
  assert.deepEqual(res.body, CATEGORY_DATA_ATTRIBUTION);
  const body = res.body as typeof CATEGORY_DATA_ATTRIBUTION;
  assert.ok(body.sources.length > 0, "an empty credit is not one either");
  for (const s of body.sources) {
    assert.ok(s.name && s.license, `a source with no name or licence: ${JSON.stringify(s)}`);
  }
});

test("the legal page exists, covers all three, and is reachable from where a parent is", () => {
  const legal = read("web/site/legal.html");
  for (const anchor of ['id="privacy"', 'id="terms"', 'id="data"', 'id="attribution"']) {
    assert.ok(legal.includes(anchor), `legal.html is missing ${anchor}`);
  }
  // It renders the credit from the endpoint rather than retyping it — a credit
  // kept in step by hand is a credit that goes stale.
  assert.ok(legal.includes("/v1/categories/attribution"),
    "legal.html must render the attribution from the API, not a hand-copy");

  // A page nobody can reach is not a policy.
  for (const [file, where] of [
    ["web/site/index.html", "the marketing site footer"],
    ["web/site/signup.html", "the signup form, before a parent taps"],
    ["web/parent/index.html", "the console"],
  ] as const) {
    assert.ok(read(file).includes("legal.html"), `no route to the legal page from ${where}`);
  }

  // Signup is where consent is actually given.
  const signup = read("web/site/signup.html");
  assert.ok(/legal\.html#terms/.test(signup) && /legal\.html#privacy/.test(signup),
    "the signup form must link BOTH the terms and the privacy notice");
});

test("the repository carries a licence, and it says the data has its own", () => {
  const lic = read("LICENSE");
  assert.ok(/MIT License/.test(lic));
  assert.ok(/DATA_LICENSES/.test(lic),
    "the third-party data terms are not granted by this licence and must say so");
});
