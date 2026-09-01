/**
 * Background service worker — Windows MV3 enforcement adapter (PoC C).
 *
 * Enforcement path: chrome.webRequest.onBeforeRequest registered with ["blocking"].
 * The listener is SYNCHRONOUS — it must return a BlockingResponse immediately to
 * cancel or redirect a disallowed navigation before it loads. Synchronous blocking
 * webRequest is available to us ONLY because this extension is force-installed by
 * enterprise policy (ExtensionInstallForcelist); Chrome's MV3 migration guide:
 * "You don't need to make these changes if your extension is installed by policy"
 * — https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests
 *
 * Because the listener is synchronous, the policy snapshot must already be in
 * memory. We load it asynchronously from the LocalSystem service via native
 * messaging and cache it; the listener only ever reads the cached snapshot.
 *
 * ⚠️ LOCKSTEP: the evaluation order below reproduces `evaluate()` in
 * `shared/policy/policy-model.ts`. That TypeScript is the SPEC and the single
 * source of truth; this JS must produce identical decisions. Any change to the
 * shared evaluator must be mirrored here (enforced by review).
 */

import { normalizeYouTube, youTubePolicyKey, isPlaybackSupportUrl } from "./youtube-normalize.js";
import { getConfig, getVerifyingKey, startPolicySync, startCategoryFilterSync, postAccessRequest, consumeGrant, getAnswers } from "./backend-client.js";
import { makeResolver } from "./cname-resolve.js";
import { verifySnapshotSignature, verifyCanonicalSignature } from "./policy-verify.js";

// On-device CNAME resolver (anti-cloaking). Resolves asynchronously + caches;
// the synchronous block listener reads the cached chain. See cname-resolve.js.
const CNAME = makeResolver();

// ---------------------------------------------------------------------------
// Policy snapshot cache (held in memory for the synchronous blocking listener)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DevicePolicySnapshot  Mirror of shared/policy/policy-model.ts.
 * Fields: version, familyId, childId, deviceId, defaults{webDefault,youTubeDefault},
 * rules[], temporaryRules[], issuedAt, signature.
 */

/** @type {DevicePolicySnapshot|null} */
let SNAPSHOT = null;

/** Monotonic base so a child changing the wall clock/timezone can't extend a
 *  grant (ADR-009). We anchor server-signed UTC `expiresAt` to performance.now()
 *  deltas rather than trusting Date.now() drift. */
let CLOCK_ANCHOR = null; // { serverNowMs, perfNowAtAnchor }

const NATIVE_HOST = "com.ajarfamily.host"; // must match the service's registered native host name
const EXT_BLOCK_PAGE = chrome.runtime.getURL("blocked.html");

// ---------------------------------------------------------------------------
// Native messaging: receive signed snapshots from the LocalSystem service
// ---------------------------------------------------------------------------

let port = null;

function connectNativeHost() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === "policySnapshot" && msg.snapshot) {
        // The service verifies the Ed25519 signature over the canonical JSON
        // (shared/policy DevicePolicySnapshot.signature) BEFORE sending it here;
        // an unsigned/altered snapshot is rejected by the service and never
        // reaches the extension. We fail closed if we somehow hold nothing.
        SNAPSHOT = msg.snapshot;
        if (typeof msg.serverNowMs === "number") {
          CLOCK_ANCHOR = { serverNowMs: msg.serverNowMs, perfNowAtAnchor: performance.now() };
        }
        chrome.storage.local.set({ snapshot: SNAPSHOT, clockAnchor: CLOCK_ANCHOR });
      } else if (msg && msg.type === "categoryFilters" && msg.set) {
        // The service verifies the asset's Ed25519 signature (signCanonical over
        // the set) before forwarding — same fail-closed contract as snapshots.
        applyCategoryFilters(msg.set, msg.signature);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // Retry; the service (LocalSystem) is expected to be always-on. Until we
      // reconnect we keep enforcing the last cached snapshot (offline-safe).
      setTimeout(connectNativeHost, 2000);
    });
    port.postMessage({ type: "hello", need: "policySnapshot" });
  } catch (e) {
    setTimeout(connectNativeHost, 5000);
  }
}

