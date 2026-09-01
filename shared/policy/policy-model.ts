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
 * The backend persists these in SQLite (node:sqlite self-host / Cloudflare D1
 * on Workers) and serves signed, versioned snapshots; the reference evaluator
 * below is the semantics
 * every platform adapter must reproduce.
 */

import { normalizeYouTube, youTubePolicyKey } from "../youtube/youtube-normalize.js";
import { categoriesForHost, normalizeHost } from "../categories/category-data.js";
import type { CategoryFilters } from "../categories/bloom.js";
import { isSafetyFloorHost } from "../safety/safety-floor.js";

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
  /** Category → domain map for CATEGORY rules (e.g. { social: [...], adult: [...] }).
   *  Travels signed so every client enforces categories offline. Optional. */
  categories?: Record<string, string[]>;
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
  /** Prepared category Bloom filters the device downloaded + cached separately
   *  from the snapshot (the scalable, millions-of-domains membership source).
   *  When present, its categories are merged with the snapshot's inline map. */
  categoryFilters?: CategoryFilters;
  /** Canonical hostnames the request's host resolves to via its CNAME chain,
   *  supplied by the platform's DNS/network layer. DOMAIN and CATEGORY rules are
   *  evaluated against the request host AND every resolved name, so a first-party
   *  subdomain CNAME-cloaked onto a blocked target ("cdn.site.com → fbcdn.net")
   *  cannot bypass the block. Adapters that cannot resolve DNS (e.g. a Chrome
   *  webRequest hook) leave this empty and rely on the companion network-layer
   *  enforcer; see docs/ARCHITECTURE.md §CNAME. */
  resolvedHosts?: string[];
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
    host = normalizeHost(new URL(ctx.url).hostname);
  } catch {
    /* leave host empty */
  }
  // The request host PLUS every canonical name it resolves to (CNAME chain), so
  // DOMAIN/CATEGORY rules can't be dodged by CNAME cloaking. De-duped, normalized.
  const hosts = [...new Set(
    [host, ...(ctx.resolvedHosts ?? [])]
      .map((h) => normalizeHost(h || ""))
      .filter(Boolean),
  )];

  // Host's categories: the snapshot's inline map (small deployments / the
  // categories this policy enforces) UNION the device's cached Bloom filters
  // (the scalable path for large datasets), evaluated over the whole chain.
  const hostCats = new Set<string>();
  for (const h of hosts) {
    for (const c of categoriesForHost(snapshot.categories, h)) hostCats.add(c);
    if (ctx.categoryFilters) for (const c of ctx.categoryFilters.categoriesForHost(h)) hostCats.add(c);
  }

  // Tier 0 — the SAFETY FLOOR, above everything including device rules and
  // temporary blocks. A child must never have to ask a parent for a crisis line.
  // Deliberately not overridable and deliberately not reported. See
  // shared/safety/safety-floor.ts.
  //
  // `host` ONLY, never the resolved chain. This used to run over `hosts`, and
  // `ctx.resolvedHosts` comes from DNS on the child's own device — a Wi-Fi
  // resolver, a DoH profile, a hosts file, all of which a child sets without
  // admin rights or a jailbreak. One crafted CNAME answer naming any floor
  // domain returned ALLOW above every rule, above default-deny, for any URL. And
  // because a floor hit is never reported, the bypass left no trace for a parent
  // to see.
  //
  // The chain is an ANTI-evasion input everywhere else — it can only ADD a block,
  // so a hostile answer cannot help. The floor is the one tier where the same
  // untrusted list produces an ALLOW, so the floor does not read it. A crisis
  // line reached through a CNAME the product cannot verify is not a case worth
  // opening this hole for.
  if (isSafetyFloorHost(host)) {
    return { action: "ALLOW", reason: "safety-floor", matchedKey: `SAFETY:${host}` };
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
    const hit = matchTarget(t, ctx, yt, ytKey, hosts, hostCats);
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
          scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
          // DENY WINS A TIE. Same tier, same priority, same scope used to fall
          // through to Array#sort's stability — i.e. INSERTION ORDER, and both
          // stores return rules in insertion order — so the OLDEST rule won and
          // BLOCK had no precedence over ALLOW at all.
          //
          // What that looked like: a parent approves a site "for good", and
          // weeks later taps "Keep <site> closed for good" on a new ask. The
          // server writes the BLOCK, returns 200 with an Undo toast, the console
          // lists it — and the device keeps answering ALLOW from the day-one
          // rule, forever, with nothing in any screen to reveal it.
          //
          // A tie means the parent expressed two intents at the same
          // specificity. Between "closed" and "open" with nothing to separate
          // them, closed is the answer a parent can undo; open is the one they
          // do not find out about.
          (a.action === b.action ? 0 : a.action === "BLOCK" ? -1 : 1),
      );
    for (const r of inTier) {
      const hit = matchTarget(r, ctx, yt, ytKey, hosts, hostCats);
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
  hosts: string[],
  hostCats: Set<string>,
): string | null {
  switch (r.target) {
    case "URL":
      return normalizeExactUrl(ctx.url) === normalizeExactUrl(r.value) ? `URL:${r.value}` : null;
    case "URL_PATTERN":
      return matchesPattern(ctx.url, r.value) ? `URL_PATTERN:${r.value}` : null;
    case "YOUTUBE_VIDEO":
      return yt.videoId && yt.videoId === r.value ? `YOUTUBE_VIDEO:${r.value}` : null;
    case "YOUTUBE_PLAYLIST": {
      if (!yt.playlistId || yt.playlistId !== r.value) return null;
      // `list=` IS A QUERY PARAMETER THE CHILD TYPES. Nothing checks that the
      // video is in the playlist — nothing can, from the URL alone. So an ALLOW
      // on a playlist used to open EVERY video on YouTube: append
      // `&list=<the approved playlist>` to any watch URL and the rule matched.
      //
      // The asymmetry is deliberate, and it is the same rule the safety floor
      // now follows: an untrusted value may ADD a block, never an allow.
      //   BLOCK on a playlist  → matches the playlist page AND any video
      //                          carrying that list. Over-blocking is safe, and
      //                          a child cannot escape a block by dropping the
      //                          parameter — the video is still its own object.
      //   ALLOW on a playlist  → the playlist PAGE only. Each video in it is a
      //                          separate approval, which is what "approve one
      //                          video" means everywhere else in this product.
      if (r.action === "ALLOW" && yt.kind !== "playlist") return null;
      return `YOUTUBE_PLAYLIST:${r.value}`;
    }
    case "YOUTUBE_CHANNEL": {
      // Handles are case-insensitive in a YouTube URL, so a case-sensitive
      // compare meant one keystroke defeated a channel BLOCK (/@somecreator vs
      // /@SomeCreator) and a channel ALLOW failed on whatever casing the child's
      // link happened to carry. Channel IDs (UC...) are case-SENSITIVE and are
      // compared exactly; only the handle and the /c//user/ paths fold.
      if (yt.channelId && yt.channelId === r.value) return `YOUTUBE_CHANNEL:${r.value}`;
      if (yt.channelHandle && yt.channelHandle.toLowerCase() === r.value.toLowerCase()) {
        return `YOUTUBE_CHANNEL:${r.value}`;
      }
      return null;
    }
    case "DOMAIN":
      // Match the request host OR any CNAME-resolved canonical name, so a
      // cloaked first-party subdomain can't dodge a domain block.
      return hosts.some((h) => h === r.value || h.endsWith(`.${r.value}`)) ? `DOMAIN:${r.value}` : null;
    case "APPLICATION":
      return ctx.appId && ctx.appId === r.value ? `APPLICATION:${r.value}` : null;
    case "CATEGORY":
      // Categories are precomputed over the host + its CNAME chain; a CATEGORY
      // rule matches when any of those names is in the set.
      return hostCats.has(r.value) ? `CATEGORY:${r.value}` : null;
  }
}

