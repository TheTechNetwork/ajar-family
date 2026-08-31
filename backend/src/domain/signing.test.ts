import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPair, signSnapshot, verifySnapshot } from "./signing.js";
import type { DevicePolicySnapshot } from "@ajar/shared/policy";

function baseSnapshot(): DevicePolicySnapshot {
  return {
    version: 1, familyId: "f", childId: "c", deviceId: "d",
    defaults: { webDefault: "ALLOW", youTubeDefault: "BLOCK" },
    rules: [], temporaryRules: [], issuedAt: new Date().toISOString(), signature: "",
  };
}

test("sign then verify succeeds", async () => {
  const kp = await generateSigningKeyPair();
  const snap = baseSnapshot();
  snap.signature = await signSnapshot(snap, kp.privateKeyB64);
  assert.equal(await verifySnapshot(snap, kp.publicKeyB64), true);
});

test("tampering with the snapshot invalidates the signature", async () => {
  const kp = await generateSigningKeyPair();
  const snap = baseSnapshot();
  snap.signature = await signSnapshot(snap, kp.privateKeyB64);
  // A child edits the cached policy to allow a video.
  snap.defaults.youTubeDefault = "ALLOW";
  assert.equal(await verifySnapshot(snap, kp.publicKeyB64), false);
});

test("wrong key fails verification", async () => {
  const a = await generateSigningKeyPair();
  const b = await generateSigningKeyPair();
  const snap = baseSnapshot();
  snap.signature = await signSnapshot(snap, a.privateKeyB64);
  assert.equal(await verifySnapshot(snap, b.publicKeyB64), false);
});
