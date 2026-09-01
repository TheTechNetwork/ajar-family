/**
 * background.js — MV3 service worker for the macOS Safari Web Extension (PoC B).
 *
 * Responsibilities:
 *   1. Hold the synced, signed DevicePolicySnapshot (delivered by the native
 *      messaging host / child agent; cached in browser.storage).
 *   2. On each navigation (webNavigation.onBeforeNavigate) AND on each in-page
 *      SPA route change (message from content.js), normalize the URL to a
 *      canonical YouTube object and evaluate it against the shared policy model.
 *   3. Redirect BLOCKED navigations to blocked.html?u=<encoded original URL>.
 *
 * >>> PARITY: the evaluate() below MUST reproduce the semantics of the reference
 * evaluator in `shared/policy/policy-model.ts` (evaluation order, temporary-rule
 * expiry, YouTube default). The TypeScript is the authoritative spec (ADR-008);
 * this is a trimmed adapter that honors the tiers relevant to the Safari surface
 * (URL / YOUTUBE_* / DOMAIN / defaults). Keep it in lockstep. <<<
 *
 * ABSOLUTE RULE (ADR-004): never block Safari to gain enforcement. We only
 * redirect specific blocked YouTube navigations to our own block page; Safari
 * and all non-YouTube browsing stay fully functional.
 */

import { isExclusiveMediaHost, isPlaybackSupportHost, normalizeYouTube, youTubePolicyKey } from "./youtube-normalize.js";
import { adoptSigningKeyIfUnset, getConfig, getVerifyingKey, startPolicySync, startCategoryFilterSync, postAccessRequest, consumeGrant, getAnswers } from "./backend-client.js";
import { verifySnapshotSignature, verifyCanonicalSignature } from "./policy-verify.js";
import { makeResolver } from "./cname-resolve.js";

// On-device CNAME resolver (anti-cloaking); async + cached, read synchronously.
const CNAME = makeResolver();

const STORAGE_KEY = "devicePolicySnapshot";
const BLOCKED_PAGE = "blocked.html";

/** "Has this device ever been enrolled?" — mirrors PolicyStore.isProvisioned.
 *  It is what separates a browser this product was never set up on (allow: we
 *  claim to filter nothing) from one that was set up and has since lost its
 *  policy (block: something is wrong and the child must not profit from it). */
const PROVISIONED_KEY = "ajarProvisioned";
let provisioned = false;

/** Policy source: backend HTTP mode (dev, enrolled via the options page) vs the
 *  native-host mode (production child agent). Selected at startup. */
let BACKEND_MODE = false;

// ---------------------------------------------------------------------------
// Policy snapshot cache (synced from the native host)
// ---------------------------------------------------------------------------

/** @type {any|null} A DevicePolicySnapshot per shared/policy/policy-model.ts. */
let snapshot = null;

/**
 * Restore cached policy.
 *
 * SECURITY: browser.storage.local lives in the child's own profile and is
 * therefore writable by anyone at the machine. Adopting whatever is in it (as
 * this used to) means hand-editing the cache to an allow-all policy is enough —
 * no signature needed, no server needed. So the cached snapshot and the cached
 * category filters are re-verified against the PINNED signing key on every load
 * and discarded if they don't check out. Same contract as the Windows mirror.
 *
 * "Pinned" is literal: the key comes from the trust anchor set at enrollment
 * (trust-anchor.js), not from the config the options page rewrites.
 */
export async function restoreCachedPolicy() {
  try {
    const got = await browser.storage.local.get([STORAGE_KEY, "categoryFilters", PROVISIONED_KEY]);
    const key = await getVerifyingKey();
    provisioned = got?.[PROVISIONED_KEY] === true;

    if (got?.[STORAGE_KEY] && key && await verifySnapshotSignature(got[STORAGE_KEY], key)) {
      snapshot = got[STORAGE_KEY];
    } else {
      if (got?.[STORAGE_KEY]) {
        console.warn("[guard] discarding cached snapshot: signature invalid or no pinned key");
        await browser.storage.local.remove(STORAGE_KEY);
      }
      snapshot = null;
    }

    const cached = got?.categoryFilters;
    if (cached && key
        && await verifyCanonicalSignature(cached.set ?? cached, cached.signature ?? "", key)) {
      setCategoryFilters(cached.set ?? cached);
    } else if (cached) {
      await browser.storage.local.remove("categoryFilters");
    }
  } catch (e) {
    // No policy. decide() decides what that means — and it is not a
    // YouTube-specific question (see the no-snapshot branch there).
    console.warn("[guard] could not load snapshot:", e);
    snapshot = null;
  }
  return snapshot;   // returned so tools/conformance/ can assert what was adopted
}

