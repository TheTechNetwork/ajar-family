/**
 * SqlStore runs the same MVP flow as MemoryStore, and proves durability: data
 * written through one connection is readable through a fresh connection over the
 * same file (what MemoryStore cannot do and what Workers needs from D1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { App } from "../../app.js";
import { createNodeSqlite } from "./database.js";
import { SqlStore } from "./sql-store.js";
import { generateSigningKeyPair, verifySnapshot } from "../../domain/signing.js";
import { evaluate } from "@ajar/shared/policy";

const ALLOWED = "dQw4w9WgXcQ";
const BLOCKED = "9bZkp7q19f0";
const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;

test("SqlStore: MVP flow + durability across reconnect", async () => {
  const kp = await generateSigningKeyPair();
  const file = join(tmpdir(), `cf-${randomUUID()}.sqlite`);
  const cfg = { authSecret: "t", signingPublicKeyB64: kp.publicKeyB64, signingPrivateKeyB64: kp.privateKeyB64 };

  // First connection: run the flow.
  const store1 = await SqlStore.create(await createNodeSqlite(file));
  const app = await App.create({ repo: store1, config: cfg });

  const owner = await app.family.createUser("o@x.com", "Owner");
  const fam = await app.family.createFamily("Fam", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane");
  const tokRec = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tokRec.code, "pk", "iPhone");
  await app.policy.addRule(fam.id, owner.id, {
    target: "YOUTUBE_VIDEO", value: ALLOWED, action: "ALLOW",
    scope: { type: "CHILD", familyId: fam.id, childId: child.id },
  });
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: BLOCKED, url: yt(BLOCKED),
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });

  // Reopen the SAME file with a fresh store/app — state must survive.
  const store2 = await SqlStore.create(await createNodeSqlite(file));
  const app2 = await App.create({ repo: store2, config: cfg });

  const children = await app2.repo.listChildren(fam.id);
  assert.equal(children.length, 1, "child persisted");
  assert.equal((await app2.repo.listAccessRequests(fam.id))[0]?.status, "APPROVED", "request status persisted");

  const snap = await app2.policy.buildSnapshot(fam.id, child.id, device.id);
  assert.equal(await verifySnapshot(snap, kp.publicKeyB64), true);
  const now = Date.now();
  const ctx = (id: string, nowMs = now) => ({ url: yt(id), childId: child.id, deviceId: device.id, nowMs });
  assert.equal(evaluate(snap, ctx(BLOCKED)).action, "ALLOW", "approved video plays after reconnect");
  assert.equal(evaluate(snap, ctx(ALLOWED)).action, "ALLOW");
  assert.equal(evaluate(snap, ctx("zzzzzzzzzzz")).action, "BLOCK", "other stays blocked");
  assert.equal(evaluate(snap, ctx(BLOCKED, now + 31 * 60_000)).action, "BLOCK", "auto-expires");

  // Audit trail persisted and ordered.
  const audit = await app2.repo.listAuditEvents(fam.id);
  assert.ok(audit.some((e) => e.kind === "approval.decided"), "audit persisted");
});

/**
 * Everything the durable store had to learn for this change set: a child's time
 * zone, device heartbeat fields, single-use grant consumption, hashed password-
 * reset tokens, and the two erasure cascades. All of it must survive a reconnect
 * — MemoryStore passing is not evidence that SQLite does.
 */