/** Documented canonicalization for exact-URL comparison. Keep in lockstep with
 *  every adapter that stores/serves URL rules. */
export function normalizeExactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hostname = normalizeHost(u.hostname);
    u.hash = "";
    // CREDENTIALS IN THE AUTHORITY. `https://user@example.com/page` is the same
    // page as `https://example.com/page` and used to be a different key — so it
    // slipped a URL block, or broke an approval a parent believed they gave.
    // Two characters.
    u.username = "";
    u.password = "";
    // sort query params for stable comparison
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, ""); // drop trailing slash
    // PERCENT-ENCODING. `/%70age` is `/page`; `URL` preserves whatever encoding
    // it was given, so the two were different keys for one page. Decoded ONLY
    // where it is unambiguous: a decode that reintroduces a delimiter (`/ ? #`)
    // or produces invalid UTF-8 changes what the URL means, so those are left
    // exactly as written rather than guessed at.
    s = s.replace(/%[0-9A-Fa-f]{2}/g, (esc) => {
      let ch: string;
      try { ch = decodeURIComponent(esc); } catch { return esc; }
      return /^[A-Za-z0-9\-._~]$/.test(ch) ? ch : esc;
    });
    return s;
  } catch {
    return raw;
  }
}

/** Minimal, documented pattern support: trailing "*" prefix match only.
 *  Intentionally NOT full glob/regex — matches the constrained matching every
 *  platform primitive can honor.
 *
 *  BOTH SIDES ARE NORMALIZED, including the wildcard branch. That branch used to
 *  compare the pattern against the RAW ctx.url while the exact branch below
 *  normalized — so `https://example.com/safe/*` did not match
 *  `https://EXAMPLE.com/safe/x`, `https://www.example.com/safe/x` or
 *  `https://example.com./safe/x`. An allow-pattern silently failed to open what
 *  a parent opened, and a block-pattern was evaded by one character. */
export function matchesPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    // Normalizing a prefix through `URL` is only safe when it IS a URL; a bare
    // scheme+host prefix survives, a truncated one would not, so fall back to
    // the raw compare when it does not parse.
    let np: string;
    try { np = normalizeExactUrl(prefix); new URL(prefix); }
    catch { return url.startsWith(prefix); }
    // normalizeExactUrl drops a trailing slash, which a prefix legitimately
    // carries ("https://example.com/safe/"), so compare against the normalized
    // URL with the same treatment on both sides.
    return normalizeExactUrl(url).startsWith(np);
  }
  return normalizeExactUrl(url) === normalizeExactUrl(pattern);
}
