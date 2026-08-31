/**
 * CROSS-IMPLEMENTATION CONFORMANCE VECTORS.
 *
 * The shared TypeScript evaluator is the spec; the Windows and macOS extension
 * JS and the Apple Swift are hand-written mirrors of it. Mirrors drift — and
 * drift here is invisible, because each implementation's own tests pass while
 * the platforms silently disagree about what is blocked. Two real examples this
 * corpus exists to prevent:
 *   - macOS `decide()` returned early for non-YouTube URLs, so its CATEGORY /
 *     DOMAIN / Bloom / CNAME code could never run at all;
 *   - a trailing root dot ("reddit.com.") defeated every DOMAIN and CATEGORY
 *     rule in the shared engine while the mirrors used different normalization.
 *
 * Every vector runs against EVERY implementation (see tools/conformance/) and
 * they must all agree. Adding a case here is the cheapest way to pin behaviour
 * across four codebases at once. The JSON is also emitted for the Swift port.
 */
import type { DevicePolicySnapshot, EvalContext, RuleAction } from "../policy/policy-model.js";

export interface Vector {
  name: string;
  snapshot: DevicePolicySnapshot;
  ctx: Omit<EvalContext, "categoryFilters"> & { categoryFilters?: never };
  /** Some tiers are deliberately not implemented by every adapter. */
  skipFor?: ("windows" | "macos" | "apple")[];
  expect: { action: RuleAction; reason?: string };
}

const scope = { type: "CHILD" as const, familyId: "f", childId: "c" };
const NOW = 1_700_000_000_000;

const snap = (over: Partial<DevicePolicySnapshot> = {}): DevicePolicySnapshot => ({
  version: 1, familyId: "f", childId: "c", deviceId: "d",
  defaults: { webDefault: "ALLOW", youTubeDefault: "BLOCK" },
  rules: [], temporaryRules: [], issuedAt: "", signature: "", ...over,
});
const at = (url: string, over: Partial<EvalContext> = {}) =>
  ({ url, childId: "c", deviceId: "d", nowMs: NOW, ...over }) as Vector["ctx"];

const rule = (target: string, value: string, action: RuleAction, extra: Record<string, unknown> = {}) =>
  ({ id: `r-${target}-${value}`, target, value, action, scope, createdAt: "", createdBy: "p", ...extra }) as never;

