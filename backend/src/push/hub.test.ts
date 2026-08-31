import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "./hub.js";
import { App } from "../app.js";
import { generateSigningKeyPair } from "../domain/signing.js";

test("EventHub: wait resolves on notify, false on timeout", async () => {
  const hub = new EventHub();
  const woken = hub.wait("k", 5000); // registers the waiter synchronously
  hub.notify("k");
  assert.equal(await woken, true);

  const timedOut = hub.wait("k", 20);
  assert.equal(await timedOut, false);
});

test("approving a request wakes the device's long-poll and yields the new snapshot", async () => {
  const kp = await generateSigningKeyPair();
  const app = await App.create({ config: { authSecret: "t", signingPublicKeyB64: kp.publicKeyB64, signingPrivateKeyB64: kp.privateKeyB64 } });
  const owner = await app.family.createUser("o@x.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "iPhone");
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0",
  });
  const vBefore = await app.repo.getPolicyVersion(fam.id, child.id);

  // The device parks on the hub (registered synchronously), then a parent approves.
  const woke = app.hub.wait(`device:${device.id}`, 3000);
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  assert.equal(await woke, true, "approval nudged the device's long-poll");

  // And the long-poll's next sync returns a snapshot carrying the approval.
  const snap = await app.policy.syncSince(fam.id, child.id, device.id, vBefore);
  assert.ok(snap, "new snapshot available after approval");
  assert.ok(snap!.temporaryRules.some((t) => t.value === "9bZkp7q19f0"), "snapshot carries the approved video");
});