/** Apply a verified snapshot from either policy source (native host or backend). */
function applySnapshot(snapshot, serverNowMs) {
  SNAPSHOT = snapshot;
  // Forget grants that are no longer in the policy at all. Without this the set
  // grows for the life of the service worker, and a grant id reissued later
  // (it will not be, but nothing here guarantees that) would arrive pre-spent.
  for (const id of [...SPENT]) {
    if (!snapshot.temporaryRules?.some((t) => t.id === id)) SPENT.delete(id);
  }
  if (typeof serverNowMs === "number") {
    CLOCK_ANCHOR = { serverNowMs, perfNowAtAnchor: performance.now() };
  }
  chrome.storage.local.set({ snapshot: SNAPSHOT, clockAnchor: CLOCK_ANCHOR });
  reevaluateOpenTabs(); // an approval just landed — reopen what it unblocked
}

/** Install + persist a verified category filter set (from native host or backend).
 *  The signature is stored WITH the set so restoreCachedPolicy() can re-check it;
 *  a set cached without one is discarded on the next load (fail closed). */
function applyCategoryFilters(rawSet, signature) {
  setCategoryFilters(rawSet);
  chrome.storage.local.set({ categoryFilters: { set: rawSet, signature: signature ?? "" } });
}

/** True once we've finished loading cached policy (or established there is none).
 *  Until then the web is UNPROTECTED, so we re-check open tabs the moment it flips. */
let POLICY_READY = false;

/**
 * Restore cached policy on worker restart.
 *
 * SECURITY: chrome.storage.local lives in the child's own profile directory and
 * is therefore attacker-writable. Verifying only on fetch (as we used to) meant a
 * child could hand-edit the cache to an allow-all policy and we would enforce it.
 * So the cached snapshot and the cached category filters are re-verified against
 * the pinned signing key on EVERY load, and discarded if they don't check out.
 *
 * "Pinned" is now literal: the key comes from the trust anchor set at enrollment
 * (trust-anchor.js), not from the config the options page rewrites.
 */
export async function restoreCachedPolicy() {
  try {
    const v = await chrome.storage.local.get(["snapshot", "clockAnchor", "categoryFilters"]);
    const key = await getVerifyingKey();
    if (v?.snapshot && key && await verifySnapshotSignature(v.snapshot, key)) {
      SNAPSHOT = v.snapshot;
    } else if (v?.snapshot) {
      console.warn("[ajar] discarding cached snapshot: signature invalid or no pinned key");
      SNAPSHOT = null;   // hold nothing rather than hold something unverified
      await chrome.storage.local.remove("snapshot");
    }
    if (v?.categoryFilters && key
        && await verifyCanonicalSignature(v.categoryFilters.set ?? v.categoryFilters,
                                          v.categoryFilters.signature ?? "", key)) {
      setCategoryFilters(v.categoryFilters.set ?? v.categoryFilters);
    } else if (v?.categoryFilters) {
      await chrome.storage.local.remove("categoryFilters");
    }
    // The clock anchor is unsigned; only ever let it move time FORWARD from now,
    // so a rewritten anchor cannot extend an expired grant.
    if (v?.clockAnchor && typeof v.clockAnchor.serverNowMs === "number"
        && v.clockAnchor.serverNowMs <= Date.now() + 60_000) {
      CLOCK_ANCHOR = v.clockAnchor;
    }
  } catch (e) {
    console.warn("[ajar] could not restore cached policy:", e);
  } finally {
    POLICY_READY = true;
    reevaluateOpenTabs(); // close the cold-start window immediately
  }
  return SNAPSHOT;   // returned so tools/conformance/ can assert what was adopted
}
restoreCachedPolicy();

