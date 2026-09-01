/**
 * Block-page controller.
 *
 * Reads the blocked URL + reason from the query string that background.js put on
 * the redirect (blocked.html?u=<enc>&reason=<enc>&key=<enc>), shows a friendly
 * human label (the raw URL hides behind Details — UX_PRINCIPLES §4), and on
 * "Ask to open it" posts the blocked canonical id to the service via the
 * background worker's native-messaging connection.
 *
 * FOUR HONEST STATES (docs/UX_PRINCIPLES.md §2, §9)
 *
 *   asking    the send is in flight
 *   asked     the send was ACKNOWLEDGED, with how long ago
 *   approved  a matching ALLOW appeared in the signed snapshot
 *   declined  a matching BLOCK appeared in the signed snapshot after the ask
 *
 * plus `couldn't send`, which is not a terminal state — it always offers a retry.
 *
 * Two things this file will not do, because the code behind it doesn't:
 *  - It never says the page "opens by itself". Nothing re-navigates a parked tab
 *    when a new snapshot lands (background.js has no such handler), so when the
 *    answer arrives we surface a real "Open it" button instead of a promise.
 *  - It never reports "Asked ✓" before the transport acknowledged the send.
 *
 * The snapshot matching below is for DISPLAY ONLY. It is deliberately narrower
 * than the enforcement matcher in background.js: it looks for an explicit rule on
 * this exact target and nothing else. When it cannot tell, the screen stays on
 * "waiting" — the honest answer — rather than guessing.
 */

const params = new URLSearchParams(location.search);
const blockedUrl = params.get("u") || "";
const reason = params.get("reason") || "";
const key = params.get("key") || "";

// Why it's closed. An agent, not a passive voice; no invisible "list"; and
// "yet", which marks the state as changeable rather than a verdict.
const REASON_COPY = {
  "default:youtube": "A parent keeps YouTube opt-in, video by video.",
  "default:web": "New sites go past a parent first.",
  "rule:YOUTUBE_VIDEO": "This video hasn't been opened yet.",
  "rule:YOUTUBE_CHANNEL": "This channel hasn't been opened yet.",
  "rule:YOUTUBE_PLAYLIST": "This playlist hasn't been opened yet.",
  "rule:DOMAIN": "This site hasn't been opened yet.",
  "rule:URL": "This page hasn't been opened yet.",
  "failclosed:no-snapshot": "Ajar is still waking up. Give it a few seconds, then reload.",
};

// Human noun for the hero label, derived from the canonical key prefix.
const NOUN = {
  YOUTUBE_VIDEO: "A YouTube video",
  YOUTUBE_CHANNEL: "A YouTube channel",
  YOUTUBE_PLAYLIST: "A YouTube playlist",
  DOMAIN: "A website",
  URL: "A web page",
};
function humanLabel() {
  const type = (key.split(":")[0] || "").toUpperCase();
  if (NOUN[type]) return NOUN[type];
  try { return new URL(blockedUrl).hostname || "This page"; } catch { return "This page"; }
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const btn = $("request");
const backBtn = $("back");
const openBtn = $("openIt");

$("resource").textContent = humanLabel();
$("target").textContent = blockedUrl || "(unknown)";
if (!blockedUrl) $("details").classList.add("hide");
if (REASON_COPY[reason]) {
  $("lede").textContent =
    `${REASON_COPY[reason]} Send it over and a parent sees it right away.`;
}

backBtn.addEventListener("click", () => {
  if (history.length > 1) history.back(); else window.close();
});

/** Status is icon + word + colour class — never colour alone (SC 1.4.1). */
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ? `status status-${kind}` : "status";
}

// ---------------------------------------------------------------------------
// Remembering the ask. Without this a reload resets the button to a virgin
// "Ask to open it" and files a duplicate, which the parent sees as spam.
// ---------------------------------------------------------------------------
const ASKS_KEY = "ajarAsks";
const askKey = key || (blockedUrl ? `URL:${blockedUrl}` : "");

function readAsks() {
  return new Promise((resolve) => {
    try { chrome.storage.local.get([ASKS_KEY], (v) => resolve((v && v[ASKS_KEY]) || {})); }
    catch { resolve({}); }
  });
}
async function recordAsk() {
  if (!askKey) return;
  const asks = await readAsks();
  asks[askKey] = { at: new Date().toISOString(), url: blockedUrl };
  // Keep the store small: drop anything older than a week.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(asks)) {
    if (Date.parse(asks[k]?.at || "") < cutoff) delete asks[k];
  }
  try { chrome.storage.local.set({ [ASKS_KEY]: asks }); } catch { /* best effort */ }
}
function readSnapshot() {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(["snapshot"], (v) => resolve((v && v.snapshot) || null)); }
    catch { resolve(null); }
  });
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return "a while back";
}

