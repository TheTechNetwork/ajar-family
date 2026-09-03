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

test("the floor does NOT read the CNAME chain — that was a total bypass", () => {
  // This test used to assert the opposite, and the opposite was the hole.
  //
  // `resolvedHosts` is DNS from the CHILD'S OWN DEVICE: a Wi-Fi resolver, a DoH
  // profile, a hosts file — none of which needs admin rights or a jailbreak. The
  // floor returns ALLOW above every rule, above default-deny, and is deliberately
  // never reported. So one crafted CNAME answer naming any floor domain opened
  // any URL on the web and left a parent nothing to see.
  //
  // Everywhere else the chain can only ADD a block, which is why it is safe
  // there. The floor was the one tier where the same untrusted list produced an
  // ALLOW. A crisis line reached through a CNAME the product cannot verify is
  // not worth that.
  const snap: DevicePolicySnapshot = {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    defaults: { webDefault: "BLOCK", youTubeDefault: "BLOCK" },
    rules: [], temporaryRules: [], issuedAt: "", signature: "",
  };
  const res = evaluate(snap, {
    url: "https://help.example.org/", childId: "c", deviceId: "d", nowMs: Date.now(),
    resolvedHosts: ["chat.988lifeline.org"],
  });
  assert.equal(res.action, "BLOCK", "a claimed CNAME must not open the floor");
  assert.notEqual(res.reason, "safety-floor");

  // The real thing still works: the floor is about the host being VISITED.
  const direct = evaluate(snap, {
    url: "https://chat.988lifeline.org/", childId: "c", deviceId: "d", nowMs: Date.now(),
    resolvedHosts: [],
  });
  assert.equal(direct.action, "ALLOW");
  assert.equal(direct.reason, "safety-floor");
});

test("a trailing root dot cannot slip past the floor", () => {
  // A caller that forgets to normalize must not be able to defeat the floor.
  assert.equal(isSafetyFloorHost("988lifeline.org."), true);
  assert.equal(isSafetyFloorHost("WWW.ThetrevorProject.ORG."), true);
});
