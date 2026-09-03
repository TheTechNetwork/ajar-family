/*
 * Block-page logic. EXTRACTED FROM blocked.html, and it has to stay extracted.
 *
 * MV3's default extension-page CSP is `script-src 'self'`, which forbids inline
 * <script>. This code used to live inside blocked.html, so the browser refused
 * to run ANY of it: the page rendered its static placeholders — the hard-coded
 * "A YouTube video" and a literal "…" where the URL goes — and "Ask to open it"
 * had no handler at all. The block page looked completely fine in a screenshot
 * and could not do the one thing it exists for, on every platform at once.
 *
 * options.html already did this correctly (`<script type="module" src=...>`),
 * which is the only reason its form worked while this page's button did not.
 */
/**
 * FOUR HONEST STATES: asking / asked (with how long ago) / approved / declined,
 * plus a non-terminal "couldn't send" that always offers a retry.
 *
 * This screen does NOT claim the page opens by itself — nothing in
 * background.js re-navigates a parked tab when a new snapshot lands. When the
 * answer arrives we show a real "Open it" button instead of a promise.
 *
 * The snapshot matching is DISPLAY ONLY and deliberately narrower than the
 * enforcement matcher: explicit rules on this exact target, nothing else.
 * When it cannot tell, the screen stays on "waiting" rather than guessing.
 */
const ext = globalThis.browser ?? globalThis.chrome;
const SNAP_KEY = "devicePolicySnapshot";
const ASKS_KEY = "ajarAsks";

const params = new URLSearchParams(location.search);
const originalUrl = params.get("u") || "";
const canonicalKey = params.get("k") || "";
const blockReason = params.get("reason") || "";
// Where they were. A HOST, reduced by the background worker before it ever
// reached this address bar. Passed straight back so the parent's console can
// show it; nothing on this page or the server decides anything with it.
const fromHost = params.get("from") || "";
const askKey = canonicalKey || (originalUrl ? `URL:${originalUrl}` : "");

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const requestBtn = $("requestBtn");
const backBtn = $("backBtn");
const openBtn = $("openBtn");
const reasonEl = $("reason");

// Human label is the hero; the raw key/URL live behind Details (UX §4).
//
// DOMAIN and URL were missing and the fallback was the literal string "This
// video", so a blocked news site announced itself as "This video" in 18px
// semibold — the largest text on the screen, wrong, for every block that was
// not YouTube. The Windows copy has covered all five and fallen back to the
// hostname since it was written; this is that table, not a new one.
const NOUN = {
  YOUTUBE_VIDEO: "A YouTube video",
  YOUTUBE_CHANNEL: "A YouTube channel",
  YOUTUBE_PLAYLIST: "A YouTube playlist",
  DOMAIN: "A website",
  URL: "A web page",
};
function humanLabel() {
  const type = (canonicalKey.split(":")[0] || "").toUpperCase();
  if (NOUN[type]) return NOUN[type];
  // The hostname beats a guess: it is what the child typed, and it is never
  // wrong about what they were looking at.
  try { return new URL(originalUrl).hostname || "This page"; } catch { return "This page"; }
}

// WHY it is closed. UX_PRINCIPLES §9 singles this line out for reducing the
// threat-to-freedom that drives circumvention — a rule with a reason reads
// as a rule; a rule without one reads as an obstacle. Windows has had this
// since it was written and macOS had no equivalent at all, so the Mac page
// never said why.
const REASON_COPY = {
  "default:youtube": "A parent keeps YouTube opt-in, video by video.",
  "default:web": "New sites go past a parent first.",
  "rule:YOUTUBE_VIDEO": "This video hasn't been opened yet.",
  "rule:YOUTUBE_CHANNEL": "This channel hasn't been opened yet.",
  "rule:YOUTUBE_PLAYLIST": "This playlist hasn't been opened yet.",
  "rule:DOMAIN": "This site hasn't been opened yet.",
  "rule:URL": "This page hasn't been opened yet.",
  // Both spellings: `background.js` here emits `no-policy:fail-closed`, the
  // Windows agent emits `failclosed:no-snapshot`. A table that only knew one
  // of them would silently say nothing on the surface it was written for.
  "no-policy:fail-closed": "Ajar is still waking up. Give it a few seconds, then reload.",
  "failclosed:no-snapshot": "Ajar is still waking up. Give it a few seconds, then reload.",
};

