/**
 * ajar — device setup page (macOS Safari Web Extension).
 *
 * Connects Safari to a family's ajar account with a one-time code from the
 * parent console, and gates the destructive half of the page behind a parent
 * setup word. See the long comment on the parent lock below for exactly what
 * that gate does and does not protect against.
 */
import { enroll, getConfig, clearConfig } from "./backend-client.js";

const ext = globalThis.browser ?? globalThis.chrome;
/** Policy caches this extension writes; wiped on disconnect. */
const clearLocalPolicy = () =>
  ext.storage.local.remove(["devicePolicySnapshot", "categoryFilters", "ajarAsks"]);

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Parent lock.
//
// WHY: this page is reachable by the child (chrome://extensions → Details →
// Extension options, or by typing the chrome-extension:// URL). Before this
// change it let anyone disconnect the browser and re-connect it to a server
// they control — signature verification proves "this came from the server I am
// configured to trust", and the child chose which server that is. That is a
// total bypass with no admin rights and no file editing.
//
// WHAT THIS BUYS: the destructive actions (Disconnect, and therefore any change
// of server address, because the form only appears while disconnected) now need
// a word a parent set at connect time. It is verified against a PBKDF2-SHA-256
// hash, never a stored plaintext, and the word never leaves this device.
//
// WHAT IT DOES NOT BUY — read this before believing the page is locked:
//
//   1. The hash lives in extension storage, which the child can READ and CLEAR
//      from the devtools console of any extension page. Clearing it removes the
//      gate (the page then falls back to "no word was saved"). A page cannot
//      defend against a debugger attached to itself.
//   2. The child can disable or remove the extension entirely from the browser's
//      extensions screen. Nothing in this page changes that.
//   3. Because the hash is readable, a short word is open to an offline guessing
//      attack. 210k PBKDF2 iterations makes that slow, not impossible.
//
// The only real fixes are outside this file and outside this engineer's
// ownership: ship production builds with `options_ui` removed (or behind a build
// flag); pin the backend origin and signing key IN THE BUNDLE rather than in
// child-writable storage; and have the backend flag + notify on an unexpected
// unenroll. Tracked as redteam C2. This page implements the part a page can.
// ---------------------------------------------------------------------------
const LOCK_KEY = "ajarParentLock";
const PBKDF2_ITERATIONS = 210000;

const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(word, saltBytes, iterations) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(word), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, material, 256);
  return b64(bits);
}
async function setParentLock(word) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(word, salt, PBKDF2_ITERATIONS);
  await ext.storage.local.set({
    [LOCK_KEY]: { v: 1, salt: b64(salt), iterations: PBKDF2_ITERATIONS, hash },
  });
}
async function getParentLock() {
  try { return (await ext.storage.local.get(LOCK_KEY))[LOCK_KEY] || null; }
  catch { return null; }
}
async function checkParentLock(word) {
  const lock = await getParentLock();
  if (!lock) return null;                       // nothing to check against
  const got = await derive(word, unb64(lock.salt), lock.iterations || PBKDF2_ITERATIONS);
  // Constant-time-ish compare. Both strings are fixed-length base64 of 32 bytes.
  if (got.length !== lock.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ lock.hash.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Status. The panel carries a word and an icon, never a pale colour alone, and
// lives in a live region so a screen reader hears the result (SC 4.1.3).
// ---------------------------------------------------------------------------
function showStatus(msg, kind) {
  const el = $("status");
  el.hidden = false;
  el.textContent = msg;
  el.className = `panel panel-${kind}`;   // ok | err | info
}
function clearStatus() { $("status").hidden = true; $("status").textContent = ""; }

/** Errors that say what to do next, not a raw transport string (SC 3.3.3). */
function friendlyEnrollError(err) {
  const raw = String(err && err.message ? err.message : err);
  if (/\b(400|404|410)\b/.test(raw) || /not_found|expired|invalid/i.test(raw)) {
    return "That code didn't work. Check the 8 characters against the parent's screen — codes stop working a few minutes after they're made, so ask for a fresh one if it's been a while.";
  }
  if (/\b(401|403)\b/.test(raw)) {
    return "That code has already been used. Ask a parent for a new one.";
  }
  return "Couldn't reach the ajar server. Check this device is online, then press Connect again.";
}

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

async function render() {
  const cfg = await getConfig();
  const enrolled = !!(cfg.backendUrl && cfg.deviceToken);
  $("enrolled").hidden = !enrolled;
  $("form").hidden = enrolled;
  if (enrolled) {
    $("deviceId").textContent = cfg.deviceId ?? "";
    $("childId").textContent = cfg.childId ?? "";
    $("curUrl").textContent = cfg.backendUrl ?? "";
    const lock = await getParentLock();
    $("lockSet").hidden = !lock;
    $("lockMissing").hidden = !!lock;
  }
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("form").querySelector('button[type="submit"]');
  const backendUrl = $("backendUrl").value.replace(/\/+$/, "");
  const name = $("name").value.trim();
  const word = $("parentWord").value;

  // Normalise before validating: a parent retyping from another screen will
  // paste spaces and lowercase, and the real alphabet excludes I O L 0 1.
  const code = $("code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  $("code").value = code;

  $("code").removeAttribute("aria-invalid");
  $("parentWord").removeAttribute("aria-invalid");

  if (!CODE_RE.test(code)) {
    $("code").setAttribute("aria-invalid", "true");
    $("code").focus();
    showStatus("That code doesn't look right. It's 8 letters and numbers, and it never uses I, O, L, 0 or 1. Check it against the parent's screen.", "err");
    return;
  }
  if (word.length < 6) {
    $("parentWord").setAttribute("aria-invalid", "true");
    $("parentWord").focus();
    showStatus("Pick a parent setup word of at least 6 characters. You'll need it to disconnect this browser later.", "err");
    return;
  }

  submit.dataset.busy = "1";
  submit.setAttribute("aria-disabled", "true");
  showStatus("Connecting this browser…", "info");
  try {
    const device = await enroll(backendUrl, code, name);
    await setParentLock(word);
    $("parentWord").value = "";
    $("code").value = "";
    showStatus(`This browser is linked to ${device.displayName}'s ajar.`, "ok");
    await render();
  } catch (err) {
    showStatus(friendlyEnrollError(err), "err");
    $("code").setAttribute("aria-invalid", "true");
    $("code").focus();
  } finally {
    delete submit.dataset.busy;
    submit.removeAttribute("aria-disabled");
  }
});

$("unenroll").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const lock = await getParentLock();

  if (lock) {
    const word = $("unlockWord").value;
    $("unlockWord").removeAttribute("aria-invalid");
    if (!word) {
      $("unlockWord").setAttribute("aria-invalid", "true");
      $("unlockWord").focus();
      showStatus("Type the parent setup word to disconnect this browser.", "err");
      return;
    }
    btn.dataset.busy = "1";
    btn.setAttribute("aria-disabled", "true");
    const okWord = await checkParentLock(word);
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
    if (!okWord) {
      $("unlockWord").setAttribute("aria-invalid", "true");
      $("unlockWord").focus();
      showStatus("That isn't the setup word. Ask a parent.", "err");
      return;
    }
    $("unlockWord").value = "";
  }

  if (!confirm("Disconnect this browser from ajar?\n\nIt stops filtering here until it's connected again.")) return;

  clearStatus();
  await clearConfig();
  await clearLocalPolicy();
  await ext.storage.local.remove(LOCK_KEY);
  await render();
  showStatus("Unlinked. ajar is no longer filtering this browser.", "ok");
});

render();
