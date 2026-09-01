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

/** Move to step n: swap panels, light the dot, put focus where typing resumes. */
function step(n) {
  for (let i = 1; i <= 5; i++) {
    const panel = $(`s${i}`);
    if (panel) panel.hidden = i !== n;
  }
  $("sCheck").hidden = true;
  for (let i = 1; i <= 4; i++) {
    const dot = $(`d${i}`);
    if (dot) dot.toggleAttribute("data-on", i <= Math.min(n, 4));
  }
  clearError();
  const focusable = $(`s${n}`)?.querySelector("input, select, button");
  focusable?.focus();
}

/** Guard every submit: disable the button so a double tap is not a double POST. */
function submitting(form, on, label) {
  const btn = form.querySelector("button.primary");
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label ?? btn.textContent;
    btn.disabled = false;
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
  step(1);                       // resets the dots to the first step
  $("s1").hidden = true;
  $("sCheck").hidden = false;
  $("checkSub").textContent =
    `We sent a link to ${state.pendingEmail}. Open it and we'll pick up right here.`;
  announce("Check your email for a confirmation link.");
  $("resend").focus();
}

$("resend").addEventListener("click", async () => {
  clearError();
  announce("Sending it again…");
  try {
    await api("/v1/auth/verify/request", { method: "POST", auth: false, body: { email: state.pendingEmail } });
    // Always 202, whether or not that address has anything pending — the
    // endpoint refuses to say, and so does this button.
    announce("Sent. Check your email.");
  } catch (err) {
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
    showError(`${err.message} You can ask for a new link from the sign-in page.`);
    step(1);
    return;
  }
  if (!out?.accessToken) { location.href = "/parent/"; return; }
  state.token = out.accessToken;
  localStorage.setItem("cf_access", out.accessToken);
  localStorage.setItem("cf_refresh", out.refreshToken);
  step(2);
}

// 2 · family ------------------------------------------------------------------
wire($("s2"), "Setting up…", async () => {
  const fam = await api("/v1/families", { method: "POST", body: { name: $("family").value.trim() } });
  state.familyId = fam.id;
  localStorage.setItem("cf_family", fam.id);
  // A wrong guess here is harmless and a right one saves typing an IANA name.
  try { $("tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { $("tz").value = "UTC"; }
  step(3);
});

// 3 · first child -------------------------------------------------------------
wire($("s3"), "Adding them…", async () => {
  const child = await api(`/v1/families/${encodeURIComponent(state.familyId)}/children`, {
    method: "POST",
    body: { displayName: $("child").value.trim(), timezone: $("tz").value.trim() || "UTC" },
  });
  state.childId = child.id;
  state.childName = child.displayName;
  step(4);
});

// 4 · setup code --------------------------------------------------------------
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
  step(5);
  announce("Setup code ready.");
});

$("skipCode").addEventListener("click", () => {
  $("doneHead").textContent = "You're set up";
  $("doneSub").textContent = "You can make a setup code from your console whenever their device is to hand.";
  $("code").hidden = true;
  $("expires").hidden = true;
  step(5);
});

// Entry: a confirmation link resumes the flow; anything else starts it.
const verifyCode = new URLSearchParams(location.search).get("verify");
if (verifyCode) {
  // Strip the code from the address bar before doing anything with it: it is a
  // single-use credential and it does not belong in history, a bookmark, or a
  // Referer header on the next request this page makes.
  history.replaceState(null, "", location.pathname);
  step(1);
  resumeFromEmail(verifyCode);
} else {
  step(1);
}