$("humanLine").textContent = humanLabel();
$("urlLine").textContent = originalUrl || "(no URL)";
if (REASON_COPY[blockReason] && $("lede")) {
  $("lede").textContent = `${REASON_COPY[blockReason]} Send it over and a parent sees it right away.`;
}

// Windows guards this; macOS used to call history.back() bare, which is a
// silent no-op when the block page is the tab's first entry.
backBtn.addEventListener("click", () => {
  if (history.length > 1) history.back(); else window.close();
});

/** Icon + word + colour class — never colour alone (SC 1.4.1). */
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind ? `status status-${kind}` : "status";
}

async function readAsks() {
  try { return (await ext.storage.local.get(ASKS_KEY))[ASKS_KEY] || {}; }
  catch { return {}; }
}
async function recordAsk() {
  if (!askKey) return;
  const asks = await readAsks();
  asks[askKey] = { at: new Date().toISOString(), url: originalUrl };
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(asks)) {
    if (Date.parse(asks[k] && asks[k].at || "") < cutoff) delete asks[k];
  }
  try { await ext.storage.local.set({ [ASKS_KEY]: asks }); } catch { /* best effort */ }
}
async function readSnapshot() {
  try { return (await ext.storage.local.get(SNAP_KEY))[SNAP_KEY] || null; }
  catch { return null; }
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return "a while back";
}

function youTubeIdFrom(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (!h.endsWith("youtube.com")) return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
function hostFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}
function ruleHitsThisPage(rule) {
  const value = String(rule.value == null ? "" : rule.value);
  switch (rule.target) {
    case "URL":
      return !!originalUrl && value === originalUrl;
    case "YOUTUBE_VIDEO": {
      const id = youTubeIdFrom(originalUrl) ||
        (canonicalKey.startsWith("YOUTUBE_VIDEO:") ? canonicalKey.slice(14) : null);
      return !!id && value === id;
    }
    case "DOMAIN": {
      const host = hostFrom(originalUrl);
      const v = value.replace(/^www\./, "").toLowerCase();
      return !!host && (host === v || host.endsWith(`.${v}`));
    }
    default:
      return false; // channel/playlist/category need the real matcher
  }
}
function answerIn(snapshot, askedMs) {
  if (!snapshot) return null;
  const nowMs = Date.now();
  for (const t of (snapshot.temporaryRules || [])) {
    if (Date.parse(t.expiresAt) <= nowMs) continue;
    if (ruleHitsThisPage(t)) return t.action === "ALLOW" ? "approved" : "declined";
  }
  for (const r of (snapshot.rules || [])) {
    if (!ruleHitsThisPage(r)) continue;
    if (r.action === "ALLOW") return "approved";
    // A standing BLOCK older than the ask is why the page was closed at all;
    // only one created after the ask is an ANSWER to it.
    if (Date.parse(r.createdAt) >= askedMs - 2000) return "declined";
  }
  return null;
}

// `disabled` drops a focused button out of the a11y tree and orphans focus
// on <body>; `aria-disabled` + a guard behaves the same and keeps the
// keyboard where the child left it (SC 2.4.3).
let mode = "idle";
let askedAtIso = null;
let askedAtMs = 0;

function showAsking() {
  mode = "asking";
  requestBtn.setAttribute("aria-disabled", "true");
  requestBtn.dataset.busy = "1";
  setStatus("Sending…", "info");
}
/**
 * How long this page may keep claiming a parent has not answered.
 *
 * A "Not now" writes a temporary BLOCK grant that expires after
 * ONCE_GRANT_TTL_MS — five minutes (backend/src/domain/services.ts) — and
 * `answerIn` can only see a rule while it is LIVE, because the backend
 * drops expired temporary rules from the snapshot before signing one. So a
 * refused child saw "declined" for five minutes at most and then this page
 * silently went back to "Waiting on a parent", for up to the seven days the
 * ask is remembered.
 *
 * That is the worst thing this screen can do: a child who was told no is
 * left believing nobody looked, which is the exact state the design exists
 * to prevent. The real fix is for the device to be told the DECISION rather
 * than infer it from a rule that happens to still exist (docs/UX_PLAN.md,
 * "the device is never told the decision"). Until then the page stops
 * asserting what it cannot know.
 */
