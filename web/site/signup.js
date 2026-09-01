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
  if (/(^|\.)ajar\.family$/.test(location.hostname) && location.hostname !== "api.ajar.family")
    return "https://api.ajar.family";
  if (location.origin && location.origin !== "null") return location.origin;
  return "http://localhost:8787";
})();

const state = { token: null, familyId: null, childId: null, childName: "" };

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
  state.token = out.accessToken;
  localStorage.setItem("cf_access", out.accessToken);
  localStorage.setItem("cf_refresh", out.refreshToken);
  // Seed the family name from theirs, because "the Brody family" is what most
  // people would have typed anyway. Still editable.
  const first = $("name").value.trim().split(/\s+/)[0];
  if (first) $("family").value = `The ${first.replace(/'s$/, "")} family`;
  step(2);
});

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

step(1);