export const VECTORS: Vector[] = [
  // --- defaults -----------------------------------------------------------
  { name: "default-deny YouTube blocks an unapproved video",
    snapshot: snap(), ctx: at("https://www.youtube.com/watch?v=9bZkp7q19f0"),
    expect: { action: "BLOCK", reason: "default:youtube" } },
  { name: "default-allow web lets an ordinary site through",
    snapshot: snap(), ctx: at("https://khanacademy.org/x"),
    expect: { action: "ALLOW", reason: "default:web" } },

  // --- the headline flow ---------------------------------------------------
  { name: "an approved video plays",
    snapshot: snap({ rules: [rule("YOUTUBE_VIDEO", "dQw4w9WgXcQ", "ALLOW")] }),
    ctx: at("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), expect: { action: "ALLOW" } },
  { name: "approving one video does NOT open another",
    snapshot: snap({ rules: [rule("YOUTUBE_VIDEO", "dQw4w9WgXcQ", "ALLOW")] }),
    ctx: at("https://www.youtube.com/watch?v=9bZkp7q19f0"), expect: { action: "BLOCK" } },
  { name: "approving one video does NOT open YouTube search",
    snapshot: snap({ rules: [rule("YOUTUBE_VIDEO", "dQw4w9WgXcQ", "ALLOW")] }),
    ctx: at("https://www.youtube.com/results?search_query=x"), expect: { action: "BLOCK" } },

  // --- domain + normalization ---------------------------------------------
  { name: "DOMAIN block covers subdomains",
    snapshot: snap({ rules: [rule("DOMAIN", "reddit.com", "BLOCK")] }),
    ctx: at("https://old.reddit.com/r/x"), expect: { action: "BLOCK" } },
  { name: "trailing root dot cannot defeat a DOMAIN block",
    snapshot: snap({ rules: [rule("DOMAIN", "reddit.com", "BLOCK")] }),
    ctx: at("https://reddit.com./r/x"), expect: { action: "BLOCK" } },
  { name: "uppercase host cannot defeat a DOMAIN block",
    snapshot: snap({ rules: [rule("DOMAIN", "reddit.com", "BLOCK")] }),
    ctx: at("https://WWW.Reddit.COM/r/x"), expect: { action: "BLOCK" } },
  { name: "a lookalike suffix is NOT matched",
    snapshot: snap({ rules: [rule("DOMAIN", "reddit.com", "BLOCK")] }),
    ctx: at("https://notreddit.com/x"), expect: { action: "ALLOW" } },

  // --- categories ----------------------------------------------------------
  { name: "one CATEGORY rule blocks every domain in it",
    snapshot: snap({ rules: [rule("CATEGORY", "social", "BLOCK")], categories: { social: ["tiktok.com", "instagram.com"] } }),
    ctx: at("https://tiktok.com/@x"), expect: { action: "BLOCK" } },
  { name: "a URL allow carves an exception above a CATEGORY block",
    snapshot: snap({
      rules: [rule("CATEGORY", "social", "BLOCK"), rule("URL", "https://instagram.com/nasa", "ALLOW")],
      categories: { social: ["instagram.com"] } }),
    ctx: at("https://instagram.com/nasa"), expect: { action: "ALLOW" } },
  { name: "the rest of the category stays blocked",
    snapshot: snap({
      rules: [rule("CATEGORY", "social", "BLOCK"), rule("URL", "https://instagram.com/nasa", "ALLOW")],
      categories: { social: ["instagram.com"] } }),
    ctx: at("https://instagram.com/someoneelse"), expect: { action: "BLOCK" } },

  // --- CNAME cloaking ------------------------------------------------------
  { name: "a CNAME-cloaked alias cannot bypass a DOMAIN block",
    snapshot: snap({ rules: [rule("DOMAIN", "tracker.net", "BLOCK")] }),
    ctx: at("https://metrics.kidsite.com/p", { resolvedHosts: ["edge.cdn.tracker.net"] }),
    expect: { action: "BLOCK" } },

  // --- temporary grants ----------------------------------------------------
  { name: "an active temporary grant plays",
    snapshot: snap({ temporaryRules: [rule("YOUTUBE_VIDEO", "9bZkp7q19f0", "ALLOW", {
      startsAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
      requestId: "q", approvedBy: "p", grantKind: "TIMED", priority: 100 })] }),
    ctx: at("https://www.youtube.com/watch?v=9bZkp7q19f0"), expect: { action: "ALLOW" } },
  { name: "an expired temporary grant does not",
    snapshot: snap({ temporaryRules: [rule("YOUTUBE_VIDEO", "9bZkp7q19f0", "ALLOW", {
      startsAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString(),
      requestId: "q", approvedBy: "p", grantKind: "TIMED", priority: 100 })] }),
    ctx: at("https://www.youtube.com/watch?v=9bZkp7q19f0"), expect: { action: "BLOCK" } },

  // --- the safety floor ----------------------------------------------------
  { name: "the safety floor holds under total lockdown",
    snapshot: snap({
      defaults: { webDefault: "BLOCK", youTubeDefault: "BLOCK" },
      rules: [rule("DOMAIN", "988lifeline.org", "BLOCK", { priority: 9999 })] }),
    ctx: at("https://988lifeline.org/chat"), expect: { action: "ALLOW", reason: "safety-floor" } },
  { name: "the safety floor does not leak into ordinary browsing",
    snapshot: snap({ defaults: { webDefault: "BLOCK", youTubeDefault: "BLOCK" } }),
    ctx: at("https://example.com/"), expect: { action: "BLOCK" } },
];