/** Adopt a snapshot only if it carries a signature from the pinned key. */
async function adoptSnapshotIfVerified(next) {
  const key = await getVerifyingKey();
  if (key && await verifySnapshotSignature(next, key)) snapshot = next;
  else console.warn("[guard] ignoring a cached snapshot that is not signed by the pinned key");
}

/** Same, for the category filter set. */
async function adoptFiltersIfVerified(next) {
  const key = await getVerifyingKey();
  if (key && await verifyCanonicalSignature(next.set ?? next, next.signature ?? "", key)) {
    setCategoryFilters(next.set ?? next);
  }
}

// React to snapshot updates written by the native-host bridge below (B4), and to
// anything else that writes the cache — verified either way, since "something
// wrote our storage key" is not evidence of where it came from.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY]) {
    const next = changes[STORAGE_KEY].newValue ?? null;
    if (!next) snapshot = null;
    else adoptSnapshotIfVerified(next);
  }
  if (changes.categoryFilters) {
    const next = changes.categoryFilters.newValue ?? null;
    if (!next) setCategoryFilters(null);
    else adoptFiltersIfVerified(next);
  }
});

// ---------------------------------------------------------------------------
// Native messaging — the containing app hands over the signed snapshot
// ---------------------------------------------------------------------------
//
// Safari routes native messaging through the containing app's
// SafariWebExtensionHandler, which reads the snapshot AjarFilter's app already
// wrote to the shared App Group. Safari unloads the service worker aggressively
// (B4/B5), so nothing is held open across unloads: every read is a fresh
// one-shot message, and browser.storage is the durable cache in between.
//
// Signature verification happens HERE, not natively (ADR-010): the App Group is
// writable by anything holding that entitlement, so the native side passing the
// bytes along is not evidence about who produced them.

/**
 * Ask the containing app for this device's policy.
 *
 * SAFARI DOES NOT IMPLEMENT `runtime.connectNative`. This code used to open a
 * long-lived port to "com.example.youtubeguard.host" — a Chrome/Firefox idiom
 * pointing at a placeholder host id that was never going to exist — and then
 * waited for POLICY_SNAPSHOT messages that could not arrive. In Safari the
 * channel is one-shot `sendNativeMessage`, routed to the containing app's
 * `SafariWebExtensionHandler`; there is no port and nothing pushes.
 *
 * So the extension asks, on worker start and on a slow timer. The application
 * id argument is required by the signature and ignored by Safari, which always
 * routes to the extension's own container.
 *
 * FAIL CLOSED: the containing app is inside our App Group, but so is anything
 * else with that entitlement, so the snapshot it hands back is verified against
 * the pinned Ed25519 key here, exactly like the backend path. The native side
 * passes bytes; it does not vouch for them.
 */
const NATIVE_APP_ID = "family.ajar.safari.Extension";

/** How often to re-ask the app for policy in native mode. An approval must land
 *  in seconds, and this is the only pull there is, so it is deliberately short;
 *  it is a local IPC read of a UserDefaults key, not a network call. */
const NATIVE_POLL_MS = 5000;

let nativeTimer = null;

async function nativeGetPolicy() {
  try {
    return await browser.runtime.sendNativeMessage(NATIVE_APP_ID, { type: "GET_POLICY" });
  } catch (e) {
    // The container is not installed, or this build is not in the App Group.
    console.warn("[ajar] native policy unavailable:", e);
    return null;
  }
}

/**
 * Adopt whatever the app has, if it verifies.
 *
 * `provisioned` is stored even when there is no snapshot to adopt: it is what
 * separates "this device was never set up" from "this device was set up and its
 * policy is missing", and `decide()` treats those opposite ways.
 */