/**
 * Re-decide every open tab against current policy.
 *
 * Serves two jobs at once:
 *  - closes the MV3 cold-start gap (the request that WAKES the service worker is
 *    decided with no snapshot in memory, so it is allowed; this catches it a
 *    moment later), and
 *  - delivers the promise the block page makes — "this page opens by itself if a
 *    parent says yes" — by sending a now-allowed tab back to where it was going.
 */
async function reevaluateOpenTabs() {
  if (!chrome.tabs?.query) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    if (tab.url.startsWith(EXT_BLOCK_PAGE)) {
      // On our block page: if the original URL is now allowed, go back to it.
      try {
        const original = new URL(tab.url).searchParams.get("u");
        if (original && decide(original, "main_frame").action === "ALLOW") {
          chrome.tabs.update(tab.id, { url: original });
        }
      } catch { /* ignore */ }
    } else if (/^https?:/.test(tab.url)) {
      // On a real page that policy now blocks (cold-start slip, or a new rule).
      const res = decide(tab.url, "main_frame");
      if (res.action === "BLOCK") {
        chrome.tabs.update(tab.id, { url: blockedUrlFor(tab.url, res) });
      }
    }
  }
}

// Policy source selection:
//  - Backend HTTP mode (dev / browser-testable): if enrolled via the options page,
//    long-poll the backend directly for signed snapshots.
//  - Native-host mode (production Windows): the LocalSystem service pushes signed
//    snapshots over native messaging.
// Both call applySnapshot(); the blocking listener only ever reads the cache.
let BACKEND_MODE = false;
getConfig().then((cfg) => {
  if (cfg.backendUrl && cfg.deviceToken) {
    BACKEND_MODE = true;
    startPolicySync((snapshot, serverNowMs) => applySnapshot(snapshot, serverNowMs));
    startCategoryFilterSync((set, signature) => applyCategoryFilters(set, signature));
  } else {
    connectNativeHost();
  }
});

/** Monotonic "now" in UTC ms (EvalContext.nowMs). Uses the server-anchored time
 *  plus a monotonic delta; falls back to Date.now() only if never anchored. */
function nowMs() {
  if (CLOCK_ANCHOR) {
    return CLOCK_ANCHOR.serverNowMs + (performance.now() - CLOCK_ANCHOR.perfNowAtAnchor);
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Evaluation — reproduces shared/policy/policy-model.ts `evaluate()`
// ---------------------------------------------------------------------------
//
// Evaluation order (highest precedence first):
//   1. Device-specific rules      (scope specificity promotes tier)
//   2. Child/user-specific rules
//   3. Temporary approvals        (active window only)
//   4. Exact URL allow
//   5. Exact URL block
//   6. YouTube video → playlist → channel
//   7. Domain rules
//   8. Category rules             (adapters inject out-of-band; not URL-shape)
//   9. Global/default policy      (YouTube default handled distinctly)
//
// Tiers 1–2 are expressed as scope specificity within each target tier, exactly
// as the shared evaluator does.

const TIER_ORDER = [
  "URL",
  "YOUTUBE_VIDEO",
  "YOUTUBE_PLAYLIST",
  "YOUTUBE_CHANNEL",
  "URL_PATTERN",
  "DOMAIN",
  "APPLICATION",
  "CATEGORY",
];

function scopeSpecificity(s) {
  if (s.deviceId) return 3;
  if (s.childId) return 2;
  return 1;
}

function ruleAppliesToScope(r, ctx) {
  const s = r.scope;
  if (s.deviceId && s.deviceId !== ctx.deviceId) return false;
  if (s.childId && s.childId !== ctx.childId) return false;
  return true;
}

function isActiveTemp(t, now) {
  const start = Date.parse(t.startsAt);
  const end = Date.parse(t.expiresAt);
  return now >= start && now < end;
}

/** Documented canonicalization for exact-URL comparison. Keep in lockstep with
 *  `normalizeExactUrl` in the shared TS. */
function normalizeExactUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
    u.hash = "";
    // Credentials in the authority: same page, and it used to be a different key.
    u.username = "";
    u.password = "";
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, "");
    // Percent-encoding, decoded ONLY where unambiguous — a decode that
    // reintroduces a delimiter changes what the URL means.
    s = s.replace(/%[0-9A-Fa-f]{2}/g, (esc) => {
      let ch;
      try { ch = decodeURIComponent(esc); } catch { return esc; }
      return /^[A-Za-z0-9\-._~]$/.test(ch) ? ch : esc;
    });
    return s;
  } catch {
    return raw;
  }
}