const WAITING_CLAIM_MS = 10 * 60 * 1000;

function showAsked(atIso) {
  mode = "asked";
  askedAtIso = atIso;
  askedAtMs = Date.parse(atIso) || Date.now();
  delete requestBtn.dataset.busy;
  requestBtn.setAttribute("aria-disabled", "true");
  requestBtn.textContent = "Asked";
  openBtn.classList.add("hide");
  $("askBox").classList.add("hide");
  $("askedNote").classList.remove("hide");
  renderAskedNote();
}

/** The asked state's two sentences, which change once we can no longer
 *  claim a parent has not answered. On a timer as well as on entry. */
function renderAskedNote() {
  if (mode !== "asked" || !askedAtIso) return;
  if (Date.now() - askedAtMs > WAITING_CLAIM_MS) {
    // True whichever actually happened — approved, refused, or not yet
    // looked at. Opening the page again puts the question to the filter,
    // which is the only thing whose answer is authoritative.
    $("askedNote").textContent =
      `You asked ${ago(askedAtIso)}. If a parent has answered, opening the page again will show it.`;
    setStatus("Sent. No answer here yet.", "wait");
    requestBtn.removeAttribute("aria-disabled");
    requestBtn.textContent = "Ask again";
  } else {
    $("askedNote").textContent =
      `You asked ${ago(askedAtIso)}. Nothing else to do — you can leave this page open or come back to it.`;
    setStatus("✓ Sent. Waiting on a parent.", "wait");
  }
}
function showApproved() {
  if (mode === "approved") return;
  mode = "approved";
  delete requestBtn.dataset.busy;
  requestBtn.classList.add("hide");
  $("askBox").classList.add("hide");
  $("askedNote").classList.add("hide");
  openBtn.classList.remove("hide");
  $("head").textContent = "You're in";
  $("lede").textContent = "A parent said yes. It may close again later on its own.";
  setStatus("✓ Open. Press Open it to go there.", "done");
  openBtn.focus();
}
function showDeclined() {
  if (mode === "declined") return;
  mode = "declined";
  delete requestBtn.dataset.busy;
  requestBtn.removeAttribute("aria-disabled");
  requestBtn.textContent = "Ask again";
  requestBtn.classList.remove("btn-primary");
  openBtn.classList.add("hide");
  $("askBox").classList.remove("hide");
  $("askedNote").classList.add("hide");
  $("head").textContent = "Not this one";
  $("lede").textContent =
    "A parent said not this time. You can ask again with a note, or go ask them in person.";
  // An answer, not a fault — muted, never the error colour.
  setStatus("Answered — not this one.", "info");
}
function showSendFailed() {
  mode = "idle";
  delete requestBtn.dataset.busy;
  requestBtn.removeAttribute("aria-disabled");
  requestBtn.textContent = "Try again";
  $("askBox").classList.remove("hide");
  $("askedNote").classList.add("hide");
  setStatus("⚠ Couldn't send. Check the wi-fi, then press Try again.", "err");
  requestBtn.focus();
}

openBtn.addEventListener("click", () => {
  if (originalUrl) location.replace(originalUrl);
});

