import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type DevicePolicySnapshot } from "../policy/policy-model.js";
import { DEFAULT_CATEGORY_DOMAINS, categoriesForHost } from "./category-data.js";

const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
const ctx = (url: string, nowMs = Date.now()) => ({ url, childId: "c", deviceId: "d", nowMs });

// A single CATEGORY:social BLOCK rule stands in for "block all social media".
const social: DevicePolicySnapshot = {
  version: 1, familyId: "f", childId: "c", deviceId: "d",
  defaults: { webDefault: "ALLOW", youTubeDefault: "ALLOW" },
  rules: [{ id: "r1", target: "CATEGORY", value: "social", action: "BLOCK", scope, createdAt: "", createdBy: "p" }],
  temporaryRules: [],
  categories: DEFAULT_CATEGORY_DOMAINS,
  issuedAt: "", signature: "",
};

test("categoriesForHost matches registrable root and subdomains", () => {
  assert.deepEqual([...categoriesForHost(DEFAULT_CATEGORY_DOMAINS, "tiktok.com")], ["social"]);
  assert.deepEqual([...categoriesForHost(DEFAULT_CATEGORY_DOMAINS, "m.tiktok.com")], ["social"]);
  assert.deepEqual([...categoriesForHost(DEFAULT_CATEGORY_DOMAINS, "khanacademy.org")], []);
  assert.deepEqual([...categoriesForHost(undefined, "tiktok.com")], []);
});

test("one CATEGORY:social rule blocks every social domain, leaves the rest allowed", () => {
  for (const host of ["tiktok.com", "www.instagram.com", "old.reddit.com", "x.com", "facebook.com"]) {
    assert.equal(evaluate(social, ctx(`https://${host}/feed`)).action, "BLOCK", host);
  }
  // Non-social sites are untouched by the category rule (web default ALLOW).
  assert.equal(evaluate(social, ctx("https://khanacademy.org/x")).action, "ALLOW");
  assert.equal(evaluate(social, ctx("https://wikipedia.org/wiki/Cat")).action, "ALLOW");
});

test("a narrower tier carves an exception above the category block", () => {
  // Approve ONE profile page while the rest of the category stays blocked.
  const allowOne = "https://www.instagram.com/nasa";
  const snap: DevicePolicySnapshot = {
    ...social,
    rules: [
      ...social.rules,
      { id: "r2", target: "URL", value: allowOne, action: "ALLOW", scope, createdAt: "", createdBy: "p" },
    ],
  };
  // URL tier is evaluated before CATEGORY, so the exact URL wins.
  assert.equal(evaluate(snap, ctx(allowOne)).action, "ALLOW");
  // Everything else on instagram.com is still blocked by the category rule.
  assert.equal(evaluate(snap, ctx("https://www.instagram.com/someoneelse")).action, "BLOCK");
});

test("a temporary approval overrides a standing category block for its window", () => {
  const now = 1_000_000_000_000;
  const snap: DevicePolicySnapshot = {
    ...social,
    temporaryRules: [{
      id: "t1", target: "DOMAIN", value: "reddit.com", action: "ALLOW", scope, priority: 100,
      createdAt: "", createdBy: "p", startsAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(), requestId: "r", approvedBy: "p", grantKind: "TIMED",
    }],
  };
  assert.equal(evaluate(snap, ctx("https://reddit.com/r/space", now + 10_000)).action, "ALLOW");
  assert.equal(evaluate(snap, ctx("https://reddit.com/r/space", now + 40_000)).action, "BLOCK");
});