async function syncFromNative() {
  const res = await nativeGetPolicy();
  if (!res || res.ok !== true) return;

  await browser.storage.local.set({ [PROVISIONED_KEY]: res.provisioned === true });
  provisioned = res.provisioned === true;

  // The key the app enrolled with. Adopted only when this profile has no
  // pinned anchor and no configured key of its own — a native answer must not
  // be able to REPLACE a pin, or App-Group write access would become the way to
  // re-point trust. Same refusal as PolicyStore.enrollSigningKey.
  if (res.signingKeyB64) {
    const existing = await getVerifyingKey();
    if (!existing) {
      await adoptSigningKeyIfUnset(res.signingKeyB64);
    } else if (existing !== res.signingKeyB64) {
      console.warn("[ajar] native signing key differs from the pinned one; keeping the pin");
    }
  }

  if (!res.snapshotJSON) return;
  let next = null;
  try { next = JSON.parse(res.snapshotJSON); } catch { next = null; }
  if (!next) {
    console.warn("[ajar] native snapshot did not parse");
    return;
  }
  const key = await getVerifyingKey();
  if (!key || !(await verifySnapshotSignature(next, key))) {
    console.warn("[ajar] rejected native snapshot: missing key or bad signature");
    return;
  }
  // Anti-replay, matching PolicyStore's high-water mark: a validly-signed OLD
  // snapshot must not restore an expired grant or undo a new block.
  if (snapshot && Number(next.version) < Number(snapshot.version)) {
    console.warn("[ajar] ignoring a rolled-back native snapshot");
    return;
  }
  snapshot = next;
  await browser.storage.local.set({ [STORAGE_KEY]: next });
}

function startNativeSync() {
  // No channel, no poll. Safari has sendNativeMessage; a plain browser loading
  // these files (the conformance harness, a dev run in Chrome) does not, and a
  // timer that can only ever log a failure is worse than none.
  if (typeof browser?.runtime?.sendNativeMessage !== "function") {
    console.warn("[ajar] no native messaging here; policy must come from the options page");
    return;
  }
  syncFromNative();
  if (nativeTimer == null) {
    nativeTimer = setInterval(syncFromNative, NATIVE_POLL_MS);
    // Browsers return a number and ignore this; Node returns a Timeout, and
    // without it a harness that imports this module never exits.
    nativeTimer?.unref?.();
  }
}

/** Round-trip a blocked canonical id to the app as an AccessRequest (B2).
 *
 *  NOT BUILT: the containing app serves GET_POLICY and nothing else, so this
 *  says so instead of posting into a void. The block page falls back to the
 *  backend path, and `REQUEST_ACCESS` below reports the failure to it rather
 *  than telling a child their parent was asked when nobody was.
 */
async function sendAccessRequest(_req) {
  return { ok: false, error: "native-request-not-implemented" };
}

// ---------------------------------------------------------------------------
// Evaluation — trimmed mirror of shared/policy/policy-model.ts `evaluate()`
// ---------------------------------------------------------------------------

function ruleAppliesToScope(r, ctx) {
  const s = r.scope || {};
  if (s.deviceId && s.deviceId !== ctx.deviceId) return false;
  if (s.childId && s.childId !== ctx.childId) return false;
  return true;
}

function scopeSpecificity(s = {}) {
  if (s.deviceId) return 3;
  if (s.childId) return 2;
  return 1;
}

/**
 * Is a YouTube video approved on this device RIGHT NOW?
 *
 * The gate for the playback chain above. Standing ALLOW rules count as well as
 * live grants: a parent who said "for good" to a video has approved it, and the
 * chain has to serve it. Mirrors PolicyStore.hasActiveVideoGrant.
 */
function hasActiveVideoGrant(snap, nowMs) {
  if (!snap) return false;
  const live = (snap.temporaryRules ?? []).some(
    (t) => t.action === "ALLOW" && t.target === "YOUTUBE_VIDEO" && isActiveTemp(t, nowMs));
  if (live) return true;
  return (snap.rules ?? []).some((r) => r.action === "ALLOW" && r.target === "YOUTUBE_VIDEO");
}

function isActiveTemp(t, nowMs) {
  const start = Date.parse(t.startsAt);
  const end = Date.parse(t.expiresAt);
  return nowMs >= start && nowMs < end;
}

/**
 * Categories whose domain set contains `host` (host lowercased, no leading www.).
 * Mirrors shared/categories/category-data.ts categoriesForHost.
 */
function categoriesForHost(categories, host) {
  const out = new Set();
  if (!categories || !host) return out;
  for (const [cat, domains] of Object.entries(categories)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) out.add(cat);
  }
  return out;
}