// ---------------------------------------------------------------------------
// Did an answer land? Display-only matching against the signed snapshot the
// background worker already caches. Explicit targets only — no defaults, no
// categories, no CNAME. If it doesn't match, we say "still waiting".
// ---------------------------------------------------------------------------
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
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function ruleHitsThisPage(rule) {
  const value = String(rule.value ?? "");
  switch (rule.target) {
    case "URL":
      return blockedUrl && value === blockedUrl;
    case "YOUTUBE_VIDEO": {
      const id = youTubeIdFrom(blockedUrl) || (key.startsWith("YOUTUBE_VIDEO:") ? key.slice(14) : null);
      return !!id && value === id;
    }
    case "DOMAIN": {
      const host = hostFrom(blockedUrl);
      const v = value.replace(/^www\./, "").toLowerCase();
      return !!host && (host === v || host.endsWith(`.${v}`));
    }
    default:
      return false; // channel/playlist/category need the real matcher; stay honest
  }
}

/** @returns {"approved"|"declined"|null} */
function answerIn(snapshot, askedAtMs) {
  if (!snapshot) return null;
  const nowMs = Date.now();
  const temps = (snapshot.temporaryRules || [])
    .filter((t) => Date.parse(t.expiresAt) > nowMs);
  for (const t of temps) {
    if (ruleHitsThisPage(t)) return t.action === "ALLOW" ? "approved" : "declined";
  }
  for (const r of snapshot.rules || []) {
    if (!ruleHitsThisPage(r)) continue;
    if (r.action === "ALLOW") return "approved";
    // A standing BLOCK that predates the ask is why the page was closed in the
    // first place — only one created after the ask is an ANSWER to it.
    if (Date.parse(r.createdAt) >= askedAtMs - 2000) return "declined";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering the states.
// `disabled` removes a focused button from the a11y tree and dumps focus on
// <body>; `aria-disabled` + an early-return guard gives the same "can't press
// twice" behaviour and keeps the keyboard where the child left it (SC 2.4.3).
// ---------------------------------------------------------------------------
let mode = "idle";
let askedAtIso = null;
let askedAtMs = 0;

function showAsking() {
  mode = "asking";
  btn.setAttribute("aria-disabled", "true");
  btn.dataset.busy = "1";
  setStatus("Sending…", "info");
}

/**
 * How long this page may keep claiming a parent has not answered.
 *
 * A "Not now" writes a temporary BLOCK grant that expires after
 * ONCE_GRANT_TTL_MS — five minutes (backend/src/domain/services.ts) — and
 * `answerIn` below can only see a rule while it is LIVE, because the backend
 * drops expired temporary rules from the snapshot before it signs one. So a
 * child who was told no saw "declined" for five minutes at most and then this
 * page silently went back to "Waiting on a parent" — for up to the seven days
 * the ask is remembered.
 *
 * That is the worst thing this screen can do. A child who was refused is left
 * believing nobody has looked at all, which is precisely the state the whole
 * design is built to avoid.
 *
 * The real fix is for the device to be told the DECISION rather than infer it
 * from a rule that happens to still exist — see docs/UX_PLAN.md, "the device is
 * never told the decision". Until then this page stops asserting what it cannot
 * know. Ten minutes: comfortably past the five-minute grant, short enough that
 * a child is not lied to for an afternoon.
 */
const WAITING_CLAIM_MS = 10 * 60 * 1000;

function showAsked(atIso) {
  mode = "asked";
  askedAtIso = atIso;
  askedAtMs = Date.parse(atIso) || Date.now();
  delete btn.dataset.busy;
  btn.setAttribute("aria-disabled", "true");
  btn.textContent = "Asked";
  openBtn.classList.add("hide");
  $("askBox").classList.add("hide");
  $("askedNote").classList.remove("hide");
  renderAskedNote();
}

/** The asked state's two sentences, which change once we stop being able to
 *  claim a parent has not answered. Called on a timer as well as on entry. */
function renderAskedNote() {
  if (mode !== "asked" || !askedAtIso) return;
  const stale = Date.now() - askedAtMs > WAITING_CLAIM_MS;
  if (stale) {
    // True on every branch: approved (the rule is there and reloading proves
    // it), refused (the grant has expired and left no trace here), or genuinely
    // not looked at yet. Trying the page again puts the question to the filter,
    // which is the only thing whose answer is authoritative.
    $("askedNote").textContent =
      `You asked ${ago(askedAtIso)}. If a parent has answered, opening the page again will show it.`;
    setStatus("Sent. No answer here yet.", "wait");
    btn.removeAttribute("aria-disabled");
    btn.textContent = "Ask again";
  } else {
    $("askedNote").textContent =
      `You asked ${ago(askedAtIso)}. Nothing else to do — you can leave this page open or come back to it.`;
    setStatus("✓ Sent. Waiting on a parent.", "wait");
  }
}

function showApproved() {
  if (mode === "approved") return;
  mode = "approved";
  delete btn.dataset.busy;
  btn.classList.add("hide");
  $("askBox").classList.add("hide");
  $("askedNote").classList.add("hide");
  openBtn.classList.remove("hide");
  $("head").textContent = "You're in";
  $("lede").textContent = "A parent said yes. It may close again later on its own.";
  setStatus("✓ Open. Tap Open it to go there.", "done");
  openBtn.focus();
}

function showDeclined() {
  if (mode === "declined") return;
  mode = "declined";
  delete btn.dataset.busy;
  btn.removeAttribute("aria-disabled");
  btn.textContent = "Ask again";
  btn.classList.remove("btn-primary");
  openBtn.classList.add("hide");
  $("askBox").classList.remove("hide");
  $("askedNote").classList.add("hide");
  $("head").textContent = "Not this one";
  $("lede").textContent = "A parent said not this time. You can ask again with a note, or go ask them in person.";
  // An answer, not a fault: --muted styling, never the error colour.
  setStatus("Answered — not this one.", "info");
}

function showSendFailed(retryable) {
  mode = "idle";
  delete btn.dataset.busy;
  btn.removeAttribute("aria-disabled");
  $("askBox").classList.remove("hide");
  $("askedNote").classList.add("hide");
  btn.textContent = retryable ? "Ask again" : "Try again";
  setStatus(retryable
    ? "⚠ Not sent yet. Ajar will keep trying — or press Ask again."
    : "⚠ Couldn't send. Check the wi-fi, then press Try again.", "err");
  btn.focus();   // put the keyboard back on the thing to press
}

openBtn.addEventListener("click", () => { if (blockedUrl) location.replace(blockedUrl); });

btn.addEventListener("click", () => {
  if (btn.getAttribute("aria-disabled") === "true") return;
  showAsking();

  let settled = false;
  const settle = (fn) => { if (!settled) { settled = true; fn(); } };

  try {
    chrome.runtime.sendMessage(
      {
        type: "requestAccess",
        url: blockedUrl,
        key: key || null,
        userReason: $("note").value || null,
      },
      (resp) => {
        // A dead worker resolves with `undefined` and sets chrome.runtime.lastError.
        if (chrome.runtime.lastError) return settle(() => showSendFailed(true));
        if (resp && resp.ok) {
          return settle(async () => { await recordAsk(); showAsked(new Date().toISOString()); });
        }
        settle(() => showSendFailed(!!(resp && resp.retryable)));
      },
    );
  } catch {
    settle(() => showSendFailed(true));
  }
  // Don't leave the child on "Sending…" forever if the worker never answers.
  setTimeout(() => settle(() => showSendFailed(true)), 12000);
});

// ---------------------------------------------------------------------------
// Boot: restore any earlier ask for this exact target, then watch the cached
// snapshot for the answer.
// ---------------------------------------------------------------------------
async function refreshFromSnapshot() {
  if (mode === "approved" || mode === "declined") return;
  const answer = answerIn(await readSnapshot(), askedAtMs || Date.now());
  if (answer === "approved") showApproved();
  else if (answer === "declined" && askedAtMs) showDeclined();
}

(async function boot() {
  const asks = await readAsks();
  const prior = askKey ? asks[askKey] : null;
  if (prior && prior.at) showAsked(prior.at);
  await refreshFromSnapshot();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.snapshot) refreshFromSnapshot();
    });
  } catch { /* no storage events available; the poll below still runs */ }

  // Belt and braces, and it keeps the "asked N min ago" line honest.
  setInterval(() => {
    renderAskedNote();
    refreshFromSnapshot();
  }, 20000);
})();