/** Both sides normalized, including the wildcard branch — it used to compare
 *  the pattern against the RAW url while the exact branch normalized, so an
 *  allow-pattern missed and a block-pattern was evaded by one character. */
function matchesPattern(url, pattern) {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    let np;
    try { np = normalizeExactUrl(prefix); new URL(prefix); }
    catch { return url.startsWith(prefix); }
    return normalizeExactUrl(url).startsWith(np);
  }
  return normalizeExactUrl(url) === normalizeExactUrl(pattern);
}

/**
 * Categories whose domain set contains `host` (host lowercased, no leading www.).
 * Mirrors shared/categories/category-data.ts categoriesForHost.
 * @returns {Set<string>}
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
// verified, and cached by the client transport; this evaluates it locally with NO
// per-URL call and no domain list in the extension. Build side stays server-only.
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

/** @type {{version:number, filters:Record<string,{m:number,k:number,bits:Uint8Array}>}|null} */
let CATEGORY_FILTERS = null;
/** Install a fetched+verified filter set (decodes base64 once for fast queries). */
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


// --- SAFETY FLOOR: lockstep mirror of shared/safety/safety-floor.ts. Crisis and
// emergency resources are ALLOWED above every tier and are never reported.
//
// It was not a mirror: this and the Safari copy both carried four entries the
// spec does not have (who.int, cdc.gov, samhsa.gov, nhs.uk). A floor entry
// outranks a parent's explicit BLOCK and is never reported, so the divergence
// made a rule the console calls active silently not hold on the one platform
// that ships. Removed rather than promoted — whose block a child may override is
// a decision for the spec, made once. tools/conformance/check-safety-floor.mjs
// now fails CI if the four copies drift again.
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
    case "YOUTUBE_PLAYLIST": {
      // `list=` is a query parameter the child types and nothing can verify the
      // video is in the playlist, so an ALLOW on a playlist used to open EVERY
      // video on YouTube. An untrusted value may ADD a block, never an allow:
      // BLOCK matches a video carrying the list, ALLOW is the playlist page only.
      if (!yt.playlistId || yt.playlistId !== r.value) return null;
      if (r.action === "ALLOW" && yt.kind !== "playlist") return null;
      return `YOUTUBE_PLAYLIST:${r.value}`;
    }
    case "YOUTUBE_CHANNEL": {
      // Handles fold case in a YouTube URL; channel IDs (UC...) do not.
      if (yt.channelId && yt.channelId === r.value) return `YOUTUBE_CHANNEL:${r.value}`;
      if (yt.channelHandle && yt.channelHandle.toLowerCase() === r.value.toLowerCase()) {
        return `YOUTUBE_CHANNEL:${r.value}`;
      }
      return null;
    }
    case "DOMAIN":
      // Match the request host OR any CNAME-resolved canonical name (anti-cloaking).
      return hosts.some((h) => h === r.value || h.endsWith(`.${r.value}`)) ? `DOMAIN:${r.value}` : null;
    case "APPLICATION":
      return ctx.appId && ctx.appId === r.value ? `APPLICATION:${r.value}` : null;
    case "CATEGORY":
      // Categories are precomputed over the host + its CNAME chain; a CATEGORY
      // rule matches when any of those names is in the set.
      return hostCats.has(r.value) ? `CATEGORY:${r.value}` : null;
    default:
      return null;
  }
}