test("SqlStore: timezone, heartbeat, grant consumption and reset tokens persist", async () => {
  const kp = await generateSigningKeyPair();
  const file = join(tmpdir(), `cf-${randomUUID()}.sqlite`);
  const cfg = { authSecret: "t", signingPublicKeyB64: kp.publicKeyB64, signingPrivateKeyB64: kp.privateKeyB64 };

  const app = await App.create({ repo: await SqlStore.create(await createNodeSqlite(file)), config: cfg });
  const owner = await app.auth.register("sql@x.com", "correct-horse", "Owner");
  const fam = await app.family.createFamily("Fam", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane", "America/Los_Angeles");
  const tokRec = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tokRec.code, "pk", "iPhone");
  await app.devices.heartbeat(device.id, 3);

  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: BLOCKED, title: "Photosynthesis", url: yt(BLOCKED),
  });
  const { decision } = await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "ONCE" }, policy: app.policy,
  });
  await app.auth.requestPasswordReset("sql@x.com");

  // Reopen the same file.
  const app2 = await App.create({ repo: await SqlStore.create(await createNodeSqlite(file)), config: cfg });

  assert.equal((await app2.repo.getChild(child.id))!.timezone, "America/Los_Angeles", "timezone persisted");
  const dev = (await app2.repo.getDevice(device.id))!;
  assert.equal(dev.lastSyncedVersion, 3, "heartbeat version persisted");
  assert.ok(dev.lastSeenAt, "lastSeenAt persisted");
  assert.equal((await app2.repo.listAccessRequests(fam.id))[0]!.title, "Photosynthesis", "title persisted and listed");

  // The reset token survived and is stored hashed (the raw token is not a key).
  const resets = await app2.repo.getPasswordResetTokenByHash("definitely-not-a-real-hash");
  assert.equal(resets, null);

  // Single-use consumption persists across the reconnect.
  assert.equal((await app2.repo.listTemporaryRules(fam.id)).length, 1);
  await app2.approvals.consumeGrant(device.id, decision.producedRuleId!);
  const app3 = await App.create({ repo: await SqlStore.create(await createNodeSqlite(file)), config: cfg });
  assert.equal((await app3.repo.getTemporaryRule(decision.producedRuleId!))!.consumedAt !== undefined, true,
    "the grant is still spent after reopening the database");
  assert.deepEqual((await app3.policy.buildSnapshot(fam.id, child.id, device.id)).temporaryRules, [],
    "and it is never shipped again");
  assert.equal(await app3.repo.markTemporaryRuleConsumed(decision.producedRuleId!, new Date().toISOString()), false,
    "a spent grant cannot be spent twice");
});

test("SqlStore: erasure cascades leave nothing behind", async () => {
  const kp = await generateSigningKeyPair();
  const file = join(tmpdir(), `cf-${randomUUID()}.sqlite`);
  const cfg = { authSecret: "t", signingPublicKeyB64: kp.publicKeyB64, signingPrivateKeyB64: kp.privateKeyB64 };
  const app = await App.create({ repo: await SqlStore.create(await createNodeSqlite(file)), config: cfg });

  const owner = await app.auth.register("erase@x.com", "correct-horse", "Owner");
  const guardian = await app.auth.register("g@x.com", "correct-horse", "G");
  const fam = await app.family.createFamily("Fam", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane");
  const keep = await app.family.addChild(fam.id, owner.id, "Sibling");
  await app.family.addParent(fam.id, owner.id, guardian.id, "LIMITED_GUARDIAN", [child.id, keep.id]);
  const tokRec = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tokRec.code, "pk", "iPhone");
  await app.policy.addRule(fam.id, owner.id, {
    target: "DOMAIN", value: "reddit.com", action: "BLOCK",
    scope: { type: "CHILD", familyId: fam.id, childId: child.id },
  });
  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });

  await app.family.removeChild(fam.id, owner.id, child.id);

  const app2 = await App.create({ repo: await SqlStore.create(await createNodeSqlite(file)), config: cfg });
  assert.deepEqual((await app2.repo.listChildren(fam.id)).map((c) => c.id), [keep.id], "only the sibling remains");
  assert.equal(await app2.repo.getDevice(device.id), null, "the device row is gone");
  assert.deepEqual(await app2.repo.listRules(fam.id), [], "their rules are gone");
  assert.deepEqual(await app2.repo.listAccessRequests(fam.id), [], "their requests are gone");
  assert.equal(await app2.repo.getDefaultPolicy(fam.id, child.id), null, "their defaults are gone");
  const m = (await app2.repo.getMembership(fam.id, guardian.id))!;
  assert.deepEqual(m.assignedChildIds, [keep.id], "the guardian no longer points at a deleted child");
});
