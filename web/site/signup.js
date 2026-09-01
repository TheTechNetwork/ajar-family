/**
 * Ajar — parent signup. Account → family → first child → setup code.
 *
 * It writes the SAME localStorage keys the console reads (cf_access, cf_refresh,
 * cf_family), so "Go to your console" lands signed in. That only holds while both
 * pages are served from ONE origin — see web/site/README.md.
 *
 * Three rules, the same ones web/parent/app.js is written to:
 *   1. Never render success text the server has not confirmed.
 *   2. Never advance a step the server rejected.
 *   3. Never show a raw HTTP status to a parent.
 */
const $ = (id) => document.getElementById(id);

/**
 * Backend origin. Same-origin when the backend serves these pages, which is the
 * supported layout. The named hosts are the fallback for a site deployed apart
 * from the API; note that in THAT layout the console handoff below cannot work,
 * because localStorage is per-origin.
 */
const API = (() => {
  const q = new URLSearchParams(location.search).get("api");
  if (q && localStorage.getItem("cf_dev") === "1") return q.replace(/\/+$/, "");
  // Same origin, always — the Worker that serves this page also serves /v1.
  // This used to special-case *.ajar.family to https://api.ajar.family, written
  // when the site had no host of its own. That is now actively wrong: it would
  // send a cross-origin request (needing CORS to keep working) from a page whose
  // whole design is that there is only ever one origin. Matches
  // resolveBackendUrl() in web/parent/app.js, which the console already used.
  if (location.origin && location.origin !== "null") return location.origin;
  return "http://localhost:8787"; // file:// during local development only
})();

const state = { token: null, familyId: null, childId: null, childName: "", pendingEmail: "" };

function announce(msg) {
  const el = $("sr");
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; });
}

function showError(msg) {
  const el = $("err");
  el.textContent = msg;
  el.hidden = false;
  announce(msg);
  el.scrollIntoView({ block: "nearest" });
}
const clearError = () => { $("err").hidden = true; };

/**
 * One request. The server's own `error` string is shown when there is one: those
 * messages are written for parents ("that person is already in this family"), and
 * inventing a friendlier one here would hide what actually went wrong. A bare
 * status code never reaches the page.
 */
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && state.token) headers.authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Couldn't reach Ajar. Check your connection and try again.");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* fall through to the generic message */ }
  if (!res.ok) {
    if (res.status === 429) throw new Error("Too many tries just now. Wait a minute and try again.");
    throw new Error(data?.error || "Something went wrong. Please try again.");
  }
  return data;
}

/**
 * The flow, in order. `sCheck` is not in here because it is not a step the
 * parent DOES — it is waiting for an email — and giving it a dot would tell
 * them they are further along than they are.
 *
 * Indexed by position rather than by the number in the id, because "add a
 * passkey" was inserted in the middle and renumbering every panel id would have
 * been a much better way to introduce a bug than to avoid one.
 */
const PANELS = ["s1", "sKey", "s2", "s3", "s4", "s5"];
/** The last panel is the result, not a step, so it gets no dot of its own. */
const DOTS = PANELS.length - 1;

/** Move to a step: swap panels, light the dots, put focus where typing resumes. */
function step(id) {
  const n = PANELS.indexOf(id) + 1;
  for (const panelId of PANELS) {
    const panel = $(panelId);
    if (panel) panel.hidden = panelId !== id;
  }
  $("sCheck").hidden = true;
  const lit = Math.min(n, DOTS);
  for (let i = 1; i <= DOTS; i++) {
    const dot = $(`d${i}`);
    if (dot) dot.toggleAttribute("data-on", i <= lit);
  }
  // The dots in words. They are aria-hidden — five decorative bars announced one
  // by one are noise — which left a screen-reader user with no sense of position
  // at all in a five-step flow, the exact thing the dots exist to give.
  const status = $("stepStatus");
  if (status) status.textContent = `Step ${lit} of ${DOTS}`;
  clearError();
  const focusable = $(id)?.querySelector("input, select, button:not([hidden])");
  focusable?.focus();
}

/**
 * Guard every submit: block a double tap without becoming a double POST.
 *
 * `aria-disabled` plus a guard, NOT `disabled`. A disabled button loses focus,
 * and a screen-reader or keyboard user who submits with Return is dropped to the
 * top of the document mid-flow with no announcement of why — UX_PRINCIPLES §8
 * requirement 5. Both block pages and the console do it this way; only this
 * flow, the one every new parent walks through once, regressed.
 */
function submitting(form, on, label) {
  const btn = form.querySelector("button.primary");
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.dataset.busy = "1";
    btn.textContent = label;
    btn.setAttribute("aria-disabled", "true");
  } else {
    btn.textContent = btn.dataset.label ?? btn.textContent;
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
  }
}

function wire(form, busyLabel, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    submitting(form, true, busyLabel);
    announce(busyLabel);
    try {
      await handler();
    } catch (err) {
      showError(err.message);
    } finally {
      submitting(form, false);
    }
  });
}