requestBtn.addEventListener("click", async () => {
  if (requestBtn.getAttribute("aria-disabled") === "true") return;
  showAsking();

  // Hand the blocked canonical id to the background worker, which forwards
  // it to the native messaging host / child agent, which posts the
  // AccessRequest to the backend. This keeps the request on the trusted,
  // signed channel rather than the page making its own call. There is no
  // fallback POST: the old one fired at a non-existent host on every ask and
  // could only add latency to the failure path.
  let delivered = false;
  try {
    if (ext && ext.runtime && ext.runtime.sendMessage) {
      // A background worker that never answers used to leave the child on
      // "Sending…" with no retry and no end — the ask silently lost, and no
      // way to tell that from a slow one. `sendMessage` returns a promise
      // that simply never settles when the worker is gone, so the timeout
      // has to race it rather than wrap it. Windows has guarded this since
      // it was written; the same 12 seconds, deliberately.
      const answered = ext.runtime.sendMessage({
        type: "REQUEST_ACCESS",
        from: fromHost,
        key: canonicalKey,
        url: originalUrl,
        reason: reasonEl.value.trim(),
      });
      const timedOut = Symbol("timeout");
      const res = await Promise.race([
        answered,
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 12000)),
      ]);
      // A late answer is ignored rather than believed: by then the page is
      // already showing a retry, and flipping it to "Asked" underneath a
      // child who is mid-tap is worse than the honest failure.
      delivered = res !== timedOut && !!(res && res.ok);
    }
  } catch (e) {
    console.warn("[ajar] background message failed:", e);
  }

  if (delivered) {
    await recordAsk();
    showAsked(new Date().toISOString());
  } else {
    showSendFailed();
  }
});

/**
 * The parent's ANSWER, from the server, for the thing this page is about.
 *
 * Preferred over `answerIn` because it is the decision itself rather than an
 * inference from whether a rule happens to still exist. The inference stays
 * as the fallback: it needs no network, so it still works offline and in
 * native-host mode, and it paints an approval instantly from the cached
 * snapshot without waiting for a round trip.
 */
async function serverAnswer() {
  let answers;
  try {
    const timedOut = Symbol("timeout");
    const res = await Promise.race([
      ext.runtime.sendMessage({ type: "GET_ANSWERS" }),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 12000)),
    ]);
    if (res === timedOut || !res || !res.ok || !Array.isArray(res.answers)) return null;
    answers = res.answers;
  } catch { return null; }

  // Match on the canonical target the ask was filed under. `canonicalKey` is
  // what this page was redirected with; the URL is the fallback for a
  // non-YouTube block, which is filed as URL:<the exact string>.
  const keyType = canonicalKey ? canonicalKey.split(":")[0] : null;
  const keyValue = canonicalKey ? canonicalKey.slice(canonicalKey.indexOf(":") + 1) : null;
  const mine = answers.filter((a) =>
    (keyType && a.targetType === keyType && a.targetValue === keyValue) ||
    (a.targetType === "URL" && originalUrl && a.targetValue === originalUrl));
  if (!mine.length) return null;

  // Newest wins: a child who asked, was refused, and asked again should see
  // the second answer, not the first.
  mine.sort((a, b) => Date.parse(b.askedAt || 0) - Date.parse(a.askedAt || 0));
  return mine[0].answer === "opened" ? "approved" : "declined";
}

async function refreshFromSnapshot() {
  if (mode === "approved" || mode === "declined") return;

  // The snapshot first: already cached, so an approval paints without a
  // round trip. It can only ever say "approved" reliably — a refusal's grant
  // expires after five minutes and is then dropped, which is why the server
  // is asked below.
  const local = answerIn(await readSnapshot(), askedAtMs || Date.now());
  if (local === "approved") { showApproved(); return; }

  // Then the decision itself, which does not expire.
  const remote = await serverAnswer();
  if (remote === "approved") { showApproved(); return; }
  if (remote === "declined") { showDeclined(); return; }

  // Neither knows. Fall back to the local inference for the window where it
  // is still valid, so an offline device is no worse off than before.
  if (local === "declined" && askedAtMs) showDeclined();
}

(async function boot() {
  const asks = await readAsks();
  const prior = askKey ? asks[askKey] : null;
  if (prior && prior.at) showAsked(prior.at);
  await refreshFromSnapshot();

  try {
    ext.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SNAP_KEY]) refreshFromSnapshot();
    });
  } catch { /* no storage events here; the poll below still runs */ }

  setInterval(() => {
    renderAskedNote();
    refreshFromSnapshot();
  }, 20000);
})();
