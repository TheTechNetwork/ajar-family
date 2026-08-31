/**
 * Local-time arithmetic for approval durations.
 *
 * "Until the end of the day" is a statement about the CHILD's day, not about
 * UTC. The previous implementation called `setUTCHours(23,59,59,999)`, so a
 * grant given in California expired at 5pm local — the child was cut off
 * mid-afternoon on a grant the parent believed lasted until bedtime, and a
 * family in UTC+10 got a grant that had already expired before it was issued.
 *
 * Everything here is computed with `Intl.DateTimeFormat`, which ships with the
 * Node 22 / Workers runtime (full ICU), so we get a real, DST-aware IANA
 * database with zero dependencies.
 */

/** True if `tz` is an IANA zone this runtime knows about. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Fall back to UTC rather than throwing deep inside an approval. */
export function safeTimeZone(tz: string | undefined | null): string {
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

const PARTS = {
  hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
} as const;

/** Wall-clock fields of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, ...PARTS }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Some zones format midnight as hour "24" under hour12:false.
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/**
 * Offset of `timeZone` from UTC, in ms, at `instant` (east of UTC is positive).
 * Derived by re-reading the zone's own wall clock — no offset table needed.
 */
export function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asIfUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The last millisecond of the calendar day that `fromMs` falls in, as seen in
 * `timeZone`. DST-correct: the offset is re-evaluated at the candidate instant,
 * so a day that gains or loses an hour still ends at local 23:59:59.999.
 */
export function endOfLocalDayMs(fromMs: number, timeZone: string): number {
  const tz = safeTimeZone(timeZone);
  const offset = timeZoneOffsetMs(fromMs, tz);
  const local = new Date(fromMs + offset);
  // Next local midnight expressed in "local fields pretending to be UTC".
  const nextMidnightLocal =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + 86_400_000;
  let end = nextMidnightLocal - offset - 1;
  const offsetAtEnd = timeZoneOffsetMs(end, tz);
  if (offsetAtEnd !== offset) end = nextMidnightLocal - offsetAtEnd - 1;
  return end;
}

/** ISO-8601 of {@link endOfLocalDayMs}. */
export function endOfLocalDayIso(fromMs: number, timeZone: string): string {
  return new Date(endOfLocalDayMs(fromMs, timeZone)).toISOString();
}
