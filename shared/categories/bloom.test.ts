import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBloom, bloomHas, CategoryFilters, type CategoryFilterSet } from "./bloom.js";
import { evaluate, type DevicePolicySnapshot } from "../policy/policy-model.js";

test("no false negatives: every inserted domain is found", () => {
  const domains = Array.from({ length: 5000 }, (_, i) => `site${i}.example`);
  const f = buildBloom(domains);
  for (const d of domains) assert.equal(bloomHas(f, d), true);
});

test("false-positive rate stays near the target (0.1%)", () => {
  const domains = Array.from({ length: 10000 }, (_, i) => `member${i}.example`);
  const f = buildBloom(domains, 0.001);
  let fp = 0;
  const trials = 20000;
  for (let i = 0; i < trials; i++) if (bloomHas(f, `absent${i}.test`)) fp++;
  assert.ok(fp / trials < 0.005, `FP rate ${(fp / trials * 100).toFixed(3)}% should be well under 0.5%`);
});

test("serialize → deserialize is byte-compatible (build and query agree)", () => {
  const f = buildBloom(["reddit.com", "tiktok.com"]);
  const roundTripped: CategoryFilterSet = JSON.parse(JSON.stringify({ version: 1, filters: { social: f } }));
  const prepared = new CategoryFilters(roundTripped);
  assert.deepEqual([...prepared.categoriesForHost("tiktok.com")], ["social"]);
});

test("CategoryFilters matches subdomains via host candidates", () => {
  const set: CategoryFilterSet = {
    version: 3,
    filters: {
      social: buildBloom(["reddit.com", "instagram.com", "tiktok.com"]),
      adult: buildBloom(["example-adult.test"]),
    },
  };
  const cf = new CategoryFilters(set);
  assert.equal(cf.version, 3);
  assert.deepEqual([...cf.categoriesForHost("m.old.reddit.com")], ["social"]); // subdomain
  assert.deepEqual([...cf.categoriesForHost("instagram.com")], ["social"]);
  assert.deepEqual([...cf.categoriesForHost("khanacademy.org")], []);
});

test("evaluator enforces a CATEGORY rule using ONLY the Bloom filter (no inline map)", () => {
  const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
  const snap: DevicePolicySnapshot = {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    defaults: { webDefault: "ALLOW", youTubeDefault: "ALLOW" },
    rules: [{ id: "r1", target: "CATEGORY", value: "social", action: "BLOCK", scope, createdAt: "", createdBy: "p" }],
    temporaryRules: [], issuedAt: "", signature: "",
    // NOTE: no snapshot.categories — membership comes entirely from the filter.
  };
  const categoryFilters = new CategoryFilters({ version: 1, filters: { social: buildBloom(["tiktok.com", "reddit.com"]) } });
  const ctx = (url: string) => ({ url, childId: "c", deviceId: "d", nowMs: Date.now(), categoryFilters });

  assert.equal(evaluate(snap, ctx("https://tiktok.com/@x")).action, "BLOCK");
  assert.equal(evaluate(snap, ctx("https://m.reddit.com/r/x")).action, "BLOCK"); // subdomain
  assert.equal(evaluate(snap, ctx("https://khanacademy.org/x")).action, "ALLOW"); // not in filter
});

test("a URL allow exception overrides a filter-driven category block", () => {
  const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
  const snap: DevicePolicySnapshot = {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    defaults: { webDefault: "ALLOW", youTubeDefault: "ALLOW" },
    rules: [
      { id: "r1", target: "CATEGORY", value: "social", action: "BLOCK", scope, createdAt: "", createdBy: "p" },
      { id: "r2", target: "URL", value: "https://www.instagram.com/nasa", action: "ALLOW", scope, createdAt: "", createdBy: "p" },
    ],
    temporaryRules: [], issuedAt: "", signature: "",
  };
  const categoryFilters = new CategoryFilters({ version: 1, filters: { social: buildBloom(["instagram.com"]) } });
  const ctx = (url: string) => ({ url, childId: "c", deviceId: "d", nowMs: Date.now(), categoryFilters });
  assert.equal(evaluate(snap, ctx("https://www.instagram.com/nasa")).action, "ALLOW");
  assert.equal(evaluate(snap, ctx("https://www.instagram.com/someoneelse")).action, "BLOCK");
});
