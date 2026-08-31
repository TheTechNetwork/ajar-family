/**
 * "Until the end of the day" must mean the CHILD's day.
 *
 * The old implementation used setUTCHours(23,59,59,999), so a grant given in
 * California expired at 5pm local — the parent said "until bedtime" and the
 * child was cut off after school. In UTC+10 the same grant expired at 9am the
 * next morning, i.e. the child got most of an extra day.
 *
 * These tests pin both directions (UTC-7 and UTC+10) plus the DST boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { DomainError, durationToExpiry } from "./services.js";
import { endOfLocalDayMs, isValidTimeZone, timeZoneOffsetMs } from "./time.js";

const LA = "America/Los_Angeles";   // UTC-7 in July (PDT)
const BNE = "Australia/Brisbane";   // UTC+10 year-round, no DST

/** Wall-clock rendering of an instant in a zone, for readable assertions. */
const wall = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));

test("timeZoneOffsetMs reports real offsets in both directions", () => {
  const july = Date.parse("2025-07-15T12:00:00Z");
  assert.equal(timeZoneOffsetMs(july, LA), -7 * 3_600_000, "PDT is UTC-7");
  assert.equal(timeZoneOffsetMs(july, BNE), 10 * 3_600_000, "Brisbane is UTC+10");
  assert.equal(timeZoneOffsetMs(july, "UTC"), 0);
  const january = Date.parse("2025-01-15T12:00:00Z");
  assert.equal(timeZoneOffsetMs(january, LA), -8 * 3_600_000, "PST is UTC-8");
});

test("UNTIL_END_OF_DAY expires at the child's local midnight, not UTC midnight", () => {
  // 2025-07-15 10:00 local in Los Angeles == 17:00Z.
  const from = Date.parse("2025-07-15T17:00:00Z");

  const utc = durationToExpiry({ kind: "UNTIL_END_OF_DAY" }, "UTC", from).expiresAt!;
  const la = durationToExpiry({ kind: "UNTIL_END_OF_DAY" }, LA, from).expiresAt!;

  // The old behaviour: UTC midnight is 5pm in California.
  assert.equal(wall(utc, LA), "15/07/2025, 16:59", "UTC end-of-day is ~5pm local — the bug");
  // The fix: the last millisecond of the child's own day.
  assert.equal(la, "2025-07-16T06:59:59.999Z");
  assert.equal(wall(la, LA), "15/07/2025, 23:59", "expires at local 23:59");
  assert.ok(Date.parse(la) > Date.parse(utc), "a Californian child keeps the grant until bedtime");
});

test("UNTIL_END_OF_DAY in UTC+10 does not run into the next local day", () => {
  // 2025-07-15 20:00 Brisbane == 10:00Z the same day.
  const from = Date.parse("2025-07-15T10:00:00Z");
  const bne = durationToExpiry({ kind: "UNTIL_END_OF_DAY" }, BNE, from).expiresAt!;

  assert.equal(bne, "2025-07-15T13:59:59.999Z");
  assert.equal(wall(bne, BNE), "15/07/2025, 23:59", "expires at local 23:59, same day");

  // The old behaviour gave this child until 10am the NEXT local morning.
  const utc = durationToExpiry({ kind: "UNTIL_END_OF_DAY" }, "UTC", from).expiresAt!;
  assert.equal(wall(utc, BNE), "16/07/2025, 09:59", "UTC end-of-day leaks into the next day — the bug");
  assert.ok(Date.parse(bne) < Date.parse(utc), "the grant no longer spills into tomorrow");
});

test("the local day is correct across a DST spring-forward", () => {
  // 2025-03-09 is the US spring-forward: that local day is only 23 hours long.
  const from = Date.parse("2025-03-09T18:00:00Z"); // 11:00 PDT
  const end = new Date(endOfLocalDayMs(from, LA)).toISOString();
  assert.equal(wall(end, LA), "09/03/2025, 23:59", "still ends at local 23:59 on a 23-hour day");
});

