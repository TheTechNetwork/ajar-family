/**
 * The categorization lookup is datastore-backed, not hardcoded: seed on boot,
 * indexed host lookup, feed replacement bumps a version, and snapshots inline
 * only the categories a policy actually enforces — sourced from the provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { evaluate } from "@ajar/shared/policy";

const cfg = { config: { authSecret: "test" } };

test("seed loads into the store; host lookup is indexed and matches subdomains", async () => {
  const app = await App.create(cfg);
  assert.ok((await app.categories.version()) >= 1, "seeded dataset has a version");
  assert.deepEqual(await app.categories.lookup("tiktok.com"), ["social"]);
  assert.deepEqual(await app.categories.lookup("m.tiktok.com"), ["social"]); // subdomain
  assert.deepEqual(await app.categories.lookup("khanacademy.org"), []);
});

test("importing a feed replaces the dataset and bumps the version (no code change)", async () => {
  const app = await App.create(cfg);
  const before = await app.categories.version();
  // A parent/ops swaps in a maintained feed — here a tiny one that reclassifies.
  const v = await app.categories.replace({
    social: ["example-social.test"],
    news: ["example-news.test"],
  });
  assert.equal(v, before + 1);
  assert.deepEqual(await app.categories.lookup("example-social.test"), ["social"]);
  assert.deepEqual(await app.categories.lookup("news.example-news.test"), ["news"]);
  // The old seed entries are gone — this was a full replacement.
  assert.deepEqual(await app.categories.lookup("tiktok.com"), []);
  const cats = await app.categories.listCategories();
  assert.deepEqual(cats.map((c) => c.category).sort(), ["news", "social"]);
});

test("buildSnapshot inlines ONLY the enforced category, from the store, and enforces it", async () => {
  const app = await App.create(cfg);
  const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
  // Two rules would exist normally via the API; construct the snapshot inputs by
  // adding a CATEGORY:social rule through the repository the service reads.
  await app.repo.createRule({
    id: "r1", target: "CATEGORY", value: "social", action: "BLOCK", scope,
    createdAt: new Date().toISOString(), createdBy: "p",
  });
  const snap = await app.policy.buildSnapshot("f", "c", "d");
  // Only the enforced category ships (not all seeded categories).
  assert.deepEqual(Object.keys(snap.categories ?? {}), ["social"]);
  assert.ok((snap.categories!.social ?? []).includes("tiktok.com"));
  // And the device-side evaluator blocks a social host using that inlined data.
  const res = evaluate(snap, { url: "https://tiktok.com/@x", childId: "c", deviceId: "d", nowMs: Date.now() });
  assert.equal(res.action, "BLOCK");
});

test("no CATEGORY rule → snapshot ships no category map (bounded)", async () => {
  const app = await App.create(cfg);
  const snap = await app.policy.buildSnapshot("f2", "c2", "d2");
  assert.equal(snap.categories, undefined);
});
