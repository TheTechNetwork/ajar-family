/**
 * The categorization lookup is datastore-backed, not hardcoded: seed on boot,
 * indexed host lookup, feed replacement bumps a version, and snapshots inline
 * only the categories a policy actually enforces — sourced from the provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { evaluate } from "@ajar/shared/policy";
import { CategoryFilters } from "@ajar/shared/categories";
import { verifyCanonical } from "../domain/signing.js";

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
    gaming: ["example-gaming.test"],
  });
  assert.equal(v, before + 1);
  assert.deepEqual(await app.categories.lookup("example-social.test"), ["social"]);
  assert.deepEqual(await app.categories.lookup("news.example-gaming.test"), ["gaming"]);
  // The old seed entries are gone — this was a full replacement.
  assert.deepEqual(await app.categories.lookup("tiktok.com"), []);
  const cats = await app.categories.listCategories();
  assert.deepEqual(cats.map((c) => c.category).sort(), ["gaming", "social"]);
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

test("filter asset is signed, verifies, and enforces category membership on-device", async () => {
  const app = await App.create(cfg);
  const asset = await app.policy.categoryFilterAsset();
  assert.ok("set" in asset && asset.signature, "asset carries a signed filter set");
  // A device verifies with the public policy key before trusting it.
  assert.equal(await verifyCanonical(asset.set, asset.signature, app.signingPublicKeyB64), true);
  // ...then queries locally: a seeded social domain is a member, others are not.
  const cf = new CategoryFilters(asset.set);
  assert.deepEqual([...cf.categoriesForHost("m.tiktok.com")], ["social"]);
  assert.deepEqual([...cf.categoriesForHost("khanacademy.org")], []);
});

test("filter asset since-check returns upToDate when the device is current", async () => {
  const app = await App.create(cfg);
  const v = await app.categories.version();
  assert.deepEqual(await app.policy.categoryFilterAsset(v), { upToDate: true });
  assert.ok("set" in (await app.policy.categoryFilterAsset(v - 1)));
});

test("CNAME resolver classifies the resolved target, not just the literal host", async () => {
  // A stub resolver stands in for DNS: a vanity subdomain CNAMEs onto tiktok.com.
  const resolver = {
    async resolveChain(host: string) {
      return host === "videos.kidsite.example" ? ["edge.kidsite.example.tiktok.com", "tiktok.com"] : [];
    },
  };
  const app = await App.create({ ...cfg, cnameResolver: resolver });
  // Literal host is uncategorized...
  assert.deepEqual(await app.categories.lookup("videos.kidsite.example"), []);
  // ...but following the CNAME chain surfaces the real category.
  const cats = new Set<string>();
  const chain = await app.cnameResolver.resolveChain("videos.kidsite.example");
  for (const h of ["videos.kidsite.example", ...chain]) for (const c of await app.categories.lookup(h)) cats.add(c);
  assert.deepEqual([...cats], ["social"]);
  assert.ok(chain.includes("tiktok.com"));
});

test("identity, health, news and religion categories are refused outright", async () => {
  const app = await App.create(cfg);
  // Not "off by default" — they cannot be created. Vendors have a measured
  // history of blocking the Trevor Project and half of sexual-health sites.
  for (const slug of ["lgbtq", "sexual-health", "abortion", "news", "religion"]) {
    await assert.rejects(() => app.categories.replace({ [slug]: ["example.test"] }),
      /refusing category/, `${slug} must be refused`);
  }
  // Ordinary categories still work.
  await app.categories.replace({ social: ["example.test"] });
});

test("a safety-floor host can never be compiled into a category filter", async () => {
  const app = await App.create(cfg);
  await app.categories.replace({ social: ["988lifeline.org", "tiktok.com"] });
  await assert.rejects(() => app.categories.compileFilters(), /safety-floor/,
    "a crisis line inside a filter would let a false positive block it");
});

test("the shipped filter set covers only the categories the device enforces", async () => {
  const app = await App.create(cfg);
  const owner = await app.family.createUser("o2@example.com", "O");
  const fam = await app.family.createFamily("F2", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "WINDOWS");
  const device = await app.enrollment.redeem(tok.code, "pk", "Laptop");

  // No CATEGORY rule yet -> nothing to ship.
  let asset = await app.policy.categoryFilterAsset(-1, { familyId: fam.id, childId: child.id, deviceId: device.id });
  assert.deepEqual(Object.keys(("set" in asset) ? asset.set.filters : {}), []);

  await app.policy.addRule(fam.id, owner.id, {
    target: "CATEGORY", value: "social", action: "BLOCK",
    scope: { type: "CHILD", familyId: fam.id, childId: child.id },
  });
  asset = await app.policy.categoryFilterAsset(-1, { familyId: fam.id, childId: child.id, deviceId: device.id });
  assert.deepEqual(Object.keys(("set" in asset) ? asset.set.filters : {}), ["social"],
    "one enforced category means one shipped filter, not the whole seed");
});
