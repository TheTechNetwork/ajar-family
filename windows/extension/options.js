/**
 * ajar — device setup page (Windows extension).
 *
 * Connects this browser to a family's ajar account with a one-time code from
 * the parent console, and gates the destructive half of the page behind a
 * parent setup word. See the long comment below for exactly what that gate does
 * and does not protect against.
 */
import { enroll, getConfig, clearConfig } from "./backend-client.js";
import {
  BUNDLED_BACKEND_URL, WORD_KEY, checkParentWord, clearTrustAnchor, decideUnenroll,
  hasParentWord, isDevMode, readTrustAnchor, setParentWord,
} from "./trust-anchor.js";

const ext = globalThis.chrome;
/** Policy caches this extension writes; wiped on disconnect. */
const clearLocalPolicy = () =>
  ext.storage.local.remove(["snapshot", "clockAnchor", "categoryFilters", "ajarAsks"]);

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Parent lock + pinned trust anchor.
//
// WHY: this page is reachable by the child (chrome://extensions → Details →
// Extension options, or by typing the chrome-extension:// URL). It used to let
// anyone disconnect the browser and re-connect it to a server they control —
// signature verification proves "this came from the server I am configured to
// trust", and the child chose which server that is. That is a total bypass with
// no admin rights and no file editing.
//
// WHAT THIS BUYS:
//   - Disconnect needs a word a parent set at connect time. It is checked
//     against a PBKDF2-SHA-256 hash, never a stored plaintext, and the word
//     never leaves this device.
//   - The signing key is PINNED at first enrollment and the pin OUTLIVES
//     Disconnect (trust-anchor.js). Re-connecting to the same address and key
//     is free; a different address or a different key needs the same word. So
//     wiping the device and re-enrolling against an allow-all server is no
//     longer a two-click path.
//   - The address itself is not typeable in a shipped build: it comes from the
//     bundle, and only dev mode reveals the field.
//
// WHAT IT DOES NOT BUY — read this before believing the page is locked:
//
//   1. The pin, the word hash and the dev flag all live in extension storage,
//      which the child can READ and WRITE from the devtools console of any
//      extension page. A page cannot defend against a debugger attached to
//      itself. Tampering there is now the cheapest bypass; it is a deliberate
//      act, which is the point, but it is not hard for someone who looks it up.
//   2. The child can disable or remove the extension entirely from the browser's
//      extensions screen. Nothing in this page changes that.
//   3. Because the hash is readable, a short word is open to an offline guessing
//      attack. 210k PBKDF2 iterations makes that slow, not impossible.
//
// The remaining fixes are outside this page: ship production builds with
// `options_ui` removed (or behind a build flag); carry the pin somewhere the
// browser profile cannot rewrite (the Windows service's registry policy); and
// have the backend flag + notify on an unexpected unenroll. Tracked as redteam
// C2 and written up in docs/SECURITY.md.
// ---------------------------------------------------------------------------

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
  // A refusal from the trust anchor already carries family-readable copy.
  if (err && err.name === "TrustError") return err.message;
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
  const pin = await readTrustAnchor();
  const wordSet = await hasParentWord();
  const dev = await isDevMode();
  const enrolled = !!(cfg.backendUrl && cfg.deviceToken);

  $("enrolled").hidden = !enrolled;
  $("form").hidden = enrolled;

  if (enrolled) {
    $("deviceId").textContent = cfg.deviceId ?? "";
    $("childId").textContent = cfg.childId ?? "";
    $("curUrl").textContent = cfg.backendUrl ?? "";
    $("anchorUrl").textContent = pin?.backendUrl ?? cfg.backendUrl ?? "";
    $("lockSet").hidden = !wordSet;
    $("lockMissing").hidden = wordSet;
    return;
  }

  // Connect form. The address is fixed to the pin (or the build) unless dev mode
  // is on, mirroring web/parent/app.js resolveBackendUrl().
  const address = pin?.backendUrl ?? BUNDLED_BACKEND_URL;
  $("serverField").hidden = !dev;
  $("fixedServer").hidden = dev;
  $("fixedUrl").textContent = address;
  $("backendUrl").value = address;

  $("pinnedNote").hidden = !pin;
  $("pinnedUrl").textContent = pin?.backendUrl ?? "";

  $("parentWord").setAttribute("autocomplete", wordSet ? "current-password" : "new-password");
  $("parentWordHelp").textContent = wordSet
    ? "The word a parent chose when this browser was first set up. Needed only to connect it to a different address than the one above."
    : "A parent picks this now, and needs it to disconnect this browser later. At least 6 characters. Do not tell the kid this browser is for.";
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("form").querySelector('button[type="submit"]');
  const backendUrl = $("backendUrl").value.replace(/\/+$/, "");
  const name = $("name").value.trim();
  const word = $("parentWord").value;
  const wordSet = await hasParentWord();

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
  // A word is CHOSEN on a first setup. On a later one the device already has a
  // word, and whether it is needed depends on the address — the trust anchor
  // decides that, not this form.
  if (!wordSet && word.length < 6) {
    $("parentWord").setAttribute("aria-invalid", "true");
    $("parentWord").focus();
    showStatus("Pick a parent setup word of at least 6 characters. You'll need it to disconnect this browser later.", "err");
    return;
  }

  submit.dataset.busy = "1";
  submit.setAttribute("aria-disabled", "true");
  showStatus("Connecting this browser…", "info");
  try {
    const device = await enroll(backendUrl, code, name, { parentWord: word });
    if (!wordSet) await setParentWord(word);   // first setup: remember the word
    $("parentWord").value = "";
    $("code").value = "";
    showStatus(`This browser is linked to ${device.displayName}'s ajar.`, "ok");
    await render();
  } catch (err) {
    showStatus(friendlyEnrollError(err), "err");
    const field = err && err.name === "TrustError" && err.reason === "needs-parent-word"
      ? "parentWord" : "code";
    $(field).setAttribute("aria-invalid", "true");
    $(field).focus();
  } finally {
    delete submit.dataset.busy;
    submit.removeAttribute("aria-disabled");
  }
});

$("unenroll").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const wordSet = await hasParentWord();

  let unlocked = false;
  if (wordSet) {
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
    unlocked = (await checkParentWord(word)) === true;
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
  }

  const decision = decideUnenroll({ hasWord: wordSet, unlocked });
  if (!decision.ok) {
    $("unlockWord").setAttribute("aria-invalid", "true");
    $("unlockWord").focus();
    showStatus("That isn't the setup word. Ask a parent.", "err");
    return;
  }
  $("unlockWord").value = "";

  if (!confirm("Disconnect this browser from ajar?\n\nIt stops filtering here until it's connected again.")) return;

  clearStatus();
  await clearConfig();
  await clearLocalPolicy();
  // The pin and the word deliberately SURVIVE this: disconnecting stops
  // enforcement here, it does not hand the next person the right to choose a new
  // server. The one exception is a device that never had a word — nothing could
  // authorise a later re-pin, so keeping it would only lock a parent out.
  if (decision.clearAnchor) {
    await clearTrustAnchor();
    await ext.storage.local.remove(WORD_KEY);
  }
  await render();
  showStatus("Unlinked. ajar is no longer filtering this browser.", "ok");
});

render();