/**
 * @returns {{action:"ALLOW"|"BLOCK", reason:string, matchedRuleId?:string, matchedKey?:string}}
 */
export function evaluate(snapshot, ctx) {
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
    for (const c of categoriesForHost(snapshot.categories, h)) hostCats.add(c);
    for (const c of categoriesFromFilters(h)) hostCats.add(c);
  }

  // Tier 0 — safety floor, above every other tier (never blocked, never reported).
  // `host` only, never the resolved chain: ctx.resolvedHosts comes from DNS on
  // the child's own device, and the floor is the one tier where that untrusted
  // list would produce an ALLOW — above every rule, and never reported. See
  // shared/policy/policy-model.ts.
  if (isSafetyFloorHost(host)) return { action: "ALLOW", reason: "safety-floor", matchedKey: `SAFETY:${host}` };

  const applicable = snapshot.rules.filter((r) => ruleAppliesToScope(r, ctx));

  // Tier 3: active temporary approvals (the "approve one video for N minutes"
  // grants). Checked before standing rules so an approval overrides a standing
  // block for its window.
  const temps = (snapshot.temporaryRules || [])
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

  // Standing rules, ordered by target tier then priority/scope.
  for (const tier of TIER_ORDER) {
    const inTier = applicable
      .filter((r) => r.target === tier)
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
          // Deny wins a tie. Same tier, same priority, same scope fell through
          // to insertion order, so the OLDEST rule won and a parent's later
          // "keep it closed for good" was inert forever.
          (a.action === b.action ? 0 : a.action === "BLOCK" ? -1 : 1),
      );
    for (const r of inTier) {
      const hit = matchTarget(r, ctx, yt, hosts, hostCats);
      if (hit) return { action: r.action, reason: `rule:${tier}`, matchedKey: hit };
    }
  }

  // Tier 9: defaults. YouTube surfaces use the YouTube default so the family can
  // run default-deny YouTube while the rest of the web is default-allow.
  if (yt.isYouTube) {
    return { action: snapshot.defaults.youTubeDefault, reason: "default:youtube" };
  }
  return { action: snapshot.defaults.webDefault, reason: "default:web" };
}

// ---------------------------------------------------------------------------
// The blocking listener
// ---------------------------------------------------------------------------

/** Does any currently-active temporary/standing rule allow SOME video right now?
 *  Used to decide whether to permit the opaque googlevideo.com media CDN (see
 *  ARCHITECTURE.md §6 / YOUTUBE_PLAYBACK_SUPPORT_HOSTS): googlevideo URLs cannot
 *  be tied to a video id, so we allow the host while ANY video is approved and
 *  rely on the per-video watch-page gate to actually control access. */
function anyVideoApproved() {
  if (!SNAPSHOT) return false;
  const now = nowMs();
  const tempAllowsVideo = (SNAPSHOT.temporaryRules || []).some(
    (t) => t.action === "ALLOW" && t.target === "YOUTUBE_VIDEO" && isActiveTemp(t, now),
  );
  const standingAllowsVideo = (SNAPSHOT.rules || []).some(
    (r) => r.action === "ALLOW" && r.target === "YOUTUBE_VIDEO",
  );
  return tempAllowsVideo || standingAllowsVideo;
}

