/**
 * Block-page controller (PoC C).
 *
 * Reads the blocked URL + reason from the query string that background.js put on
 * the redirect (blocked.html?u=<enc>&reason=<enc>&key=<enc>), shows a friendly
 * human label (the raw URL hides behind Details — UX_PRINCIPLES §4), and on
 * "Ask to unlock" posts the blocked canonical id to the service via the
 * background worker's native-messaging connection.
 *
 * The ask is optimistic: the button flips to "Asked ✓" the instant it's tapped
 * and reconciles in the background (§1), so the child never watches a spinner
 * decide whether asking "worked".
 */

const params = new URLSearchParams(location.search);
const blockedUrl = params.get("u") || "";
const reason = params.get("reason") || "";
const key = params.get("key") || "";

// Why it's closed (kept honest, situation-focused, never a verdict on the child).
const REASON_COPY = {
  "default:youtube": "YouTube is set to open only approved videos.",
  "default:web": "This site isn't on the open list yet.",
  "rule:YOUTUBE_VIDEO": "This video isn't open yet.",
  "rule:YOUTUBE_CHANNEL": "This channel isn't open yet.",
  "rule:YOUTUBE_PLAYLIST": "This playlist isn't open yet.",
  "rule:DOMAIN": "This site isn't open yet.",
  "rule:URL": "This page isn't open yet.",
  "failclosed:no-snapshot": "Wren is still starting up. Try again in a moment.",
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

document.getElementById("resource").textContent = humanLabel();
document.getElementById("target").textContent = blockedUrl || "(unknown)";
if (!blockedUrl) document.getElementById("details").style.display = "none";
const lede = document.getElementById("lede");
if (REASON_COPY[reason]) lede.textContent = `${REASON_COPY[reason]} Send a quick ask and a parent can open just this.`;

const statusEl = document.getElementById("status");
const btn = document.getElementById("request");

document.getElementById("back").addEventListener("click", () => {
  history.length > 1 ? history.back() : window.close();
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : "status";
}

btn.addEventListener("click", () => {
  // Optimistic: show success immediately, reconcile in the background (§1).
  btn.disabled = true;
  btn.textContent = "Asked ✓";
  setStatus("Asked ✓ — this page opens by itself if a parent says yes.", "ok");

  chrome.runtime.sendMessage(
    {
      type: "requestAccess",
      url: blockedUrl,
      key: key || null,
      userReason: document.getElementById("note").value || null,
    },
    (resp) => {
      if (!(resp && resp.ok)) {
        // Reconcile to a non-dead-end error with an inline retry (§2/§8).
        btn.disabled = false;
        btn.textContent = "Try again";
        setStatus("⚠ Couldn't send — tap Try again.", "err");
      }
    },
  );
});
