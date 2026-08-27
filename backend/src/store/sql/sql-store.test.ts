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
import { evaluate } from "@contentfilter/shared/policy";

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
