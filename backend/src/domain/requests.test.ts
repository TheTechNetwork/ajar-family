/**
 * Request spam and blind decisions.
 *
 * A blocked page is not one request: the child reloads, sub-resources retry, a
 * tab restores on wake. Each of those used to mint a fresh AccessRequest AND a
 * fresh notification to every parent — so one blocked site buried the console
 * (and a parent's inbox) under identical rows the parent then had to decide one
 * by one. An identical still-PENDING ask is the same ask.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { InMemoryNotifier } from "../push/notifier.js";

async function fixture() {
  const notifier = new InMemoryNotifier();
  const app = await App.create({ notifier, config: { authSecret: "test" } });
  const owner = await app.family.createUser("dedupe@example.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  await app.repo.addNotificationEndpoint({
    id: "e1", userId: owner.id, kind: "CONSOLE", token: "t", createdAt: new Date().toISOString(),
  });
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "WINDOWS");
  const device = await app.enrollment.redeem(tok.code, "pk", "PC");
  return { app, owner, fam, child, device, notifier };
}

const requestNotes = (n: InMemoryNotifier) => n.sent.filter((s) => s.msg.data?.kind === "access_request");

test("reloading a blocked page reuses the pending request instead of spamming", async () => {
  const { app, fam, child, device, notifier } = await fixture();
  const file = () => app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "DOMAIN", targetValue: "reddit.com", url: "https://reddit.com/r/space",
  });

  const first = await file();
  notifier.sent.length = 0;
  const again = await file();
  const third = await file();

  assert.equal(again.id, first.id, "the same request is returned");
  assert.equal(third.id, first.id);
  assert.equal((await app.repo.listAccessRequests(fam.id)).length, 1, "one row, not three");
  assert.equal(requestNotes(notifier).length, 0, "no repeat notifications for the same ask");
});

test("a different target, child or device is still a separate request", async () => {
  const { app, owner, fam, child, device } = await fixture();
  const base = { familyId: fam.id, childId: child.id, deviceId: device.id } as const;
  await app.approvals.createRequest({ ...base, targetType: "DOMAIN", targetValue: "reddit.com" });
  await app.approvals.createRequest({ ...base, targetType: "DOMAIN", targetValue: "tiktok.com" });
  await app.approvals.createRequest({ ...base, targetType: "CATEGORY", targetValue: "reddit.com" });

  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "MACOS");
  const second = await app.enrollment.redeem(tok.code, "pk2", "Mac");
  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: second.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });

  assert.equal((await app.repo.listAccessRequests(fam.id)).length, 4,
    "dedupe is keyed on (child, device, targetType, targetValue) — nothing wider");
});

test("a decided request does not suppress a later ask for the same thing", async () => {
  const { app, owner, fam, child, device } = await fixture();
  const first = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: first.id, decidedBy: owner.id, decision: "ALLOW",
    scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: 15 }, policy: app.policy,
  });
  const later = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });
  assert.notEqual(later.id, first.id, "once the grant is used up the child can ask again");
  assert.equal(later.status, "PENDING");
});

test("the title a parent decides on is persisted and returned in listings", async () => {
  const { app, fam, child, device } = await fixture();
  // The first ask often arrives before the page title does.
  const bare = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: "https://example.com/a",
  });
  assert.equal(bare.title, undefined);

  // The retry carries the context; keep it rather than discarding it.
  const enriched = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: "https://example.com/a",
    title: "Photosynthesis for kids", url: "https://example.com/a", reason: "Teacher assigned it",
  });
  assert.equal(enriched.id, bare.id, "still one request");
  assert.equal(enriched.title, "Photosynthesis for kids");

  const listed = await app.repo.listAccessRequests(fam.id, "PENDING");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.title, "Photosynthesis for kids", "the parent sees what they are deciding about");
  assert.equal(listed[0]!.url, "https://example.com/a");
  assert.equal(listed[0]!.reason, "Teacher assigned it");
});

test("a first title is never overwritten by a later blank retry", async () => {
  const { app, fam, child, device } = await fixture();
  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: "https://example.com/b", title: "Real title",
  });
  const retry = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "URL", targetValue: "https://example.com/b",
  });
  assert.equal(retry.title, "Real title");
});

test("deduped re-files still wake a parent who is long-polling", async () => {
  const { app, fam, child, device } = await fixture();
  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });
  // A duplicate must NOT wake the family channel: nothing changed for the parent.
  const woken = app.hub.wait(`family:${fam.id}`, 50);
  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id, targetType: "DOMAIN", targetValue: "reddit.com",
  });
  assert.equal(await woken, false, "a duplicate is not a new event");
});
