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

import { normalizeYouTube, youTubePolicyKey } from "./youtube-normalize.js";
import { getConfig, startPolicySync, startCategoryFilterSync, postAccessRequest } from "./backend-client.js";
import { verifySnapshotSignature } from "./policy-verify.js";

const STORAGE_KEY = "devicePolicySnapshot";
const BLOCKED_PAGE = "blocked.html";

/** Policy source: backend HTTP mode (dev, enrolled via the options page) vs the
 *  native-host mode (production child agent). Selected at startup. */
let BACKEND_MODE = false;

// ---------------------------------------------------------------------------
// Policy snapshot cache (synced from the native host)
// ---------------------------------------------------------------------------

/** @type {any|null} A DevicePolicySnapshot per shared/policy/policy-model.ts. */
let snapshot = null;

async function loadSnapshot() {
  try {
    const got = await browser.storage.local.get([STORAGE_KEY, "categoryFilters"]);
    snapshot = got?.[STORAGE_KEY] ?? null;
    if (got?.categoryFilters) setCategoryFilters(got.categoryFilters); // restore compact filters
  } catch (e) {
    // Fail closed for YouTube gating if we can't read policy (see evaluate()).
    console.warn("[guard] could not load snapshot:", e);
    snapshot = null;
  }
}

// React to snapshot updates written by the native-host bridge below (B4).
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    snapshot = changes[STORAGE_KEY].newValue ?? null;
  }
  if (area === "local" && changes.categoryFilters) {
    setCategoryFilters(changes.categoryFilters.newValue ?? null);
  }
});

// ---------------------------------------------------------------------------
// Native messaging host (child agent) — signed snapshot in, access requests out
// ---------------------------------------------------------------------------
//
// Safari routes native messaging through the containing app's
// SafariWebExtensionHandler. Connection reliability across service-worker
// unloads is an OPEN QUESTION (B4/B5): we reconnect on demand and also rely on
// storage as the durable cache. In production the native host verifies the
// Ed25519 signature on the DevicePolicySnapshot (ADR-010) before it is stored.

let nativePort = null;

function connectNative() {
  try {
    nativePort = browser.runtime.connectNative("com.example.youtubeguard.host");
    nativePort.onMessage.addListener(async (msg) => {
      if (msg?.type === "POLICY_SNAPSHOT" && msg.snapshot) {
        // Fail closed: verify the Ed25519 signature before trusting a snapshot
        // from the native host (a local process could otherwise inject an
        // allow-all policy). Same check as the backend path in backend-client.js.
        const cfg = await getConfig();
        if (!cfg.signingKeyB64 || !(await verifySnapshotSignature(msg.snapshot, cfg.signingKeyB64))) {
          console.warn("[guard] rejected native snapshot: missing key or bad signature");
          return;
        }
        await browser.storage.local.set({ [STORAGE_KEY]: msg.snapshot });
        snapshot = msg.snapshot;
      }
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null; // let the next send lazily reconnect
    });
  } catch (e) {
    console.warn("[guard] native host unavailable:", e);
    nativePort = null;
  }
}

/** Round-trip a blocked canonical id to the app/backend as an AccessRequest (B2). */
function sendAccessRequest(req) {
  if (!nativePort) connectNative();
  try {
    nativePort?.postMessage({ type: "ACCESS_REQUEST", request: req });
  } catch (e) {
    console.warn("[guard] failed to send access request:", e);
  }
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
  const h = (host || "").replace(/^www\./i, "").toLowerCase();
  if (!h) return [];
  const parts = h.split("."); const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}
let CATEGORY_FILTERS = null;
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

/** Returns the matched policy key if `r` targets the request, else null. */
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
function evaluate(snap, ctx) {
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
    for (const c of categoriesForHost(snap.categories, h)) hostCats.add(c);
    for (const c of categoriesFromFilters(h)) hostCats.add(c);
  }

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
    if (hit) return { action: t.action, reason: `temporary:${t.grantKind}`, matchedKey: hit };
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
 * Fail-closed for YouTube when we have no snapshot (a missing policy must not
 * silently open YouTube); non-YouTube URLs are never touched by this extension.
 */
function decide(url) {
  const yt = normalizeYouTube(url);
  if (!yt.isYouTube) return { blocked: false }; // never gate non-YouTube (never block Safari)

  if (!snapshot) {
    // Fail closed on the gated surface only.
    return { blocked: true, key: youTubePolicyKey(yt), reason: "no-policy:fail-closed" };
  }

  const ctx = {
    url,
    childId: snapshot.childId,
    deviceId: snapshot.deviceId,
    nowMs: Date.now(), // TODO(prod): monotonic/UTC-anchored per ADR-009
  };
  const res = evaluate(snapshot, ctx);
  return {
    blocked: res.action === "BLOCK",
    key: res.matchedKey || youTubePolicyKey(yt),
    reason: res.reason,
  };
}

function blockedPageUrl(originalUrl, key) {
  const u = new URL(browser.runtime.getURL(BLOCKED_PAGE));
  u.searchParams.set("u", originalUrl);
  if (key) u.searchParams.set("k", key);
  return u.toString();
}

// Full navigations (top frame). SPA route changes come via content.js below.
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level only for redirects
  if (!snapshot) await loadSnapshot();
  const { blocked, key } = decide(details.url);
  if (blocked) {
    try {
      await browser.tabs.update(details.tabId, { url: blockedPageUrl(details.url, key) });
    } catch (e) {
      console.warn("[guard] redirect failed:", e);
    }
  }
});

// ---------------------------------------------------------------------------
// Messages from content.js (SPA route changes, B3) and blocked.html (B2)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!snapshot) await loadSnapshot();

  if (msg?.type === "EVALUATE_URL") {
    // content.js observed an in-page (pushState/replaceState/popstate) route
    // change that never hit the network. Re-evaluate and tell it to redirect.
    const { blocked, key } = decide(msg.url);
    if (blocked && sender.tab?.id != null) {
      try {
        await browser.tabs.update(sender.tab.id, { url: blockedPageUrl(msg.url, key) });
      } catch (e) {
        console.warn("[guard] SPA redirect failed:", e);
      }
    }
    return { blocked };
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
    // Native-host mode: hand the blocked canonical id to the app/backend bridge.
    sendAccessRequest({
      canonicalKey: key, url: msg.url, reason: msg.reason || "",
      childId: snapshot?.childId, deviceId: snapshot?.deviceId, requestedAt: new Date().toISOString(),
    });
    return { ok: true };
  }
});

// Prime the cache and select the policy source on worker start.
loadSnapshot();
getConfig().then((cfg) => {
  if (cfg.backendUrl && cfg.deviceToken) {
    BACKEND_MODE = true;
    // backend-client verifies each snapshot's Ed25519 signature before calling us.
    startPolicySync(async (snap) => {
      snapshot = snap;
      await browser.storage.local.set({ [STORAGE_KEY]: snap });
    });
    startCategoryFilterSync(async (set) => {
      setCategoryFilters(set);
      await browser.storage.local.set({ categoryFilters: set });
    });
  } else {
    connectNative();
  }
});