function decide(url, type) {
  // Fail CLOSED on protected surfaces if we somehow hold no policy: for YouTube
  // (default-deny posture) we block; ordinary web fails open so a missing snapshot
  // never bricks the machine (ARCHITECTURE.md §8 fail strategy).
  const yt = normalizeYouTube(url);
  if (!SNAPSHOT) {
    return yt.isYouTube ? { action: "BLOCK", reason: "failclosed:no-snapshot" } : { action: "ALLOW", reason: "failopen:no-snapshot" };
  }

  // Never block the resources an approved video needs to stream.
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  // Sub-resources only, and on www.youtube.com only true player endpoints — a
  // page load NEVER qualifies, or one approved video opens all of YouTube.
  if (isPlaybackSupportUrl(url, type) && anyVideoApproved()) {
    return { action: "ALLOW", reason: "playback-support" };
  }

  // Kick off async CNAME resolution for this host (cached for next time) and
  // read whatever chain is already cached for THIS decision. The sync listener
  // can't await, so the first hit to a new host uses [] and later hits are covered.
  if (host) CNAME.prime(host);
  const ctx = {
    url,
    childId: SNAPSHOT.childId,
    deviceId: SNAPSHOT.deviceId,
    nowMs: nowMs(),
    resolvedHosts: host ? CNAME.chainFor(host) : [],
  };
  // Top-level navigations see a policy with this device's already-spent
  // one-time grants removed; sub-resources see the whole thing, so the page a
  // grant just paid for finishes loading.
  const snapshot = (type === "main_frame" && SPENT.size > 0)
    ? { ...SNAPSHOT, temporaryRules: (SNAPSHOT.temporaryRules ?? []).filter((t) => !SPENT.has(t.id)) }
    : SNAPSHOT;
  // Pure on purpose. Spending a one-time grant is a side effect of an actual
  // navigation, and decide() is also called speculatively — reevaluateOpenTabs()
  // re-decides every open tab whenever a snapshot lands. Spending here would
  // burn a grant the child never used, and would then block the very navigation
  // reevaluateOpenTabs was about to start. spendOnce() is called from the two
  // places a page genuinely loads instead.
  return evaluate(snapshot, ctx);
}

// ---------------------------------------------------------------------------
// "Just once"
//
// A ONCE grant is meant to end at the first load. The server cannot know when
// that happened — it hands the device a signed snapshot and hears nothing until
// the next poll — so the DEVICE reports it, and until this existed the option
// meant "as many times as you like for five minutes" (the backstop TTL).
//
// Two things make this behave:
//
//   1. Only a TOP-LEVEL NAVIGATION spends it. A favicon or a stylesheet would
//      otherwise burn the grant before the page the parent approved had even
//      rendered.
//   2. Spending it does not immediately blind the page that is loading. `SPENT`
//      is only consulted for main_frame decisions, so the sub-resources of the
//      one allowed load still get through while the new snapshot is in flight.
//
// Consumption is client-attested and best-effort — see
// ApprovalService.consumeGrant for the residual risk, which is bounded by the
// same five-minute backstop.
// ---------------------------------------------------------------------------

/** Grant ids this device has already spent, pending the next snapshot. */
const SPENT = new Set();

function spendOnce(res) {
  const id = res.matchedRuleId;
  if (!id || res.reason !== "temporary:ONCE" || res.action !== "ALLOW") return;
  if (SPENT.has(id)) return;
  SPENT.add(id);
  if (!BACKEND_MODE) return; // native-host mode has no channel for this yet
  consumeGrant(id).then((done) => {
    // A failure leaves it in SPENT: this device stops re-using it either way,
    // and the server's TTL closes the window. Re-trying would risk spending a
    // grant the child never actually got to use.
    if (!done) console.warn("[ajar] could not report a spent one-time grant");
  });
}

function blockedUrlFor(url, res) {
  return `${EXT_BLOCK_PAGE}?u=${encodeURIComponent(url)}&reason=${encodeURIComponent(res.reason)}` +
    (res.matchedKey ? `&key=${encodeURIComponent(res.matchedKey)}` : "");
}

function onBeforeRequestBlocking(details) {
  // Only gate top-level document navigations and sub_frame (embeds) here; media
  // (googlevideo) is handled by the playback-support carve-out inside decide().
  const url = details.url;
  const res = decide(url, details.type);
  if (res.action === "ALLOW" && details.type === "main_frame") spendOnce(res);
  if (res.action === "BLOCK") {
    // Redirect only real page navigations to the friendly block page; for
    // sub-resources cancel instead (a redirect would break the parent page).
    if (details.type === "main_frame") {
      return { redirectUrl: blockedUrlFor(url, res) };
    }
    return { cancel: true };
  }
  return {}; // allow
}

