/**
 * Shared policy model — the platform-agnostic contract.
 *
 * The backend, the iOS content-filter control provider, the macOS Safari
 * extension, the Windows agent/extension, and (as a supplementary blocklist
 * source) the NEURLFilter dataset builder ALL consume this same model. Each
 * platform has a thin *adapter* that translates these objects into whatever the
 * OS enforcement primitive requires; the decision logic (evaluation order,
 * temporary-rule expiry, scope) is defined ONCE, here, so behavior is identical
 * across devices.
 *
 * This is a Phase-0 specification artifact: types + the reference evaluator.
 * The production backend (Phase 1) persists these in PostgreSQL and serves
 * signed, versioned snapshots; the reference evaluator below is the semantics
 * every platform adapter must reproduce.
 */

import { normalizeYouTube, youTubePolicyKey } from "../youtube/youtube-normalize.js";

// ---------------------------------------------------------------------------
// Targets, actions, scopes
// ---------------------------------------------------------------------------

export type PolicyTargetType =
  | "DOMAIN"
  | "URL" // exact URL
  | "URL_PATTERN" // prefix / simple glob (documented subset, no full regex)
  | "YOUTUBE_VIDEO" // canonical 11-char video id
  | "YOUTUBE_CHANNEL" // UC… id (or resolved handle)
  | "YOUTUBE_PLAYLIST" // PL…/UU…/… id
  | "CATEGORY" // e.g. "adult", "malware", "social"
  | "APPLICATION"; // platform app identifier (bundle id / exe / package)

export type RuleAction = "ALLOW" | "BLOCK";

export type RuleScopeType = "FAMILY" | "CHILD" | "DEVICE";

export interface RuleScope {
  type: RuleScopeType;
  /** familyId is always present; childId/deviceId narrow the scope. */
  familyId: string;
  childId?: string;
  deviceId?: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface PolicyRule {
  id: string;
  target: PolicyTargetType;
  /** For YOUTUBE_* this is the canonical id; for DOMAIN a host; for URL an
   *  absolute URL; for CATEGORY a category slug; for APPLICATION an app id. */
  value: string;
  action: RuleAction;
  scope: RuleScope;
  /** Higher wins only WITHIN the same evaluation tier; tiers dominate priority.
   *  Optional; defaults to 0. */
  priority?: number;
  createdAt: string; // ISO-8601 UTC
  createdBy: string; // parent user id (audit)
}

/**
 * Temporary rule = a time-boxed grant/deny produced by an approval decision.
 * Enforced LOCALLY against a server-signed UTC expiry so it keeps working
 * offline and expires without connectivity. Durations are tracked with a
 * monotonic clock on device (see ARCHITECTURE.md §Offline/Time) — `expiresAt`
 * is the authoritative wall-clock UTC bound; adapters must also guard against
 * clock rollback.
 */
export interface TemporaryRule extends PolicyRule {
  startsAt: string; // ISO-8601 UTC
  expiresAt: string; // ISO-8601 UTC; adapters drop the rule at/after this
  requestId: string; // AccessRequest that produced it
  approvedBy: string; // parent user id
  /** "ONCE" is satisfied by a single successful load then self-expires. */
  grantKind: "TIMED" | "ONCE" | "UNTIL_END_OF_DAY";
}

export interface DefaultPolicy {
  /** Family/child default when no rule matches. YouTube can carry its own
   *  default independent of the global default (default-deny YouTube while the
   *  rest of the web is default-allow, the product's headline posture). */
  webDefault: RuleAction;
  youTubeDefault: RuleAction;
}

/**
 * A resolved, signed snapshot handed to one device. Versioned so devices can
 * ask "what changed since vN". Signature covers the canonical serialization.
 */
export interface DevicePolicySnapshot {
  version: number;
  familyId: string;
  childId: string;
  deviceId: string;
  defaults: DefaultPolicy;
  rules: PolicyRule[];
  temporaryRules: TemporaryRule[];
  issuedAt: string; // ISO-8601 UTC
  /** Ed25519 signature (base64) over the canonical JSON of everything above. */
  signature: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvalContext {
  url: string;
  childId: string;
  deviceId: string;
  /** Monotonic "now" in UTC ms. Adapters pass a value derived from a trusted
   *  clock (server time when online; last-known + monotonic delta offline). */
  nowMs: number;
  /** Platform app identifier of the requesting process, when known. */
  appId?: string;
}

export interface EvalResult {
  action: RuleAction;
  /** Which tier decided, for auditing/debugging and block-page copy. */
  reason: string;
  matchedRuleId?: string;
  /** The canonical policy key that decided, e.g. "YOUTUBE_VIDEO:abc". */
  matchedKey?: string;
}

function scopeSpecificity(s: RuleScope): number {
  if (s.deviceId) return 3;
  if (s.childId) return 2;
  return 1; // family
}

function ruleAppliesToScope(r: PolicyRule, ctx: EvalContext): boolean {
  const s = r.scope;
  if (s.deviceId && s.deviceId !== ctx.deviceId) return false;
  if (s.childId && s.childId !== ctx.childId) return false;
  return true;
}

function isActiveTemp(t: TemporaryRule, nowMs: number): boolean {
  const start = Date.parse(t.startsAt);
  const end = Date.parse(t.expiresAt);
  return nowMs >= start && nowMs < end;
}

/**
 * The reference evaluator. Evaluation order (highest precedence first) exactly
 * matches the product's Filtering Philosophy:
 *
 *   1. Device-specific rules
 *   2. Child/user-specific rules
 *   3. Temporary approvals (active window only)
 *   4. Exact URL allow
 *   5. Exact URL block
 *   6. YouTube-specific rules (video → playlist → channel)
 *   7. Domain rules
 *   8. Category rules
 *   9. Global/default policy (YouTube default handled distinctly)
 *
 * Tiers 1–2 are expressed as scope specificity that PROMOTES a rule's tier: a
 * device- or child-scoped rule is considered before broader ones of the same
 * target. Within a tier, higher `priority` then more-specific scope wins.
 *
 * Every platform adapter MUST reproduce these semantics. Adapters that cannot
 * evaluate on-path (e.g. NEURLFilter's blocklist dataset) instead *compile* a
 * subset of this model into their primitive and document the gap.
 */
export function evaluate(
  snapshot: DevicePolicySnapshot,
  ctx: EvalContext,
): EvalResult {
  const yt = normalizeYouTube(ctx.url);
  const ytKey = yt.isYouTube ? youTubePolicyKey(yt) : null;

  let host = "";
  try {
    host = new URL(ctx.url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    /* leave host empty */
  }

  const applicable = snapshot.rules.filter((r) => ruleAppliesToScope(r, ctx));

  // Tier 3: active temporary approvals (these are the "approve one video for
  // 30 minutes" grants). Checked before standing rules so an approval overrides
  // a standing block for its window.
  const temps = snapshot.temporaryRules
    .filter((t) => ruleAppliesToScope(t, ctx) && isActiveTemp(t, ctx.nowMs))
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        scopeSpecificity(b.scope) - scopeSpecificity(a.scope),
    );
  for (const t of temps) {
    const hit = matchTarget(t, ctx, yt, ytKey, host);
    if (hit) return { action: t.action, reason: `temporary:${t.grantKind}`, matchedRuleId: t.id, matchedKey: hit };
  }

  // Standing rules, ordered by target tier then priority/scope.
  const tierOrder: PolicyTargetType[] = [
    "URL", // 4/5 exact-URL allow & block (action decides)
    "YOUTUBE_VIDEO",
    "YOUTUBE_PLAYLIST",
    "YOUTUBE_CHANNEL",
    "URL_PATTERN",
    "DOMAIN",
    "APPLICATION",
    "CATEGORY",
  ];

  for (const tier of tierOrder) {
    const inTier = applicable
      .filter((r) => r.target === tier)
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          scopeSpecificity(b.scope) - scopeSpecificity(a.scope),
      );
    for (const r of inTier) {
      const hit = matchTarget(r, ctx, yt, ytKey, host);
      if (hit) return { action: r.action, reason: `rule:${tier}`, matchedRuleId: r.id, matchedKey: hit };
    }
  }