test("other durations are unaffected by the child's zone", () => {
  const from = Date.parse("2025-07-15T17:00:00Z");
  assert.equal(durationToExpiry({ kind: "MINUTES", minutes: 30 }, LA, from).expiresAt,
    new Date(from + 30 * 60_000).toISOString());
  assert.equal(durationToExpiry({ kind: "ALWAYS" }, LA, from).standing, true);
  assert.equal(durationToExpiry({ kind: "ALWAYS" }, LA, from).expiresAt, undefined);
});

test("an unknown zone is refused at write time, and never silently applied", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("tz@example.com", "TZ");
  const fam = await app.family.createFamily("F", owner.id);

  await assert.rejects(() => app.family.addChild(fam.id, owner.id, "Kid", "Pacific Time"), /unknown IANA time zone/);
  await assert.rejects(() => app.family.addChild(fam.id, owner.id, "Kid", "Mars/Olympus"), /unknown IANA time zone/);
  assert.equal(isValidTimeZone("America/Los_Angeles"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  // ICU also accepts legacy aliases ("PST") and resolves them to the right zone,
  // so those are allowed through rather than rejected on spelling.
  assert.equal(isValidTimeZone("PST"), true);

  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  assert.equal(child.timezone, "UTC", "the default is explicit, not undefined");
  const moved = await app.family.setChildTimezone(fam.id, owner.id, child.id, LA);
  assert.equal(moved.timezone, LA);
  assert.equal((await app.repo.getChild(child.id))!.timezone, LA, "persisted");
});

test("an approval for a Californian child ends at their local midnight end-to-end", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("e2e@example.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane", LA);
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "MACOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "Mac");

  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "DOMAIN", targetValue: "khanacademy.org", url: "https://khanacademy.org/x",
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: owner.id, decision: "ALLOW",
    scope: "THIS_DOMAIN", duration: { kind: "UNTIL_END_OF_DAY" }, policy: app.policy,
  });

  const snap = await app.policy.buildSnapshot(fam.id, child.id, device.id);
  const grant = snap.temporaryRules.at(-1)!;
  assert.equal(grant.grantKind, "UNTIL_END_OF_DAY");
  assert.equal(wall(grant.expiresAt, LA).slice(-5), "23:59",
    "the grant lives until the child's local midnight, whatever time it is in UTC");
  // And it is genuinely in the future for the child (the UTC-midnight bug could
  // produce an expiry that had already passed for a UTC+10 family).
  assert.ok(Date.parse(grant.expiresAt) > Date.now());
});

/**
 * `duration` is untrusted JSON from a parent client, and TypeScript's
 * exhaustiveness checking stops at the HTTP boundary. A malformed value used to
 * fall through the switch, return undefined, and blow up in the CALLER's
 * destructure with "Cannot destructure property 'expiresAt' ... as it is
 * undefined" — an internal TypeError shown to a parent for what is just a bad
 * request. Found by sending `"duration":"FOREVER"` to the live deployment.
 */
test("durationToExpiry rejects malformed durations as BAD_REQUEST, not TypeError", () => {
  for (const bad of ["FOREVER", null, undefined, {}, { kind: "NOPE" }]) {
    assert.throws(
      () => durationToExpiry(bad as never),
      (e: unknown) => e instanceof DomainError && (e as DomainError).code === "BAD_REQUEST",
      `expected a BAD_REQUEST DomainError for ${JSON.stringify(bad)}`,
    );
  }
});

test("durationToExpiry rejects a MINUTES value that is not a positive number", () => {
  // NaN/Infinity would reach `new Date(...)` and throw RangeError on
  // toISOString(); a negative would mint a grant that expired before it began.
  for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
    assert.throws(
      () => durationToExpiry({ kind: "MINUTES", minutes } as never),
      (e: unknown) => e instanceof DomainError && (e as DomainError).code === "BAD_REQUEST",
      `expected a BAD_REQUEST DomainError for minutes=${String(minutes)}`,
    );
  }
  assert.ok(durationToExpiry({ kind: "MINUTES", minutes: 30 }).expiresAt);
});