chrome.webRequest.onBeforeRequest.addListener(
  onBeforeRequestBlocking,
  {
    urls: ["<all_urls>"],
    types: ["main_frame", "sub_frame", "xmlhttprequest", "media"],
  },
  ["blocking"],
);

// Warm the CNAME cache before the request is decided: onBeforeNavigate fires
// ahead of the main_frame request, so by the time onBeforeRequest runs the
// chain is usually already cached and folded into the decision.
if (chrome.webNavigation?.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0) return;
    try { CNAME.prime(new URL(d.url).hostname); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// SPA route interception (YouTube changes the video via history.pushState with
// no full document navigation, so onBeforeRequest main_frame never fires). We
// re-evaluate on history-state updates and redirect the tab if the new route is
// blocked. This is best-effort in-page enforcement layered on top of the
// network-level block above; the load-bearing gate remains onBeforeRequest.
// ---------------------------------------------------------------------------

chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    // YouTube swaps the video with pushState and no document request, so this
    // is a real load as far as a parent is concerned even though no main_frame
    // request fired.
    const res = decide(details.url, "main_frame");
    if (res.action === "ALLOW") spendOnce(res);
    if (res.action === "BLOCK") {
      const target =
        `${EXT_BLOCK_PAGE}?u=${encodeURIComponent(details.url)}&reason=${encodeURIComponent(res.reason)}` +
        (res.matchedKey ? `&key=${encodeURIComponent(res.matchedKey)}` : "");
      chrome.tabs.update(details.tabId, { url: target });
    }
  },
  { url: [{ hostSuffix: "youtube.com" }, { hostSuffix: "youtu.be" }] },
);

// ---------------------------------------------------------------------------
// Access requests from the block page → forward to the service (native host),
// which signs and forwards to the backend (ARCHITECTURE.md §7).
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "requestAccess") {
    // Derive the canonical target from the blocked URL so the parent approves the
    // right object (e.g. YOUTUBE_VIDEO:<id>), never the raw URL string.
    const yt = normalizeYouTube(msg.url);
    const key = yt.isYouTube ? youTubePolicyKey(yt) : null;
    const [targetType, targetValue] = key ? key.split(/:(.+)/) : ["URL", msg.url];

    if (BACKEND_MODE) {
      postAccessRequest({
        targetType, targetValue,
        title: msg.title || undefined, url: msg.url, reason: msg.userReason || undefined,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async response
    }

    // Native-host mode: forward to the LocalSystem service, which signs + forwards.
    try {
      if (port) port.postMessage({
        type: "accessRequest", url: msg.url, canonicalKey: key,
        reason: msg.userReason || null, childId: SNAPSHOT?.childId, deviceId: SNAPSHOT?.deviceId, atMs: nowMs(),
      });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // async response
  }

  // What the parent decided, asked for by the block page.
  //
  // The page used to work this out by looking for a temporary BLOCK rule in the
  // cached snapshot — and a refusal writes a grant that expires after five
  // minutes, which the backend then drops, so the answer vanished and the page
  // silently went back to "waiting on a parent" for up to a week.
  //
  // Only meaningful in backend mode. The native-host path has no equivalent
  // route yet, and answering `{ok:true, answers:[]}` there would be
  // indistinguishable from "nobody has decided" — so it says so, and the page
  // keeps its time-based honesty fallback.
  if (msg && msg.type === "getAnswers") {
    if (!BACKEND_MODE) {
      sendResponse({ ok: false, error: "not available in native-host mode" });
      return true;
    }
    getAnswers()
      .then((answers) => sendResponse({ ok: true, answers }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
});