// --- Category Bloom filters: LOCKSTEP query-side mirror of shared/categories/bloom.ts.
// The compact membership asset (GET /v1/categories/filters) is fetched, signature-
// verified, and cached; this evaluates it locally — no per-URL call, no domain list.
const _FNV_PRIME = 0x01000193, _SEED_A = 0x811c9dc5, _SEED_B = 0x85ebca77;
const _enc = new TextEncoder();
function _fnv1a(bytes, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, _FNV_PRIME) >>> 0; }
  return h >>> 0;
}
function _bloomIndices(item, m, k) {
  const bytes = _enc.encode(item);
  const h1 = _fnv1a(bytes, _SEED_A); let h2 = _fnv1a(bytes, _SEED_B) | 1;
  const out = new Array(k); let x = h1 >>> 0;
  for (let i = 0; i < k; i++) { out[i] = x % m; x = (x + h2) >>> 0; h2 = (h2 + i) >>> 0; }
  return out;
}
function _b64ToBytes(b64) {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function hostCandidates(host) {
  const h = (host || "").replace(/\.$/, "").replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
  if (!h) return [];
  const parts = h.split("."); const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}
let CATEGORY_FILTERS = null;
export function setCategoryFilters(rawSet) {
  if (!rawSet || !rawSet.filters) { CATEGORY_FILTERS = null; return; }
  const filters = {};
  for (const cat of Object.keys(rawSet.filters)) {
    const f = rawSet.filters[cat];
    filters[cat] = { m: f.m, k: f.k, bits: _b64ToBytes(f.bits) };
  }
  CATEGORY_FILTERS = { version: rawSet.version, filters };
}
function categoriesFromFilters(host) {
  const cats = new Set();
  if (!CATEGORY_FILTERS) return cats;
  const cands = hostCandidates(host);
  for (const cat of Object.keys(CATEGORY_FILTERS.filters)) {
    const f = CATEGORY_FILTERS.filters[cat];
    for (const cand of cands) {
      let hit = true;
      for (const idx of _bloomIndices(cand, f.m, f.k)) {
        if ((f.bits[idx >>> 3] & (1 << (idx & 7))) === 0) { hit = false; break; }
      }
      if (hit) { cats.add(cat); break; }
    }
  }
  return cats;
}

/** Returns the matched policy key if `r` targets the request, else null. */

// --- SAFETY FLOOR: lockstep mirror of shared/safety/safety-floor.ts. Crisis and
// emergency resources are ALLOWED above every tier and are never reported.
//
// It was NOT a lockstep mirror. This list carried four entries the spec does not
// have — who.int, cdc.gov, samhsa.gov, nhs.uk — under a comment claiming it did.
// A safety-floor entry outranks a parent's explicit BLOCK and is deliberately
// never reported, so the divergence meant one iPhone giving two answers for the
// same host: Safari silently allowed it, the content filter blocked it, and the
// parent saw a rule the console called active and nothing to explain why it did
// not hold. *.nhs.uk alone is thousands of sites.
//
// Removed rather than promoted. Adding a domain to this list is a decision about
// whose block a child may override; it belongs in the spec, reviewed once, not
// in one platform's mirror. shared/safety/safety-floor.ts has an empty "Public
// health authorities" section where somebody meant to make that decision — that
// is where it goes.
const SAFETY_FLOOR_DOMAINS = ["988lifeline.org","suicidepreventionlifeline.org","crisistextline.org",
  "befrienders.org","findahelpline.com","samaritans.org","papyrus-uk.org","thetrevorproject.org",
  "childline.org.uk","kidshelpphone.ca","childhelphotline.org","youthline.co.nz","rainn.org",
  "thehotline.org","childhelp.org","humantraffickinghotline.org"];
function isSafetyFloorHost(host) {
  const h = (host || "").replace(/\.$/, "").replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
  if (!h) return false;
  return SAFETY_FLOOR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

function matchTarget(r, ctx, yt, hosts, hostCats) {
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
      return yt.channelId === r.value || yt.channelHandle === r.value ? `YOUTUBE_CHANNEL:${r.value}` : null;
    case "DOMAIN":
      // Match the request host OR any CNAME-resolved canonical name (anti-cloaking).
      return hosts.some((h) => h === r.value || h.endsWith(`.${r.value}`)) ? `DOMAIN:${r.value}` : null;
    case "CATEGORY":
      // Categories are precomputed over the host + its CNAME chain; a CATEGORY
      // rule matches when any of those names is in the set.
      return hostCats.has(r.value) ? `CATEGORY:${r.value}` : null;
    // APPLICATION is not decided on-path in the extension.
    default:
      return null;
  }
}

/**
 * Reference evaluation order (highest precedence first), matching policy-model.ts:
 *   temporary approvals → URL → YOUTUBE_VIDEO → YOUTUBE_PLAYLIST → YOUTUBE_CHANNEL
 *   → URL_PATTERN → DOMAIN → defaults (YouTube default handled distinctly).
 */
export function evaluate(snap, ctx) {
  const yt = normalizeYouTube(ctx.url);

  let host = "";
  try {
    host = new URL(ctx.url).hostname.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
  } catch {
    /* leave host empty */
  }
  // Request host + its CNAME chain (from ctx.resolvedHosts) — DOMAIN/CATEGORY
  // rules evaluate over all of them so CNAME cloaking can't bypass a block.
  const hosts = [...new Set(
    [host, ...(ctx.resolvedHosts || [])]
      .map((h) => (h || "").replace(/\.$/, "").replace(/^www\./i, "").toLowerCase())
      .filter(Boolean),
  )];
  // Inline map (small deployments) UNION the cached Bloom filters (scalable path).
  const hostCats = new Set();
  for (const h of hosts) {
    for (const c of categoriesForHost(snap.categories, h)) hostCats.add(c);
    for (const c of categoriesFromFilters(h)) hostCats.add(c);
  }

  // Tier 0 — safety floor, above every other tier (never blocked, never reported).
  // `host` only, never the resolved chain: ctx.resolvedHosts comes from DNS on
  // the child's own device, and the floor is the one tier where that untrusted
  // list would produce an ALLOW — above every rule, and never reported. See
  // shared/policy/policy-model.ts.
  if (isSafetyFloorHost(host)) return { action: "ALLOW", reason: "safety-floor", matchedKey: `SAFETY:${host}` };

  const applicable = (snap.rules || []).filter((r) => ruleAppliesToScope(r, ctx));

  // Tier 3: active temporary approvals (the "approve one video for N minutes"
  // grants). Enforced locally against server-signed UTC expiry (ADR-009).
  const temps = (snap.temporaryRules || [])
    .filter((t) => ruleAppliesToScope(t, ctx) && isActiveTemp(t, ctx.nowMs))
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        scopeSpecificity(b.scope) - scopeSpecificity(a.scope),
    );
  for (const t of temps) {
    const hit = matchTarget(t, ctx, yt, hosts, hostCats);
    // matchedRuleId is what makes a "just once" grant spendable: the caller has
    // to be able to name the grant it is about to use up.
    if (hit) return { action: t.action, reason: `temporary:${t.grantKind}`, matchedRuleId: t.id, matchedKey: hit };
  }

  const tierOrder = [
    "URL",
    "YOUTUBE_VIDEO",
    "YOUTUBE_PLAYLIST",
    "YOUTUBE_CHANNEL",
    "URL_PATTERN",
    "DOMAIN",
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
      const hit = matchTarget(r, ctx, yt, hosts, hostCats);
      if (hit) return { action: r.action, reason: `rule:${tier}`, matchedKey: hit };
    }
  }

  // Tier 9: defaults. YouTube surfaces use the independent YouTube default so
  // the family can run default-deny YouTube while the rest of the web is
  // default-allow (the product's headline posture).
  if (yt.isYouTube) {
    return { action: snap.defaults?.youTubeDefault ?? "BLOCK", reason: "default:youtube" };
  }
  return { action: snap.defaults?.webDefault ?? "ALLOW", reason: "default:web" };
}

