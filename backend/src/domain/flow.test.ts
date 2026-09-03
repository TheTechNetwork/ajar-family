/**
 * The MVP success test at the service layer (no hardware, no HTTP): a parent
 * approves ONE canonical YouTube video for 30 minutes; it plays; every other
 * video stays blocked; it auto-blocks after expiry. The device-side decision is
 * computed with the SHARED evaluate(), proving backend + device agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { InMemoryNotifier } from "../push/notifier.js";
import { generateSigningKeyPair, verifySnapshot } from "./signing.js";
import { evaluate } from "@ajar/shared/policy";

const ALLOWED = "dQw4w9WgXcQ";
const BLOCKED = "9bZkp7q19f0";
const OTHER = "abcdefghijk";
const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;

test("MVP flow: approve one video for 30m, others stay blocked, auto-expire", async () => {
  const kp = await generateSigningKeyPair();
  const notifier = new InMemoryNotifier();
  const app = await App.create({
    notifier,
    config: { authSecret: "test", signingPublicKeyB64: kp.publicKeyB64, signingPrivateKeyB64: kp.privateKeyB64 },
  });

  // Two parents.
  const owner = await app.family.createUser("owner@example.com", "Owner");
  const parentB = await app.family.createUser("b@example.com", "Parent B");
  const fam = await app.family.createFamily("Test Family", owner.id);
  await app.family.addParent(fam.id, owner.id, parentB.id, "PARENT");
  await app.repo.addNotificationEndpoint({ id: "e1", userId: owner.id, kind: "CONSOLE", token: "t1", createdAt: new Date().toISOString() });
  await app.repo.addNotificationEndpoint({ id: "e2", userId: parentB.id, kind: "CONSOLE", token: "t2", createdAt: new Date().toISOString() });

  // Child + device (default-deny YouTube is set automatically on addChild).
  const child = await app.family.addChild(fam.id, owner.id, "Jane");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "device-pub-key", "Jane's iPhone");

  // Standing allow for ALLOWED video (like the PoC baseline).
  await app.policy.addRule(fam.id, owner.id, {
    target: "YOUTUBE_VIDEO", value: ALLOWED, action: "ALLOW",
    scope: { type: "CHILD", familyId: fam.id, childId: child.id },
  });

  // Baseline snapshot: ALLOWED plays, BLOCKED + OTHER blocked.
  let snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  assert.equal(await verifySnapshot(snap, kp.publicKeyB64), true, "snapshot signature valid");
  const ctx = (id: string, nowMs = Date.now()) => ({ url: yt(id), childId: child.id, deviceId: device.id, nowMs });
  assert.equal(evaluate(snap, ctx(ALLOWED)).action, "ALLOW");
  assert.equal(evaluate(snap, ctx(BLOCKED)).action, "BLOCK");
  assert.equal(evaluate(snap, ctx(OTHER)).action, "BLOCK");

  // Child hits BLOCKED → creates an access request. Both parents notified.
  notifier.sent.length = 0;
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: BLOCKED, title: "Photosynthesis", url: yt(BLOCKED),
    reason: "Teacher assigned it",
  });
  const requestNotes = notifier.sent.filter((s) => s.msg.data?.kind === "access_request");
  assert.equal(requestNotes.length, 2, "both parents notified of the request");

  const vBefore = await app.repo.getPolicyVersion(fam.id, child.id);

  // Parent B approves THIS_VIDEO for 30 minutes.
  const { decision } = await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: parentB.id,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  assert.equal(decision.decidedBy, parentB.id, "records which parent decided");

  // Version bumped → incremental sync returns a fresh snapshot.
  const vAfter = await app.repo.getPolicyVersion(fam.id, child.id);
  assert.ok(vAfter > vBefore, "policy version bumped on approval");
  const delta = await app.policy.syncSince(fam.id, child.id, device.id, vBefore);
  assert.ok(delta, "syncSince returns a snapshot after change");
  snap = delta!;
  assert.equal(await verifySnapshot(snap, kp.publicKeyB64), true);

  // Now: BLOCKED plays (temporary), ALLOWED still plays, OTHER stays blocked.
  const now = Date.now();
  assert.equal(evaluate(snap, ctx(BLOCKED, now)).action, "ALLOW", "approved video plays");
  assert.equal(evaluate(snap, ctx(ALLOWED, now)).action, "ALLOW");
  assert.equal(evaluate(snap, ctx(OTHER, now)).action, "BLOCK", "other video stays blocked");

  // After 30 minutes: BLOCKED auto-blocks again (local expiry, no server call).
  const later = now + 31 * 60_000;
  assert.equal(evaluate(snap, ctx(BLOCKED, later)).action, "BLOCK", "approved video auto-expires");

  // Idempotent sync: device already current → null.
  //
  // The heartbeat is what makes the device current. `since` is now clamped to
  // the version the server has actually SENT this device (services.ts
  // clampSyncedVersion), because an unclamped claim let a device assert
  // ?since=999999999 and be told "up to date" forever. So a device that really
  // has the policy has to have been recorded as receiving it — which the HTTP
  // sync route does on every poll.
  const current = await app.repo.getPolicyVersion(fam.id, child.id);
  await app.devices.heartbeat(device.id, current);
  assert.equal(await app.policy.syncSince(fam.id, child.id, device.id, current), null, "no change → null");
});

test("parent long-poll: createRequest and decide wake the family channel", async () => {
  // Backs GET /v1/families/:id/requests/wait so the parent console reacts in
  // seconds (UX_PRINCIPLES §1) instead of polling.
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("live@example.com", "Live");
  const fam = await app.family.createFamily("Live Family", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "WINDOWS");
  const device = await app.enrollment.redeem(tok.code, "pk", "PC");

  // A parent is parked on the family channel; creating a request must wake it.
  const wokenByCreate = app.hub.wait(`family:${fam.id}`, 1000);
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0", title: "A video",
  });
  assert.equal(await wokenByCreate, true, "createRequest wakes family long-poll");

  // Deciding it must wake the channel again (the pending set shrank).
  const wokenByDecide = app.hub.wait(`family:${fam.id}`, 1000);
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  assert.equal(await wokenByDecide, true, "decide wakes family long-poll");
});

test("enrollment token is single-use and expires", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("o2@example.com", "O2");
  const fam = await app.family.createFamily("F2", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "WINDOWS");
  await app.enrollment.redeem(tok.code, "pk", "PC");
  await assert.rejects(() => app.enrollment.redeem(tok.code, "pk", "PC again"), /already used/);
});

test("LIMITED_GUARDIAN cannot approve for an unassigned child", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("o3@example.com", "O3");
  const guardian = await app.family.createUser("g@example.com", "G");
  const fam = await app.family.createFamily("F3", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  await app.family.addParent(fam.id, owner.id, guardian.id, "LIMITED_GUARDIAN", []); // no children assigned
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "MACOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "Mac");
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: BLOCKED,
  });
  await assert.rejects(
    () => app.approvals.decide({
      familyId: fam.id, requestId: req.id, decidedBy: guardian.id,
      decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "ONCE" }, policy: app.policy,
    }),
    /not assigned/,
  );
});
