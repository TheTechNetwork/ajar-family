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

import { normalizeYouTube, youTubePolicyKey, isPlaybackSupportHost } from "./youtube-normalize.js";
import { getConfig, startPolicySync, startCategoryFilterSync, postAccessRequest } from "./backend-client.js";

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
        applyCategoryFilters(msg.set);
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
  if (typeof serverNowMs === "number") {
    CLOCK_ANCHOR = { serverNowMs, perfNowAtAnchor: performance.now() };
  }
  chrome.storage.local.set({ snapshot: SNAPSHOT, clockAnchor: CLOCK_ANCHOR });
}

/** Install + persist a verified category filter set (from native host or backend). */
function applyCategoryFilters(rawSet) {
  setCategoryFilters(rawSet);
  chrome.storage.local.set({ categoryFilters: rawSet });
}

// Restore the last cached snapshot + filters on worker restart so enforcement is
// immediate and offline-safe (the filters are held as the raw serialized set).
chrome.storage.local.get(["snapshot", "clockAnchor", "categoryFilters"], (v) => {
  if (v && v.snapshot) SNAPSHOT = v.snapshot;
  if (v && v.clockAnchor) CLOCK_ANCHOR = v.clockAnchor;
  if (v && v.categoryFilters) setCategoryFilters(v.categoryFilters);
});

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
    startCategoryFilterSync((set) => applyCategoryFilters(set));
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
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    u.hash = "";
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, "");
    return s;
  } catch {
    return raw;
  }
}

function matchesPattern(url, pattern) {
  if (pattern.endsWith("*")) return url.startsWith(pattern.slice(0, -1));
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
  const h = (host || "").replace(/^www\./i, "").toLowerCase();
  if (!h) return [];
  const parts = h.split("."); const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

/** @type {{version:number, filters:Record<string,{m:number,k:number,bits:Uint8Array}>}|null} */
let CATEGORY_FILTERS = null;
/** Install a fetched+verified filter set (decodes base64 once for fast queries). */
function setCategoryFilters(rawSet) {
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
 * @returns {{action:"ALLOW"|"BLOCK", reason:string, matchedKey?:string}}
 */
function evaluate(snapshot, ctx) {
  const yt = normalizeYouTube(ctx.url);

  let host = "";
  try {
    host = new URL(ctx.url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    /* leave host empty */
  }
  // Request host + its CNAME chain (from ctx.resolvedHosts) — DOMAIN/CATEGORY
  // rules evaluate over all of them so CNAME cloaking can't bypass a block.
  const hosts = [...new Set(
    [host, ...(ctx.resolvedHosts || [])]
      .map((h) => (h || "").replace(/^www\./i, "").toLowerCase())
      .filter(Boolean),
  )];
  // Inline map (small deployments) UNION the cached Bloom filters (scalable path).
  const hostCats = new Set();
  for (const h of hosts) {
    for (const c of categoriesForHost(snapshot.categories, h)) hostCats.add(c);
    for (const c of categoriesFromFilters(h)) hostCats.add(c);
  }

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
    if (hit) return { action: t.action, reason: `temporary:${t.grantKind}`, matchedKey: hit };
  }

  // Standing rules, ordered by target tier then priority/scope.
  for (const tier of TIER_ORDER) {
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
  if (host && isPlaybackSupportHost(host) && anyVideoApproved()) {
    return { action: "ALLOW", reason: "playback-support-host" };
  }

  const ctx = {
    url,
    childId: SNAPSHOT.childId,
    deviceId: SNAPSHOT.deviceId,
    nowMs: nowMs(),
  };
  return evaluate(SNAPSHOT, ctx);
}

function onBeforeRequestBlocking(details) {
  // Only gate top-level document navigations and sub_frame (embeds) here; media
  // (googlevideo) is handled by the playback-support carve-out inside decide().
  const url = details.url;
  const res = decide(url, details.type);
  if (res.action === "BLOCK") {
    // Redirect only real page navigations to the friendly block page; for
    // sub-resources cancel instead (a redirect would break the parent page).
    if (details.type === "main_frame") {
      const redirectUrl =
        `${EXT_BLOCK_PAGE}?u=${encodeURIComponent(url)}&reason=${encodeURIComponent(res.reason)}` +
        (res.matchedKey ? `&key=${encodeURIComponent(res.matchedKey)}` : "");
      return { redirectUrl };
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
    const res = decide(details.url, "main_frame");
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
});