// Documented exact-URL canonicalization — lockstep with normalizeExactUrl() in
// policy-model.ts.
function normalizeExactUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
    u.hash = "";
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, "");
    return s;
  } catch {
    return raw;
  }
}

// Minimal pattern support — trailing "*" prefix match only (lockstep with TS).
function matchesPattern(url, pattern) {
  if (pattern.endsWith("*")) return url.startsWith(pattern.slice(0, -1));
  return normalizeExactUrl(url) === normalizeExactUrl(pattern);
}

// ---------------------------------------------------------------------------
// Decision + redirect
// ---------------------------------------------------------------------------

/**
 * Decide whether a URL is blocked. Returns { blocked, key, reason }.
 *
 * ADR-004 ("never block Safari to gain enforcement") means we never disable or
 * kill Safari, and never blanket-block to compensate for a gap. It does NOT mean
 * "only ever gate YouTube": redirecting one specifically-blocked navigation to
 * our own block page leaves Safari and all other browsing fully functional.
 *
 * This function used to `return {blocked:false}` for every non-YouTube URL,
 * which silently made the CATEGORY / DOMAIN / Bloom / CNAME code below
 * unreachable — the extension advertised general filtering and enforced none of
 * it. It now runs the SHARED evaluator for every http(s) URL.
 *
 * Fail-open posture for ordinary web (a missing snapshot must not brick the
 * machine) but fail-CLOSED for YouTube, which is default-deny by design.
 */
