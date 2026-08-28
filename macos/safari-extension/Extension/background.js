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
import { getConfig, startPolicySync, postAccessRequest } from "./backend-client.js";

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
    const got = await browser.storage.local.get(STORAGE_KEY);
    snapshot = got?.[STORAGE_KEY] ?? null;
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
        // TODO(prod): verify msg.snapshot.signature before trusting it.
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

/** Returns the matched policy key if `r` targets the request, else null. */
function matchTarget(r, ctx, yt, host) {
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
      return host && (host === r.value || host.endsWith(`.${r.value}`)) ? `DOMAIN:${r.value}` : null;
    // APPLICATION / CATEGORY are not decided on-path in the extension.
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
    const hit = matchTarget(t, ctx, yt, host);
    if (hit) return { action: t.action, reason: `temporary:${t.grantKind}`, matchedKey: hit };
  }

  const tierOrder = [
    "URL",
    "YOUTUBE_VIDEO",
    "YOUTUBE_PLAYLIST",
    "YOUTUBE_CHANNEL",
    "URL_PATTERN",
    "DOMAIN",
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
      const hit = matchTarget(r, ctx, yt, host);
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
  } else {
    connectNative();
  }
});
