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
import { getConfig, getVerifyingKey, startPolicySync, startCategoryFilterSync, postAccessRequest, consumeGrant, getAnswers } from "./backend-client.js";
import { verifySnapshotSignature, verifyCanonicalSignature } from "./policy-verify.js";
import { makeResolver } from "./cname-resolve.js";

// On-device CNAME resolver (anti-cloaking); async + cached, read synchronously.
const CNAME = makeResolver();

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
    const got = await browser.storage.local.get([STORAGE_KEY, "categoryFilters"]);
    const key = await getVerifyingKey();

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
    // Fail closed for YouTube gating if we can't read policy (see evaluate()).
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
        const key = await getVerifyingKey();
        if (!key || !(await verifySnapshotSignature(msg.snapshot, key))) {
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
const SAFETY_FLOOR_DOMAINS = ["988lifeline.org","suicidepreventionlifeline.org","crisistextline.org",
  "befrienders.org","findahelpline.com","samaritans.org","papyrus-uk.org","thetrevorproject.org",
  "childline.org.uk","kidshelpphone.ca","childhelphotline.org","youthline.co.nz","rainn.org",
  "thehotline.org","childhelp.org","humantraffickinghotline.org","who.int","cdc.gov","samhsa.gov","nhs.uk"];
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
  for (const h of hosts) if (isSafetyFloorHost(h)) return { action: "ALLOW", reason: "safety-floor", matchedKey: `SAFETY:${h}` };

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

  if (!snapshot) {
    return yt.isYouTube
      ? { blocked: true, key: youTubePolicyKey(yt), reason: "no-policy:fail-closed" }
      : { blocked: false, reason: "no-policy:fail-open" };
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
  const res = evaluate(view, ctx);
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

// ---------------------------------------------------------------------------
// Messages from content.js (SPA route changes, B3) and blocked.html (B2)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!snapshot) await restoreCachedPolicy();

  if (msg?.type === "EVALUATE_URL") {
    // content.js observed an in-page (pushState/replaceState/popstate) route
    // change that never hit the network. Re-evaluate and tell it to redirect.
    // A pushState route change is a real load as far as a parent is concerned,
    // even though no network navigation fired.
    const res = decide(msg.url);
    const { blocked, key, reason } = res;
    if (!blocked) spendOnce(res);
    if (blocked && sender.tab?.id != null) {
      try {
        // Same three arguments as the navigation path above. An SPA route change
        // is a real load to a parent, so it must not be the one that arrives
        // without a reason.
        await browser.tabs.update(sender.tab.id, { url: blockedPageUrl(msg.url, key, reason) });
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
    connectNative();
  }
});