  // Tier 9: defaults. YouTube surfaces use the YouTube default so the family can
  // run default-deny YouTube while the rest of the web is default-allow.
  if (yt.isYouTube) {
    return { action: snapshot.defaults.youTubeDefault, reason: "default:youtube" };
  }
  return { action: snapshot.defaults.webDefault, reason: "default:web" };
}

/** Returns the matched policy key if `r` targets the request, else null. */
function matchTarget(
  r: PolicyRule,
  ctx: EvalContext,
  yt: ReturnType<typeof normalizeYouTube>,
  ytKey: string | null,
  host: string,
): string | null {
  switch (r.target) {
    case "URL":
      return normalizeExactUrl(ctx.url) === normalizeExactUrl(r.value) ? `URL:${r.value}` : null;
    case "URL_PATTERN":
      return matchesPattern(ctx.url, r.value) ? `URL_PATTERN:${r.value}` : null;
    case "YOUTUBE_VIDEO":
      return yt.videoId && yt.videoId === r.value ? `YOUTUBE_VIDEO:${r.value}` : null;
    case "YOUTUBE_PLAYLIST":
      return yt.playlistId && yt.playlistId === r.value ? `YOUTUBE_PLAYLIST:${r.value}` : null;
    case "YOUTUBE_CHANNEL":
      return (yt.channelId === r.value || yt.channelHandle === r.value) ? `YOUTUBE_CHANNEL:${r.value}` : null;
    case "DOMAIN":
      return host && (host === r.value || host.endsWith(`.${r.value}`)) ? `DOMAIN:${r.value}` : null;
    case "APPLICATION":
      return ctx.appId && ctx.appId === r.value ? `APPLICATION:${r.value}` : null;
    case "CATEGORY":
      // Category membership is resolved by the platform/category service, not
      // by URL shape; the reference evaluator treats it as non-matching here
      // and documents that adapters inject category hits out-of-band.
      return null;
  }
}

/** Documented canonicalization for exact-URL comparison. Keep in lockstep with
 *  every adapter that stores/serves URL rules. */
export function normalizeExactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    u.hash = "";
    // sort query params for stable comparison
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, ""); // drop trailing slash
    return s;
  } catch {
    return raw;
  }
}

/** Minimal, documented pattern support: trailing "*" prefix match only.
 *  Intentionally NOT full glob/regex — matches the constrained matching every
 *  platform primitive can honor. */
export function matchesPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return url.startsWith(pattern.slice(0, -1));
  return normalizeExactUrl(url) === normalizeExactUrl(pattern);
}