function decide(url) {
  const yt = normalizeYouTube(url);

  // Only http(s) is in scope — never touch about:, data:, file:, extension pages.
  let scheme = "";
  try { scheme = new URL(url).protocol; } catch { return { blocked: false }; }
  if (scheme !== "http:" && scheme !== "https:") return { blocked: false };

  // NO POLICY. This used to fail CLOSED for YouTube and OPEN for everything
  // else, which made the fail path a statement about one website rather than
  // about the product: on a device that was enrolled and has since lost its
  // policy, every site but YouTube was wide open, and deleting the cached
  // snapshot was the bypass. The question "what does the absence of policy
  // mean?" has nothing to do with which site is being visited.
  //
  // Answered the same way the native filter answers it (PolicyStore.state()):
  //   never enrolled  -> ALLOW. We do not claim to filter this device, and a
  //                      browser that blocks everything before setup is broken,
  //                      not safe.
  //   enrolled, no policy -> BLOCK. The snapshot went missing or would not
  //                      verify; treating that as "allow" makes tampering with
  //                      the cache the whole attack.
  if (!snapshot) {
    if (!provisioned) return { blocked: false, reason: "no-policy:not-enrolled" };
    return {
      blocked: true,
      key: yt.isYouTube ? youTubePolicyKey(yt) : `URL:${url}`,
      reason: "no-policy:enrolled-fail-closed",
    };
  }

  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const ctx = {
    url,
    childId: snapshot.childId,
    deviceId: snapshot.deviceId,
    nowMs: Date.now(), // TODO(prod): monotonic/UTC-anchored per ADR-009
    resolvedHosts: CNAME.chainFor(host),
  };
  if (host) CNAME.prime(host); // fills the cache for subsequent navigations
  // Top-level navigations see a policy with this device's already-spent one-time
  // grants removed. decide() itself stays pure — spending is a side effect of an
  // actual navigation, and the caller says when that is.
  // Forget grants the policy no longer carries, so the set cannot grow for the
  // life of the worker. Done here rather than at each `snapshot = ...` site
  // because there are four of those and one of them will be missed.
  for (const id of SPENT) {
    if (!(snapshot.temporaryRules ?? []).some((t) => t.id === id)) SPENT.delete(id);
  }
  const view = SPENT.size > 0
    ? { ...snapshot, temporaryRules: (snapshot.temporaryRules ?? []).filter((t) => !SPENT.has(t.id)) }
    : snapshot;
  let res = evaluate(view, ctx);

  // ------------------------------------------------------------------
  // THE PLAYBACK CHAIN. An approved video's bytes come from
  // *.googlevideo.com and its player from i.ytimg/s.ytimg — hosts that are
  // not YouTube hosts, so they fell through to webDefault and were reachable
  // permanently, approved video or not. Their URLs are opaque: nothing in them
  // names a video, so the chain can only be tied to the GRANT.
  //
  // This existed in the iOS filter and NOT here, while
  // `isPlaybackSupportHost` sat exported and unimported and the manifest
  // claimed storage held "the 'any video currently approved?' flag used to
  // keep googlevideo.com reachable". There was no such flag. B7 was recorded
  // as delivered on this surface and was not written.
  //
  // Two lists, two directions. Reachable while approved: the whole support
  // list. Blocked while not: only hosts that serve NOTHING but YouTube —
  // never `fonts.gstatic.com`, which is Google Fonts and most of the web.
  // ------------------------------------------------------------------
  if (res.reason?.startsWith("default:")) {
    if (hasActiveVideoGrant(view, ctx.nowMs)) {
      if (isPlaybackSupportHost(host)) {
        res = { action: "ALLOW", reason: "playback-support", matchedKey: `PLAYBACK:${host}` };
      }
    } else if (res.action === "ALLOW" && res.reason === "default:web" && isExclusiveMediaHost(host)) {
      res = { action: "BLOCK", reason: "playback-support:no-grant", matchedKey: `PLAYBACK:${host}` };
    }
  }

  return {
    blocked: res.action === "BLOCK",
    key: res.matchedKey || (yt.isYouTube ? youTubePolicyKey(yt) : `URL:${url}`),
    reason: res.reason,
    ruleId: res.matchedRuleId,
  };
}

