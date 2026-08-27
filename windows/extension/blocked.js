/**
 * Block-page controller (PoC C).
 *
 * Reads the blocked URL + reason from the query string that background.js put on
 * the redirect (blocked.html?u=<enc>&reason=<enc>&key=<enc>), shows a friendly
 * reason, and on "Request Access" posts the blocked canonical id to the service
 * via the background worker's native-messaging connection.
 *
 * STUB: this posts { type: "requestAccess" } to the background worker, which
 * forwards it to the LocalSystem native-messaging host, which (Phase 1) signs it
 * and forwards to the backend AccessRequest workflow (ARCHITECTURE.md §7). The
 * native host + backend leg is not implemented in this PoC.
 */

const params = new URLSearchParams(location.search);
const blockedUrl = params.get("u") || "";
const reason = params.get("reason") || "";
const key = params.get("key") || "";

const REASON_COPY = {
  "default:youtube": "YouTube is set to allow only approved videos.",
  "default:web": "This site isn't on the allowed list.",
  "rule:YOUTUBE_VIDEO": "This specific video is blocked.",
  "rule:YOUTUBE_CHANNEL": "This channel is blocked.",
  "rule:YOUTUBE_PLAYLIST": "This playlist is blocked.",
  "rule:DOMAIN": "This website is blocked.",
  "rule:URL": "This exact page is blocked.",
  "failclosed:no-snapshot": "Filtering is still starting up. Try again in a moment.",
};

document.getElementById("target").textContent = blockedUrl || "(unknown)";
const reasonEl = document.getElementById("reason");
reasonEl.textContent = REASON_COPY[reason] || (key ? `Blocked: ${key}` : "");

const statusEl = document.getElementById("status");

document.getElementById("back").addEventListener("click", () => {
  history.length > 1 ? history.back() : window.close();
});

document.getElementById("request").addEventListener("click", () => {
  const btn = document.getElementById("request");
  btn.disabled = true;
  statusEl.textContent = "Sending request…";
  statusEl.className = "status";

  chrome.runtime.sendMessage(
    {
      type: "requestAccess",
      url: blockedUrl,
      key: key || null,
      userReason: document.getElementById("note").value || null,
    },
    (resp) => {
      if (resp && resp.ok) {
        statusEl.textContent = "Request sent. A parent will be notified.";
        statusEl.className = "status ok";
      } else {
        btn.disabled = false;
        statusEl.textContent =
          "Couldn't send the request (the filter service may be unreachable). Try again.";
        statusEl.className = "status err";
      }
    },
  );
});
