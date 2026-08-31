/**
 * "Just once" has to mean once.
 *
 * `grantKind: "ONCE"` used to be decorative: it produced a plain 5-minute
 * temporary rule, so the child could replay the approved target as many times
 * as they liked inside the window. A parent choosing the narrowest option got
 * something materially wider than they were shown.
 *
 * It is now really single-use: the device reports consumption, the grant is
 * marked spent, the policy version bumps, and it is gone from every later
 * snapshot. (Consumption is client-attested — the 5-minute TTL is still the
 * backstop; see docs/SECURITY.md.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { evaluate } from "@ajar/shared/policy";
import { ONCE_GRANT_TTL_MS } from "./services.js";

const VIDEO = "9bZkp7q19f0";
const url = `https://www.youtube.com/watch?v=${VIDEO}`;

async function onceGrantFixture() {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("once@example.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "iPhone");
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: VIDEO, url,
  });
  const { decision } = await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "ALLOW",
    scope: "THIS_VIDEO", duration: { kind: "ONCE" }, policy: app.policy,
  });
  return { app, owner, fam, child, device, decision };
}

test("a ONCE grant is spent by the device and disappears from every later snapshot", async () => {
  const { app, fam, child, device, decision } = await onceGrantFixture();
  const ctx = (nowMs = Date.now()) => ({ url, childId: child.id, deviceId: device.id, nowMs });

  // Before consumption: the grant is live and the video plays.
  let snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  assert.equal(snap.temporaryRules.length, 1);
  assert.equal(snap.temporaryRules[0]!.grantKind, "ONCE");
  assert.equal(evaluate(snap, ctx()).action, "ALLOW");
  const versionBefore = snap.version;

  // The device reports it used the grant.
  const consumed = await app.approvals.consumeGrant(device.id, decision.producedRuleId!);
  assert.ok(consumed.consumedAt, "the grant is marked spent server-side");

  // After: gone from the snapshot, and the child is blocked again — WITHOUT
  // waiting for the TTL, which is what "once" is supposed to mean.
  snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  assert.deepEqual(snap.temporaryRules, [], "the spent grant is not shipped again");
  assert.equal(evaluate(snap, ctx()).action, "BLOCK", "the replay is blocked");
  assert.ok(snap.version > versionBefore, "the version bumped so devices re-sync");
});

test("the signed snapshot never leaks server-side consumption state", async () => {
  const { app, fam, child, device } = await onceGrantFixture();
  const snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  assert.ok(!("consumedAt" in snap.temporaryRules[0]!),
    "consumedAt is backend bookkeeping and must not appear in the shared wire shape");
});

test("a grant can only be spent once, and only by the device it applies to", async () => {
  const { app, owner, fam, device, decision } = await onceGrantFixture();
  await app.approvals.consumeGrant(device.id, decision.producedRuleId!);
  await assert.rejects(() => app.approvals.consumeGrant(device.id, decision.producedRuleId!), /already used/);

  // A different child's device in the same family cannot spend it.
  const other = await app.family.addChild(fam.id, owner.id, "Sibling");
  const tok = await app.enrollment.createToken(fam.id, owner.id, other.id, "WINDOWS");
  const otherDevice = await app.enrollment.redeem(tok.code, "pk2", "Sibling PC");
  await assert.rejects(
    () => app.approvals.consumeGrant(otherDevice.id, decision.producedRuleId!),
    /does not apply to this device|already used/,
  );
});

test("only a single-use grant is consumable — a timed grant is not silently burned", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("timed@example.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "iPhone");
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: VIDEO, url,
  });
  const { decision } = await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "ALLOW",
    scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  await assert.rejects(
    () => app.approvals.consumeGrant(device.id, decision.producedRuleId!),
    /only a single-use grant/,
  );
});

test("an unconsumed ONCE grant still expires on the TTL backstop", async () => {
  const { app, fam, child, device } = await onceGrantFixture();
  const snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  const grant = snap.temporaryRules[0]!;
  const window = Date.parse(grant.expiresAt) - Date.parse(grant.startsAt);
  assert.ok(Math.abs(window - ONCE_GRANT_TTL_MS) < 2_000, "≈5-minute backstop TTL");
  // Past the TTL the shared evaluator drops it even if the device never reported.
  const after = Date.parse(grant.expiresAt) + 1_000;
  assert.equal(evaluate(snap, { url, childId: child.id, deviceId: device.id, nowMs: after }).action, "BLOCK");
});
