import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type DevicePolicySnapshot } from "./policy-model.js";

const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
const base: DevicePolicySnapshot = {
  version: 1, familyId: "f", childId: "c", deviceId: "d",
  defaults: { webDefault: "ALLOW", youTubeDefault: "BLOCK" },
  rules: [{ id: "r1", target: "YOUTUBE_VIDEO", value: "dQw4w9WgXcQ", action: "ALLOW", scope, createdAt: "", createdBy: "p" }],
  temporaryRules: [], issuedAt: "", signature: "",
};
const ctx = (url: string, nowMs = Date.now()) => ({ url, childId: "c", deviceId: "d", nowMs });

test("default-deny YouTube: allowed video plays, others blocked, web allowed", () => {
  assert.equal(evaluate(base, ctx("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).action, "ALLOW");
  assert.equal(evaluate(base, ctx("https://www.youtube.com/watch?v=9bZkp7q19f0")).action, "BLOCK");
  assert.equal(evaluate(base, ctx("https://khanacademy.org/x")).action, "ALLOW");
});

test("temporary approval plays in-window and auto-blocks after expiry", () => {
  const now = 1_000_000_000_000;
  const snap: DevicePolicySnapshot = {
    ...base,
    temporaryRules: [{
      id: "t1", target: "YOUTUBE_VIDEO", value: "9bZkp7q19f0", action: "ALLOW", scope, priority: 100,
      createdAt: "", createdBy: "p", startsAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(), requestId: "r", approvedBy: "p", grantKind: "TIMED",
    }],
  };
  assert.equal(evaluate(snap, ctx("https://www.youtube.com/watch?v=9bZkp7q19f0", now + 10_000)).action, "ALLOW");
  assert.equal(evaluate(snap, ctx("https://www.youtube.com/watch?v=9bZkp7q19f0", now + 40_000)).action, "BLOCK");
});
