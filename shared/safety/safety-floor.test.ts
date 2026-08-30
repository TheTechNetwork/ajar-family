import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type DevicePolicySnapshot } from "../policy/policy-model.js";
import { isSafetyFloorHost } from "./safety-floor.js";

const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
const ctx = (url: string) => ({ url, childId: "c", deviceId: "d", nowMs: Date.now() });

test("matches the domain and its subdomains, not lookalikes", () => {
  assert.equal(isSafetyFloorHost("988lifeline.org"), true);
  assert.equal(isSafetyFloorHost("chat.988lifeline.org"), true);
  assert.equal(isSafetyFloorHost("www.thetrevorproject.org"), true);
  assert.equal(isSafetyFloorHost("988lifeline.org.evil.com"), false);
  assert.equal(isSafetyFloorHost("example.com"), false);
});

test("the floor holds under total lockdown — no rule can close it", () => {
  const snap: DevicePolicySnapshot = {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    // Hardest possible posture: deny the entire web...
    defaults: { webDefault: "BLOCK", youTubeDefault: "BLOCK" },
    rules: [
      // ...plus an explicit device-scoped BLOCK on the crisis line itself,
      // at max priority — the most specific, highest-precedence standing rule.
      { id: "r1", target: "DOMAIN", value: "988lifeline.org", action: "BLOCK", priority: 9999,
        scope: { type: "DEVICE", familyId: "f", childId: "c", deviceId: "d" }, createdAt: "", createdBy: "p" },
      { id: "r2", target: "CATEGORY", value: "health", action: "BLOCK", scope, createdAt: "", createdBy: "p" },
    ],
    // ...plus an active temporary BLOCK, which outranks standing rules.
    temporaryRules: [{
      id: "t1", target: "DOMAIN", value: "988lifeline.org", action: "BLOCK", scope, priority: 9999,
      createdAt: "", createdBy: "p", startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      requestId: "r", approvedBy: "p", grantKind: "TIMED",
    }],
    categories: { health: ["988lifeline.org", "thetrevorproject.org"] },
    issuedAt: "", signature: "",
  };

  const res = evaluate(snap, ctx("https://988lifeline.org/chat"));
  assert.equal(res.action, "ALLOW", "a crisis line must never be blockable");
  assert.equal(res.reason, "safety-floor");

  // The floor is narrow: it does not leak into ordinary browsing.
  assert.equal(evaluate(snap, ctx("https://example.com/")).action, "BLOCK");
});

test("the floor covers CNAME-resolved names too", () => {
  const snap: DevicePolicySnapshot = {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    defaults: { webDefault: "BLOCK", youTubeDefault: "BLOCK" },
    rules: [], temporaryRules: [], issuedAt: "", signature: "",
  };
  const res = evaluate(snap, {
    url: "https://help.example.org/", childId: "c", deviceId: "d", nowMs: Date.now(),
    resolvedHosts: ["chat.988lifeline.org"],
  });
  assert.equal(res.action, "ALLOW");
});