/**
 * Ask the browser to remember the credential.
 *
 * The autocomplete attributes on the form are most of the story, but they rely
 * on the browser NOTICING a submission. This flow calls preventDefault() and
 * swaps panels in place, so there is no navigation for Chrome's save heuristic
 * to hang off — the account is created and the browser never asks. The
 * Credential Management API is the explicit way to say so from JS.
 *
 * Progressive enhancement on purpose: Safari does not implement
 * PasswordCredential, so there the autocomplete tokens ARE the whole mechanism —
 * which is why `username` on the email field matters more than this does.
 *
 * Never allowed to break signup. A browser that refuses, or a page not in a
 * secure context, must not turn a created account into an error.
 */
async function rememberCredential(email, password, name) {
  try {
    const PC = window.PasswordCredential;
    if (typeof PC !== "function" || !navigator.credentials?.store) return;
    await navigator.credentials.store(new PC({ id: email, password, name }));
  } catch {
    /* the password just does not get saved; the account is fine */
  }
}

// 1 · account -----------------------------------------------------------------
wire($("s1"), "Creating your account…", async () => {
  const out = await api("/v1/auth/register", {
    method: "POST",
    auth: false,
    body: {
      email: $("email").value.trim(),
      password: $("password").value,
      displayName: $("name").value.trim(),
    },
  });
  // 202 and NOTHING else — no tokens, no account. Registration now creates a
  // pending row and emails a code; the account comes into existence when that
  // code is redeemed. This used to read out.accessToken, which after that change
  // was undefined: it stored the STRING "undefined" and every later step sent
  // `Bearer undefined`. Broken end to end, and invisible while mail was down
  // because the request never got this far.
  await rememberCredential($("email").value.trim(), $("password").value, $("name").value.trim());
  // Seed the family name from theirs, because "the Brody family" is what most
  // people would have typed anyway. Still editable after they confirm.
  const first = $("name").value.trim().split(/\s+/)[0];
  if (first) $("family").value = `The ${first.replace(/'s$/, "")} family`;
  state.pendingEmail = $("email").value.trim();
  showCheckEmail();
});

function showCheckEmail() {
  step("s1");                    // resets the dots to the first step
  $("s1").hidden = true;
  $("sCheck").hidden = false;
  $("checkSub").textContent =
    `We sent a link to ${state.pendingEmail}. Open it and we'll pick up right here.`;
  announce("Check your email for a confirmation link.");
  $("resend").focus();
}

$("resend").addEventListener("click", async () => {
  const btn = $("resend");
  if (btn.dataset.busy) return;
  clearError();
  // This used to call announce() and NOTHING else, so a sighted parent tapped
  // it and the page did not change in any way — nothing distinguished "sent"
  // from "the button is broken", on the screen where they are already anxious
  // that the email has not arrived. Every other action in this flow gets a busy
  // label and a visible result; this one is the same shape now.
  btn.dataset.busy = "1";
  btn.setAttribute("aria-disabled", "true");
  const was = btn.textContent;
  btn.textContent = "Sending…";
  announce("Sending it again…");
  try {
    await api("/v1/auth/verify/request", { method: "POST", auth: false, body: { email: state.pendingEmail } });
    // Always 202, whether or not that address has anything pending — the
    // endpoint refuses to say, and so does this button.
    btn.textContent = "Sent — check your email";
    announce("Sent. Check your email.");
    // Back to a usable button after a beat, so a second attempt is possible if
    // the first genuinely did not arrive.
    setTimeout(() => {
      btn.textContent = was;
      delete btn.dataset.busy;
      btn.removeAttribute("aria-disabled");
    }, 4000);
  } catch (err) {
    btn.textContent = was;
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
    showError(err.message);
  }
});

/**
 * Continue after the emailed link. `?verify=<code>` is what the backend puts in
 * the confirmation mail (VERIFY_EMAIL_URL points here, not at the console,
 * precisely so the guided setup resumes instead of dumping a new parent into an
 * empty console).
 *
 *   201 + tokens  the code completed a SIGN-UP: carry on at "name your family".
 *   200           an existing account just confirmed itself: nothing to set up
 *                 here, so send them to the console to sign in.
 */
async function resumeFromEmail(code) {
  clearError();
  announce("Confirming your address…");
  let out;
  try {
    // The body key is `token`, not `code` — the URL parameter is named
    // `verify` and the field is `token`, and guessing cost a 400.
    out = await api("/v1/auth/verify", { method: "POST", auth: false, body: { token: code } });
  } catch (err) {
    // Names a control that exists AND does the right thing. This used to send
    // parents to "the sign-in page" for a new link — which had no such control
    // at all, and now has one that sends a PASSWORD RESET, which is not what a
    // failed confirmation needs. A confirmation link is re-sent from here.
    showError(`${err.message} Enter the same address below and we'll send a fresh link.`);
    step("s1");
    return;
  }
  if (!out?.accessToken) { location.href = "/parent/"; return; }
  state.token = out.accessToken;
  localStorage.setItem("cf_access", out.accessToken);
  localStorage.setItem("cf_refresh", out.refreshToken);
  await offerPasskey();
}