// ---------------------------------------------------------------------------
// "Just once"
//
// The server hands out a signed snapshot and hears nothing until the next poll,
// so it cannot know when the one allowed load happened — the device reports it.
// Until this existed, "just once" meant "as many times as you like for five
// minutes", five minutes being the backstop TTL.
//
// Only a top-level navigation spends it; sub-resources would burn the grant
// before the approved page had rendered. Consumption is client-attested and
// best-effort — see ApprovalService.consumeGrant for the residual risk, which is
// bounded by that same TTL.
// ---------------------------------------------------------------------------

/** Grant ids this device has spent, pending the next snapshot. */
const SPENT = new Set();

function spendOnce(res) {
  if (!res || res.blocked || res.reason !== "temporary:ONCE" || !res.ruleId) return;
  if (SPENT.has(res.ruleId)) return;
  SPENT.add(res.ruleId);
  if (!BACKEND_MODE) return; // native-host mode has no channel for this yet
  consumeGrant(res.ruleId).then((done) => {
    // A failure leaves it in SPENT: this device stops re-using it either way and
    // the server's TTL closes the window. Retrying could spend a grant the child
    // never got to use.
    if (!done) console.warn("[guard] could not report a spent one-time grant");
  });
}

function blockedPageUrl(originalUrl, key, reason) {
  const u = new URL(browser.runtime.getURL(BLOCKED_PAGE));
  u.searchParams.set("u", originalUrl);
  if (key) u.searchParams.set("k", key);
  // WHY it was closed. `decide()` has always returned this and it stopped here,
  // so the Mac block page could not say why — the one line UX_PRINCIPLES §9
  // singles out for reducing the threat-to-freedom that drives circumvention.
  // Same parameter name as the Windows redirect.
  if (reason) u.searchParams.set("reason", reason);
  return u.toString();
}

// Full navigations (top frame). SPA route changes come via content.js below.
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level only for redirects
  if (!snapshot) await restoreCachedPolicy();
  const res = decide(details.url);
  const { blocked, key, reason } = res;
  if (!blocked) spendOnce(res);
  if (blocked) {
    try {
      await browser.tabs.update(details.tabId, { url: blockedPageUrl(details.url, key, reason) });
    } catch (e) {
      console.warn("[guard] redirect failed:", e);
    }
  }
});

