/**
 * THE round-trip that matters: when a parent taps "Say yes", is the child
 * actually unblocked?
 *
 * Regression test for a class of silent failure where the approval succeeded,
 * the parent was told "Unlocked", and the child stayed blocked — because the
 * produced rule could never match. Two real instances:
 *   - the console hardcoded THIS_VIDEO for EVERY request, so a DOMAIN or
 *     CATEGORY block became YOUTUBE_VIDEO:<hostname>, matched against a
 *     canonical video id;
 *   - THIS_CHANNEL on a video request built YOUTUBE_CHANNEL:<video id>.
 *
 * So this test asserts end-to-end with the SHARED evaluator, for every kind of
 * block a child can hit: request -> default scope -> decide -> fresh snapshot ->
 * evaluate(original url) === ALLOW.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { defaultScopeFor, applicableScopes, mapScope, DomainError } from "./services.js";
import { evaluate } from "@ajar/shared/policy";
import type { PolicyTargetType } from "./model.js";

async function familyFixture() {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("o@example.com", "Owner");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "WINDOWS");
  const device = await app.enrollment.redeem(tok.code, "pk", "Laptop");
  return { app, owner, fam, child, device };
}

// Every shape of block a child can actually hit, with the URL they were on and
// the target their DEVICE names when it asks.
//
// The block and the ask are separate columns on purpose. A parent may block a
// whole CATEGORY; a child's device may not ASK about one, because a device may
// only name a specific thing it hit (shared/policy/target-validate.ts — a device
// that could name its own target could name "*"). So the category row blocks by
// category and asks about the site, which is what actually happens on a device.
const CASES: {
  name: string;
  block: { target: PolicyTargetType; value: string };
  ask: { targetType: PolicyTargetType; targetValue: string };
  url: string;
}[] = [
  {
    name: "YOUTUBE_VIDEO",
    block: { target: "YOUTUBE_VIDEO", value: "9bZkp7q19f0" },
    ask: { targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0" },
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
  },
  {
    name: "DOMAIN",
    block: { target: "DOMAIN", value: "reddit.com" },
    ask: { targetType: "DOMAIN", targetValue: "reddit.com" },
    url: "https://www.reddit.com/r/space",
  },
  {
    name: "CATEGORY (asked for as the site)",
    block: { target: "CATEGORY", value: "social" },
    ask: { targetType: "DOMAIN", targetValue: "tiktok.com" },
    url: "https://tiktok.com/@nasa",
  },
  {
    name: "URL",
    block: { target: "URL", value: "https://example.com/a" },
    ask: { targetType: "URL", targetValue: "https://example.com/a" },
    url: "https://example.com/a",
  },
];

for (const c of CASES) {
  test(`approving a ${c.name} block actually unblocks the child`, async () => {
    const { app, owner, fam, child, device } = await familyFixture();

    // Family blocks it (the standing rule the child hit).
    await app.policy.addRule(fam.id, owner.id, {
      target: c.block.target, value: c.block.value, action: "BLOCK",
      scope: { type: "CHILD", familyId: fam.id, childId: child.id },
    });
    const ctx = (nowMs = Date.now()) => ({ url: c.url, childId: child.id, deviceId: device.id, nowMs });

    let snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
    assert.equal(evaluate(snap, ctx()).action, "BLOCK", "blocked before approval");

    // Child asks; parent taps the single primary button (default scope).
    const req = await app.approvals.createRequest({
      familyId: fam.id, childId: child.id, deviceId: device.id,
      targetType: c.ask.targetType, targetValue: c.ask.targetValue, url: c.url,
    });
    await app.approvals.decide({
      familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "ALLOW",
      scope: defaultScopeFor(c.ask.targetType), duration: { kind: "MINUTES", minutes: 30 },
      policy: app.policy,
    });

    // The child's device re-syncs and must now be allowed through.
    snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
    const res = evaluate(snap, ctx());
    assert.equal(res.action, "ALLOW", `still blocked after approval (reason=${res.reason})`);
  });
}

test("a device cannot name its own policy target — that was an allow-the-web hole", async () => {
  const { app, fam, child, device } = await familyFixture();
  const ask = (targetType: PolicyTargetType, targetValue: string) =>
    app.approvals.createRequest({ familyId: fam.id, childId: child.id, deviceId: device.id, targetType, targetValue });

  // The exploit: a wildcard pattern under an innocuous title. The parent sees
  // the title; the rule that appears is evaluated above every standing rule.
  await assert.rejects(() => ask("URL_PATTERN", "*"), DomainError);
  // Same move, other doors.
  await assert.rejects(() => ask("CATEGORY", "adult"), DomainError);
  await assert.rejects(() => ask("DOMAIN", "com"), DomainError);
  await assert.rejects(() => ask("URL", "not a url"), DomainError);
  await assert.rejects(() => ask("YOUTUBE_VIDEO", "../../etc/passwd"), DomainError);

  // What a device legitimately hits still goes through untouched.
  await ask("DOMAIN", "tiktok.com");
  await ask("URL", "https://example.com/a?x=1");
  await ask("YOUTUBE_VIDEO", "9bZkp7q19f0");
  await ask("YOUTUBE_CHANNEL", "@SomeCreator");
});

test("approving a CATEGORY block grants only that site, not the whole category", async () => {
  const { app, owner, fam, child, device } = await familyFixture();
  await app.policy.addRule(fam.id, owner.id, {
    target: "CATEGORY", value: "social", action: "BLOCK",
    scope: { type: "CHILD", familyId: fam.id, childId: child.id },
  });
  // The device asks about the SITE it hit, not the category that closed it — a
  // device may not name a category (target-validate.ts).
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "DOMAIN", targetValue: "tiktok.com", url: "https://tiktok.com/@nasa",
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "ALLOW",
    scope: defaultScopeFor("DOMAIN"), duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  const snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  const at = (url: string) => evaluate(snap, { url, childId: child.id, deviceId: device.id, nowMs: Date.now() }).action;
  assert.equal(at("https://tiktok.com/@nasa"), "ALLOW", "the site they asked for opens");
  assert.equal(at("https://instagram.com/x"), "BLOCK", "the rest of the category stays closed");
});

test("a scope that could never match is refused, not silently granted", async () => {
  const { app, fam, child, device } = await familyFixture();
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0", url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
  });
  // THIS_CHANNEL on a video request would build YOUTUBE_CHANNEL:<video id>.
  assert.ok(!applicableScopes(req).includes("THIS_CHANNEL"));
  assert.throws(() => mapScope(req, "THIS_CHANNEL"), DomainError);
});

test('"Not now" is a time-boxed no, not a permanent block', async () => {
  const { app, owner, fam, child, device } = await familyFixture();
  const url = "https://example.com/a";
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: url, url,
  });
  // The console's "Not now" button sends exactly this.
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "BLOCK",
    scope: "THIS_REQUEST", duration: { kind: "ONCE" }, policy: app.policy,
  });
  // It must NOT have created a standing rule that outlives the moment.
  const standing = (await app.repo.listRules(fam.id)).filter((r) => r.action === "BLOCK");
  assert.equal(standing.length, 0, '"Not now" must not mint a permanent block');

  const snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  const at = (nowMs: number) =>
    evaluate(snap, { url, childId: child.id, deviceId: device.id, nowMs }).action;
  assert.equal(at(Date.now()), "BLOCK", "blocked right now");
  assert.equal(at(Date.now() + 6 * 60_000), "ALLOW", "and it lapses, rather than lasting forever");
});

test('"for good" is still permanent when the parent actually chooses it', async () => {
  const { app, owner, fam, child, device } = await familyFixture();
  const url = "https://example.com/b";
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "URL", targetValue: url, url,
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "BLOCK",
    scope: "THIS_REQUEST", duration: { kind: "ALWAYS" }, policy: app.policy,
  });
  const standing = (await app.repo.listRules(fam.id)).filter((r) => r.action === "BLOCK");
  assert.equal(standing.length, 1);
});