// 2 · passkey -----------------------------------------------------------------
//
// This step sits BEFORE the family, on purpose: the account that says yes is
// protected before it has anything to say yes about. Doing it last would put it
// after "here is your setup code", which is where a parent stops reading.
//
// It is also the only step that can be skipped, and only when the browser cannot
// do it at all. That is not a loophole so much as an admission: an account with
// no passkey is exactly as protected as every account was before this existed,
// the console keeps asking, and docs/SECURITY.md says so plainly rather than
// claiming a second factor everyone has.

async function offerPasskey() {
  step("sKey");
  if (!window.AjarPasskeys?.supported()) {
    $("keyWhat").textContent =
      "This browser can't create a passkey. You can finish here and add one later — "
      + "opening ajar.family on your phone is usually the quickest way.";
    $("addKey").hidden = true;
    $("skipKey").hidden = false;
    $("skipKey").textContent = "Continue";
    $("skipKey").focus();
    return;
  }
  // Softens the wording when there is no Face ID / Touch ID / Hello on this
  // machine — a security key still works, and saying "Face ID" to someone
  // holding a desktop PC is how a step stops making sense.
  if (!(await window.AjarPasskeys.hasPlatformAuthenticator())) {
    $("keyWhat").textContent =
      "Use a security key, or your phone — your browser will offer a QR code to scan. "
      + "Nothing is sent to us that anyone could reuse.";
  }
}

$("addKey").addEventListener("click", async () => {
  clearError();
  const btn = $("addKey");
  if (btn.dataset.busy) return;               // the guard `aria-disabled` needs
  btn.dataset.busy = "1";
  btn.setAttribute("aria-disabled", "true");  // never `disabled` on a focused button
  btn.textContent = "Waiting for your device…";
  announce("Waiting for your device.");
  try {
    await window.AjarPasskeys.enroll(
      (path, opts) => api(path, opts),
      window.AjarPasskeys.defaultLabel(),
    );
    announce("Passkey added.");
    step("s2");
  } catch (err) {
    showError(err.message);
    // A failed or cancelled attempt is not a dead end: offer the way past it,
    // because a parent stuck on step two of six abandons the product entirely.
    $("skipKey").hidden = false;
  } finally {
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
    btn.textContent = "Create a passkey";
  }
});

$("skipKey").addEventListener("click", () => { step("s2"); });

// 3 · family ------------------------------------------------------------------
wire($("s2"), "Setting up…", async () => {
  const fam = await api("/v1/families", { method: "POST", body: { name: $("family").value.trim() } });
  state.familyId = fam.id;
  localStorage.setItem("cf_family", fam.id);
  // A wrong guess here is harmless and a right one saves typing an IANA name.
  try { $("tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { $("tz").value = "UTC"; }
  step("s3");
});

// 4 · first child -------------------------------------------------------------
wire($("s3"), "Adding them…", async () => {
  const child = await api(`/v1/families/${encodeURIComponent(state.familyId)}/children`, {
    method: "POST",
    body: { displayName: $("child").value.trim(), timezone: $("tz").value.trim() || "UTC" },
  });
  state.childId = child.id;
  state.childName = child.displayName;
  step("s4");
});

// 5 · setup code --------------------------------------------------------------
wire($("s4"), "Making a code…", async () => {
  const out = await api(`/v1/families/${encodeURIComponent(state.familyId)}/enroll`, {
    method: "POST",
    body: { childId: state.childId, platform: $("platform").value },
  });
  $("code").textContent = out.code;
  // The server decides how long it lives; do not restate a duration from memory.
  const when = new Date(out.expiresAt);
  $("expires").textContent = Number.isNaN(when.getTime())
    ? "It works once."
    : `Works once, until ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  $("doneSub").textContent = `Open Ajar on ${state.childName ? state.childName + "'s" : "their"} device and enter this code.`;
  step("s5");
  announce("Setup code ready.");
});

$("skipCode").addEventListener("click", () => {
  $("doneHead").textContent = "You're set up";
  $("doneSub").textContent = "You can make a setup code from your console whenever their device is to hand.";
  $("code").hidden = true;
  $("expires").hidden = true;
  step("s5");
});

// Entry: a confirmation link resumes the flow; anything else starts it.
const verifyCode = new URLSearchParams(location.search).get("verify");
if (verifyCode) {
  // Strip the code from the address bar before doing anything with it: it is a
  // single-use credential and it does not belong in history, a bookmark, or a
  // Referer header on the next request this page makes.
  history.replaceState(null, "", location.pathname);
  step("s1");
  resumeFromEmail(verifyCode);
} else {
  step("s1");
}