// IN-PAGE ROUTE CHANGES, the privileged half.
//
// `onHistoryStateUpdated` fires when a frame's history is updated by
// history.pushState/replaceState WITHOUT a network navigation — which is how
// every single-page app navigates. It needs no cooperation from the page and no
// script injection, so a page's Content-Security-Policy cannot stop it.
//
// This used to be handled ONLY by content.js patching history.pushState, which
// a content script cannot do: it runs in an isolated JavaScript world and the
// patch never touched the function the page calls. In-page gating therefore
// worked on YouTube, through its proprietary yt-navigate-finish event, and on no
// other site. page-hook.js is the second half; either alone would leave a gap,
// so both run and the duplicate evaluation is harmless.
for (const event of ["onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
  browser.webNavigation?.[event]?.addListener(async (details) => {
    if (details.frameId !== 0) return;   // only the top frame owns the tab
    if (!snapshot) await restoreCachedPolicy();
    const res = decide(details.url);
    if (!res.blocked) { spendOnce(res); return; }
    try {
      await browser.tabs.update(details.tabId,
        { url: blockedPageUrl(details.url, res.key, res.reason) });
    } catch (e) {
      console.warn("[ajar] in-page redirect failed:", e);
    }
  });
}

// ---------------------------------------------------------------------------
// Messages from content.js (SPA route changes, B3) and blocked.html (B2)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!snapshot) await restoreCachedPolicy();

  if (msg?.type === "EVALUATE_URL") {
    // content.js observed an in-page (pushState/replaceState/popstate) route
    // change that never hit the network. Re-evaluate and tell it what to do.
    // A pushState route change is a real load as far as a parent is concerned,
    // even though no network navigation fired.
    //
    // WHICH FRAME MATTERS. The content script runs in every frame
    // (`all_frames: true` — an embed has to be gated too), and this used to
    // redirect the whole TAB for whatever any of them reported. So a blocked
    // iframe on an allowed page — an ad, a widget, an embedded player — would
    // throw the child out of the page they were allowed to be on and onto the
    // block page for a URL they never asked for. The navigation path above has
    // always guarded this with `details.frameId !== 0`; the message path did
    // not.
    //
    // `sender.frameId` is the browser's account of where the message came from,
    // not the page's, so a hostile frame cannot claim to be the top one.
    const isTopFrame = sender.frameId === 0;
    const res = decide(msg.url);
    const { blocked, key, reason } = res;
    // Only a top-level load spends a one-time grant, same rule as the
    // navigation path: a sub-resource would burn it before the page rendered.
    if (!blocked && isTopFrame) spendOnce(res);
    if (blocked && isTopFrame && sender.tab?.id != null) {
      try {
        // Same three arguments as the navigation path above. An SPA route change
        // is a real load to a parent, so it must not be the one that arrives
        // without a reason.
        await browser.tabs.update(sender.tab.id, { url: blockedPageUrl(msg.url, key, reason) });
      } catch (e) {
        console.warn("[guard] SPA redirect failed:", e);
      }
    }
    // A blocked SUBFRAME gets `blocked: true` and no redirect: the frame stops
    // its own media and empties itself (content.js), and the page around it is
    // left alone. Blocking an embed must not be indistinguishable from blocking
    // the page that contains it.
    return { blocked, top: isTopFrame };
  }

  if (msg?.type === "REQUEST_ACCESS") {
    // blocked.html submitted a Request-Access. Derive the canonical target from
    // the blocked URL so the parent approves the right object (B2).
    const yt = normalizeYouTube(msg.url);
    const key = msg.key || (yt.isYouTube ? youTubePolicyKey(yt) : null);
    if (BACKEND_MODE) {
      const [targetType, targetValue] = key ? key.split(/:(.+)/) : ["URL", msg.url];
      try {
        await postAccessRequest({ targetType, targetValue, title: msg.title || undefined, url: msg.url, reason: msg.reason || undefined });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    // Native mode. The containing app serves policy and nothing else yet, so
    // this reports the failure rather than returning ok — the block page tells a
    // child their parent has been asked, and it must not say that when no
    // request was sent anywhere.
    return await sendAccessRequest({
      canonicalKey: key, url: msg.url, reason: msg.reason || "",
      childId: snapshot?.childId, deviceId: snapshot?.deviceId, requestedAt: new Date().toISOString(),
    });
  }

  // What the parent decided, asked for by the block page. The page used to work
  // this out from a temporary BLOCK rule in the cached snapshot, and a refusal's
  // grant expires after five minutes and is then dropped — so the answer
  // vanished and the page went back to "waiting on a parent" for up to a week.
  //
  // Backend mode only. The native-host path has no equivalent route yet, and
  // returning an empty list there would be indistinguishable from "nobody has
  // decided", so it says so and the page keeps its time-based fallback.
  if (msg?.type === "GET_ANSWERS") {
    if (!BACKEND_MODE) return { ok: false, error: "not available in native-host mode" };
    try {
      return { ok: true, answers: await getAnswers() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
});

// Prime the cache and select the policy source on worker start.
restoreCachedPolicy();
getConfig().then((cfg) => {
  if (cfg.backendUrl && cfg.deviceToken) {
    BACKEND_MODE = true;
    // backend-client verifies each snapshot's Ed25519 signature before calling us.
    startPolicySync(async (snap) => {
      snapshot = snap;
      await browser.storage.local.set({ [STORAGE_KEY]: snap });
    });
    startCategoryFilterSync(async (set, signature) => {
      setCategoryFilters(set);
      // Store the signature with the set so the next load can re-check it.
      await browser.storage.local.set({ categoryFilters: { set, signature: signature ?? "" } });
    });
  } else {
    // Apple: the containing app is the policy source, over one-shot native
    // messaging. This is the path a real install takes — the backend mode above
    // is the development one, enrolled by hand through the options page.
    startNativeSync();
  }
});
