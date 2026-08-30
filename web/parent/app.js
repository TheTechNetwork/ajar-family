/**
 * Ajar — Parent Console. A minimal static web UI for the approval loop, served by
 * the backend at `/` (one process, no separate web server). Talks to the REST API
 * with a bearer token (CORS enabled on the backend).
 *
 * UX (docs/UX_PRINCIPLES.md): the console reacts in seconds via a long-poll push
 * (§1), and each ask collapses to ONE primary "Say yes" with the narrowest-useful
 * default; the full scope/duration matrix hides behind "Change…" (§2/§3).
 *
 * Three rules this file is written to keep:
 *   1. Never render success text the server has not confirmed.
 *   2. Never destroy the parent's keyboard focus on a background re-render.
 *   3. Never show a raw enum, a raw HTTP status, or a colour-only state.
 */
const $ = (id) => document.getElementById(id);

/**
 * Backend origin. The console is served BY the backend at `/`, so the origin is
 * always right and the field the parent used to have to fill in is gone (it was
 * also a bypass: a child on the enrollment screen could re-point the client at a
 * server they control). A dev override survives behind an explicit opt-in flag.
 */
function resolveBackendUrl() {
  const q = new URLSearchParams(location.search).get("api");
  if (q && localStorage.getItem("cf_dev") === "1") return q.replace(/\/+$/, "");
  if (location.origin && location.origin !== "null") return location.origin;
  return "http://localhost:8787"; // file:// during local development only
}

const state = {
  backendUrl: resolveBackendUrl(),
  token: localStorage.getItem("cf_access") || null,        // short-lived access token
  refresh: localStorage.getItem("cf_refresh") || null,     // long-lived refresh token
  familyId: localStorage.getItem("cf_family") || null,
  childName: {},        // childId -> display name, for "Jane asked"
  registerMode: false,
};
function setTokens(out) {
  state.token = out.accessToken; state.refresh = out.refreshToken;
  localStorage.setItem("cf_access", out.accessToken);
  localStorage.setItem("cf_refresh", out.refreshToken);
}
function clearTokens() {
  state.token = null; state.refresh = null;
  localStorage.removeItem("cf_access"); localStorage.removeItem("cf_refresh");
}

// ---------------------------------------------------------------------------
// Announcements. Everything async in this console changes the DOM; without a
// live region none of it reaches a screen reader (WCAG SC 4.1.3).
// ---------------------------------------------------------------------------
function announce(msg) {
  const el = $("sr"); el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; });
}
function announceAlert(msg) {
  const el = $("srAlert"); el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; });
}

// ---------------------------------------------------------------------------
// Toast. `visibility` (not just opacity) so an invisible toast cannot eat the
// thumb tap at the bottom-centre of a phone. Optionally carries an Undo.
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, undo) {
  const box = $("toast"), btn = $("toastUndo");
  $("toastMsg").textContent = msg;
  clearTimeout(toastTimer);
  if (undo) {
    btn.classList.remove("hide");
    btn.textContent = undo.label || "Undo";
    btn.onclick = async () => { hideToast(); await undo.run(); };
  } else {
    btn.classList.add("hide");
    btn.onclick = null;
  }
  box.classList.add("is-shown");
  announce(msg);
  // 6s so a screen-reader or low-vision user can actually reach it; the Undo
  // window is 5s, deliberately inside that (§ psychology: reversibility).
  toastTimer = setTimeout(hideToast, undo ? 5000 : 6000);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("toast").classList.remove("is-shown");
  $("toastUndo").classList.add("hide");
}

// ---------------------------------------------------------------------------
// Errors that say what to do next (SC 3.3.3). Never show a bare status code.
// ---------------------------------------------------------------------------
const ERR_COPY = {
  invalid_credentials: "That email and password don't match. Check both and try again.",
  email_taken: "There's already an account with that email. Try logging in instead.",
  weak_password: "Passwords need at least 8 characters. Try a longer one.",
  not_found: "That's gone — someone may have answered it already.",
  request_already_decided: "Another parent already answered this one.",
  "400": "Something in that didn't look right. Check it and try again.",
  "401": "Your session ended. Log in again.",
  "403": "You don't have permission to do that in this family.",
  "404": "That's gone — someone may have answered it already.",
  "409": "Another parent already answered this one.",
  "429": "Too many tries. Wait a minute, then try again.",
  "500": "The Ajar server had a problem. Try again in a moment.",
  OFFLINE: "Can't reach Ajar. Check your internet, then try again.",
};
function friendly(e) {
  const raw = String(e && e.message ? e.message : e);
  return ERR_COPY[raw] || "Something went wrong. Check your internet, then try again.";
}
const isAuthError = (e) => /^(401|403|invalid_credentials)$/.test(String(e && e.message ? e.message : e));

async function rawApi(path, { method = "GET", body, auth = true, signal } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && state.token) headers.authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(state.backendUrl + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal,
    });
  } catch {
    throw new Error("OFFLINE"); // a dropped fetch is not an auth failure
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return { res, data };
}
// On a 401, transparently refresh the access token once and retry.
async function api(path, opts = {}) {
  let { res, data } = await rawApi(path, opts);
  if (res.status === 401 && opts.auth !== false && state.refresh) {
    try {
      const rr = await rawApi("/v1/auth/refresh", { method: "POST", auth: false, body: { refreshToken: state.refresh } });
      if (rr.res.ok) { setTokens(rr.data); ({ res, data } = await rawApi(path, opts)); }
      else clearTokens();
    } catch { /* fall through to the error below */ }
  }
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
$("authForm").addEventListener("submit", (e) => { e.preventDefault(); auth(state.registerMode); });
$("btnMode").onclick = () => setRegisterMode(!state.registerMode);

function setRegisterMode(on) {
  state.registerMode = on;
  $("nameField").classList.toggle("hide", !on);
  $("btnLogin").textContent = on ? "Create account" : "Log in";
  $("btnMode").textContent = on ? "I already have an account" : "Create an account";
  $("authH").textContent = on ? "Set up your account" : "Welcome back";
  // A password manager should offer a NEW password when registering, not the old one.
  $("password").setAttribute("autocomplete", on ? "new-password" : "current-password");
  announce(on ? "Creating a new account." : "Logging in.");
}

async function auth(register) {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authErr").textContent = "";
  $("email").removeAttribute("aria-invalid");
  $("password").removeAttribute("aria-invalid");

  if (!email) return failAuth("Type the email you signed up with.", "email");
  if (password.length < 8) return failAuth("Passwords need at least 8 characters.", "password");

  const btn = $("btnLogin");
  btn.dataset.busy = "1";                 // blocks a double-tap on a slow phone
  btn.setAttribute("aria-disabled", "true");
  announce(register ? "Creating your account…" : "Logging in…");
  try {
    const out = register
      ? await api("/v1/auth/register", { method: "POST", auth: false, body: { email, password, displayName: $("name").value.trim() || email } })
      : await api("/v1/auth/login", { method: "POST", auth: false, body: { email, password } });
    setTokens(out);
    await afterLogin();
  } catch (e) {
    failAuth(friendly(e), "password");
  } finally {
    delete btn.dataset.busy;
    btn.removeAttribute("aria-disabled");
  }
}
function failAuth(msg, focusId) {
  $("authErr").textContent = msg;
  announceAlert(msg);
  $(focusId).setAttribute("aria-invalid", "true");
  $(focusId).focus();
}

$("signout").onclick = async () => {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch { /* revoke best-effort */ }
  clearTokens();
  location.reload();
};

async function afterLogin() {
  const me = await api("/v1/me");
  $("who").textContent = me.displayName || me.email;   // the email adds nothing here
  $("who").title = me.email;
  $("signout").classList.remove("hide");
  $("authCard").classList.add("hide");
  $("familyCard").classList.remove("hide");
  renderFamilyPick(me.families);
  if (!state.familyId && me.families[0]) await selectFamily(me.families[0].familyId);
  else if (state.familyId) await selectFamily(state.familyId);
  else {
    // No family yet: setup IS the job, so open the disclosure for this one case.
    $("familyCard").open = true;
    announce("No family set up yet. Create one to get started.");
  }
}

const ROLE_LABEL = { OWNER: "owner", PARENT: "parent", LIMITED_GUARDIAN: "guardian" };

function renderFamilyPick(families) {
  const box = $("familyPick");
  if (!families.length) {
    box.innerHTML = `<p class="muted">No family yet — create one below.</p>`;
    return;
  }
  // Selected state carries a ✓ and aria-pressed, never fill colour alone (SC 1.4.1).
  box.innerHTML = families.map((f) => {
    const sel = f.familyId === state.familyId;
    return `<button type="button" class="${sel ? "btn-primary" : ""}" aria-pressed="${sel}"
      data-fid="${escapeAttr(f.familyId)}" style="margin:0 var(--s-2) var(--s-2) 0">${sel ? "✓ " : ""}${escapeHtml(f.family?.name ?? f.familyId)}<span class="sr-only"> (${ROLE_LABEL[f.role] ?? "parent"})</span></button>`;
  }).join("");
  box.querySelectorAll("button").forEach((b) => (b.onclick = () => selectFamily(b.dataset.fid)));
}

$("btnCreateFamily").onclick = async () => {
  const el = $("familyName"), name = el.value.trim();
  if (!name) {
    el.setAttribute("aria-invalid", "true"); el.focus();
    announceAlert("Type a family name first."); toast("Type a family name first.");
    return;
  }
  el.removeAttribute("aria-invalid");
  try {
    const fam = await api("/v1/families", { method: "POST", body: { name } });
    el.value = "";
    toast(`${name} is set up`);
    await afterLogin();
    await selectFamily(fam.id);
  } catch (e) { const m = friendly(e); toast(m); announceAlert(m); }
};

async function selectFamily(fid) {
  state.familyId = fid; localStorage.setItem("cf_family", fid);
  $("childrenBox").classList.remove("hide");
  $("requestsCard").classList.remove("hide");
  $("rulesCard").classList.remove("hide");
  await refreshChildren();
  refreshRules();
  startLiveRequests();
  try { renderFamilyPick((await api("/v1/me")).families); } catch { /* picker is cosmetic */ }
}

// ---------------------------------------------------------------------------
// children + enrollment
// ---------------------------------------------------------------------------
async function refreshChildren() {
  const box = $("children");
  box.setAttribute("aria-busy", "true");
  let kids = [];
  try { kids = await api(`/v1/families/${state.familyId}/children`); }
  catch (e) {
    box.removeAttribute("aria-busy");
    box.innerHTML = `<li class="muted">Couldn't load your kids. ${escapeHtml(friendly(e))}</li>`;
    return;
  }
  state.childName = Object.fromEntries(kids.map((k) => [k.id, k.displayName]));
  box.removeAttribute("aria-busy");
  box.innerHTML = kids.length
    ? kids.map((k) => `<li>
        <span class="grow">${escapeHtml(k.displayName)}</span>
        <button type="button" data-cid="${escapeAttr(k.id)}">Set up a device<span class="sr-only"> for ${escapeHtml(k.displayName)}</span></button>
      </li>`).join("")
    : `<li class="muted">No kids added yet.</li>`;
  box.querySelectorAll("button").forEach((b) => (b.onclick = () => enrollDevice(b.dataset.cid, b)));
}

$("btnAddChild").onclick = async () => {
  const el = $("childName"), displayName = el.value.trim();
  if (!displayName) {
    el.setAttribute("aria-invalid", "true"); el.focus();
    announceAlert("Type a name first."); toast("Type a name first.");
    return;
  }
  el.removeAttribute("aria-invalid");
  try {
    await api(`/v1/families/${state.familyId}/children`, { method: "POST", body: { displayName } });
    el.value = "";
    toast(`${displayName} added — next, set up a device`);
    await refreshChildren();
  } catch (e) { const m = friendly(e); toast(m); announceAlert(m); }
};

async function enrollDevice(childId, btn) {
  if (btn) { btn.dataset.busy = "1"; btn.setAttribute("aria-disabled", "true"); }
  try {
    const out = await api(`/v1/families/${state.familyId}/enroll`, { method: "POST", body: { childId, platform: "WINDOWS" } });
    const expires = new Date(out.expiresAt);
    $("enrollBox").classList.remove("hide");
    $("enrollCode").textContent = out.code;
    // Spell it out: VoiceOver reads "K7M2P9QR" as an attempted word otherwise,
    // and the parent has to transcribe it onto another machine.
    $("enrollCode").setAttribute("aria-label", `Setup code: ${String(out.code).split("").join(" ")}`);
    $("enrollMeta").textContent = `Works until ${expires.toLocaleTimeString()}.`;
    toast("Code ready — it works for a few minutes");
    announce(`Setup code ready: ${String(out.code).split("").join(" ")}. It works until ${expires.toLocaleTimeString()}.`);
    $("enrollCode").focus();
  } catch (e) { const m = friendly(e); toast(m); announceAlert(m); }
  finally { if (btn) { delete btn.dataset.busy; btn.removeAttribute("aria-disabled"); } }
}

// ---------------------------------------------------------------------------
// asks (live via long-poll push; §1)
// ---------------------------------------------------------------------------
const DURATIONS = [
  { label: "15 min", d: { kind: "MINUTES", minutes: 15 } },
  { label: "30 min", d: { kind: "MINUTES", minutes: 30 } },
  { label: "1 hour", d: { kind: "MINUTES", minutes: 60 } },
  { label: "End of day", d: { kind: "UNTIL_END_OF_DAY" } },
  { label: "Just once", d: { kind: "ONCE" } },
  { label: "For good", d: { kind: "ALWAYS" } },
];
const DEFAULT_DURATION_I = 1; // 30 min — the narrowest-useful default (§3)

/**
 * The narrowest-useful grant for what the child actually asked for (§3).
 *
 * This MUST be derived from the request, not hardcoded: a THIS_VIDEO grant
 * becomes a YOUTUBE_VIDEO rule whose value is matched against a canonical video
 * id, so applying it to a DOMAIN/CATEGORY/URL request produces a rule that can
 * never match — the parent is told "unlocked" and the child stays blocked.
 *
 * Note CATEGORY: a child blocked by "all social media" is granted THIS site,
 * never the whole category. Say yes to the thing asked for, nothing wider.
 */
function defaultScopeFor(targetType) {
  switch (targetType) {
    case "YOUTUBE_VIDEO": return "THIS_VIDEO";
    case "YOUTUBE_CHANNEL": return "THIS_CHANNEL";
    case "URL":
    case "URL_PATTERN": return "THIS_URL";
    case "DOMAIN":
    case "CATEGORY": return "THIS_DOMAIN";
    default: return "THIS_CHILD"; // YOUTUBE_PLAYLIST, APPLICATION: grant exactly the target
  }
}

// Human noun for the primary button, per request target type.
const TARGET_NOUN = {
  YOUTUBE_VIDEO: "this video", YOUTUBE_CHANNEL: "this channel", YOUTUBE_PLAYLIST: "this playlist",
  URL: "this page", DOMAIN: "this site", APPLICATION: "this app",
};
// Plain English for the parent; the raw enum still goes over the wire as `value`.
const TYPE_LABEL = {
  YOUTUBE_VIDEO: "YouTube video", YOUTUBE_CHANNEL: "YouTube channel",
  YOUTUBE_PLAYLIST: "YouTube playlist", URL: "Web page", URL_PATTERN: "Web address",
  DOMAIN: "Website", CATEGORY: "Category", APPLICATION: "App",
};
const SCOPE_LABEL = {
  THIS_REQUEST: "Just this once",
  THIS_URL: "This exact page",
  THIS_VIDEO: "This video",
  THIS_CHANNEL: "Everything from this channel",
  THIS_DOMAIN: "This whole site",
  THIS_DEVICE: "This, on this device",
  THIS_CHILD: "This, on all of {child}'s devices",
  WHOLE_FAMILY: "This, for everyone in the family",
};
// Narrow → broad. The old list ran in no order at all, with the widest option
// (WHOLE_FAMILY) sitting above the narrowest (THIS_REQUEST).
const SCOPE_ORDER = ["THIS_REQUEST", "THIS_URL", "THIS_VIDEO", "THIS_CHANNEL",
  "THIS_DOMAIN", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY"];

/**
 * Mirrors backend `applicableScopes()` (services.ts). Offering a scope the
 * server will reject turns a silent wrong answer into a loud incomprehensible
 * one ("approval scope THIS_CHANNEL does not apply to a URL request"), so the
 * picker only offers what can actually be granted.
 */
function applicableScopes(r) {
  const out = [];
  if (r.targetType === "YOUTUBE_VIDEO") out.push("THIS_VIDEO");
  if (r.targetType === "YOUTUBE_CHANNEL") out.push("THIS_CHANNEL");
  if (r.url) out.push("THIS_URL");
  if (hostOf(r)) out.push("THIS_DOMAIN");
  out.push("THIS_REQUEST", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY");
  return SCOPE_ORDER.filter((s) => out.includes(s));
}
function hostOf(r) {
  if (r.targetType === "DOMAIN") return r.targetValue;
  try { return r.url ? new URL(r.url).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}
/**
 * The scope the primary "Open …" button will actually send. `defaultScopeFor`
 * gives the narrowest-useful shape for the target type, but a CATEGORY ask with
 * no URL has no host, so THIS_DOMAIN would be rejected by the server. Falling
 * back to THIS_REQUEST keeps one tap working for every request type.
 */
function effectiveDefaultScope(r) {
  const want = defaultScopeFor(r.targetType);
  return applicableScopes(r).includes(want) ? want : "THIS_REQUEST";
}
function scopeLabel(s, childId) {
  return SCOPE_LABEL[s].replace("{child}", state.childName[childId] || "your kid");
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 0) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

let liveActive = false;
let lastCount = -1;
let backoffMs = 0;

function setLive(ok, detail) {
  const el = $("liveDot");
  // Word + colour, never colour alone (SC 1.4.1).
  el.textContent = ok ? "· live" : "· reconnecting…";
  el.className = `live ${ok ? "live-ok" : "live-off"}`;
  el.title = ok ? "Updating live" : (detail || "Trying to reconnect");
}

// Long-poll loop: park on the server until an ask arrives or is decided, then
// re-render immediately. Backs off on failure and says so, rather than showing
// a stale list under the word "live".
async function startLiveRequests() {
  if (liveActive) return;
  liveActive = true;
  lastCount = -1;
  backoffMs = 0;
  while (liveActive && state.familyId) {
    try {
      const out = await api(`/v1/families/${state.familyId}/requests/wait?count=${lastCount}&timeout=25000`);
      backoffMs = 0;
      setLive(true);
      renderRequests(out.requests || []);
    } catch (e) {
      if (isAuthError(e)) {
        liveActive = false;
        clearTokens();
        announceAlert("Your session ended. Log in again.");
        location.reload();
        return;
      }
      setLive(false, friendly(e));
      announce("Lost the connection to Ajar. Trying again.");
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, 30000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Re-render the ask list without stealing the keyboard. The long-poll wakes on
 * every create AND every decide, so a parent tabbing through the list gets the
 * subtree replaced under them several times a minute; without this, focus falls
 * to <body> mid-interaction (SC 2.4.3).
 */
function renderRequests(reqs) {
  lastCount = reqs.length;
  const box = $("requests");

  const active = document.activeElement;
  const focusKey = box.contains(active) && active.dataset
    ? ["yes", "notnow", "change", "approve", "block"]
      .map((k) => (active.dataset[k] ? `${k}|${active.dataset[k]}|${active.dataset.di ?? ""}` : null))
      .find(Boolean)
    : null;
  // Keep any open "Change…" panels open across the re-render.
  const openPanels = new Set(
    [...box.querySelectorAll(".change:not(.hide)")].map((el) => el.id));

  $("reqCount").textContent = reqs.length;
  $("reqCountSr").textContent = `${reqs.length} ask${reqs.length === 1 ? "" : "s"} waiting`;
  box.removeAttribute("aria-busy");

  if (!reqs.length) {
    const kid = Object.values(state.childName)[0];
    box.innerHTML = `<li class="empty">All clear. When ${escapeHtml(kid || "someone")} asks for something it lands here — usually within a second.</li>`;
    announce("No asks waiting.");
    return;
  }

  box.innerHTML = reqs.map((r) => renderRequest(r)).join("");
  reqs.forEach((r) => wireRequest(r));
  for (const id of openPanels) {
    const el = $(id);
    if (el) {
      el.classList.remove("hide");
      const t = document.querySelector(`[aria-controls="${id}"]`);
      if (t) t.setAttribute("aria-expanded", "true");
    }
  }
  announce(`${reqs.length} ask${reqs.length === 1 ? "" : "s"} waiting.`);

  if (focusKey) {
    const [k, id, di] = focusKey.split("|");
    const sel = di ? `[data-${k}="${cssEscape(id)}"][data-di="${di}"]` : `[data-${k}="${cssEscape(id)}"]`;
    const again = box.querySelector(sel);
    if (again) again.focus();
  }
}

function renderRequest(r) {
  const noun = TARGET_NOUN[r.targetType] || "this";
  const human = r.title || `${TYPE_LABEL[r.targetType] ?? r.targetType} — ${r.targetValue}`;
  const defLabel = DURATIONS[DEFAULT_DURATION_I].label;
  const who = state.childName[r.childId] || "Someone";
  const id = escapeAttr(r.id);
  const ctx = escapeHtml(human);
  const scopes = applicableScopes(r);
  const preselect = effectiveDefaultScope(r);

  return `<li class="req" id="req-${id}" aria-labelledby="reqt-${id}">
    <p class="who-asked">${escapeHtml(who)} · ${escapeHtml(ago(r.createdAt))}</p>
    <h3 class="t" id="reqt-${id}">${ctx}</h3>
    ${r.reason ? `<p class="quote">“${escapeHtml(r.reason)}”</p>` : ""}
    <details>
      <summary>Details</summary>
      <p class="meta">${escapeHtml(TYPE_LABEL[r.targetType] ?? r.targetType)} — ${escapeHtml(r.targetValue)}</p>
      ${r.url ? `<p class="meta">${escapeHtml(r.url)}</p>` : ""}
    </details>
    <div class="actions">
      <button type="button" class="btn-yes" data-yes="${id}">Open ${escapeHtml(noun)} · ${defLabel}<span class="sr-only"> — ${ctx}</span></button>
      <button type="button" data-notnow="${id}">Not now<span class="sr-only"> — ${ctx}</span></button>
      <button type="button" class="btn-ghost" data-change="${id}"
              aria-expanded="false" aria-controls="change-${id}">Change…<span class="sr-only"> — ${ctx}</span></button>
    </div>
    <div class="change hide" id="change-${id}">
      <label for="scope-${id}">How much to open</label>
      <select id="scope-${id}">
        ${scopes.map((s) => `<option value="${s}"${s === preselect ? " selected" : ""}>${escapeHtml(scopeLabel(s, r.childId))}</option>`).join("")}
      </select>
      <fieldset>
        <legend>Until when</legend>
        <div class="grid">
          ${DURATIONS.map((x, i) => `<button type="button" data-approve="${id}" data-di="${i}">${escapeHtml(x.label)}<span class="sr-only"> — ${ctx}</span></button>`).join("")}
        </div>
      </fieldset>
      ${scopes.includes("THIS_DOMAIN") ? `<fieldset>
        <legend>Or keep it closed</legend>
        <div class="grid">
          <button type="button" class="btn-danger" data-block="${id}">Keep ${escapeHtml(hostOf(r))} closed for good<span class="sr-only"> — ${ctx}</span></button>
        </div>
      </fieldset>` : ""}
    </div>
  </li>`;
}

function wireRequest(r) {
  const id = r.id;
  const q = (sel) => document.querySelector(sel);
  // Primary: narrowest-useful default for what was actually asked for (§3).
  const yes = q(`[data-yes="${cssEscape(id)}"]`);
  if (yes) yes.onclick = () => decide(r, "ALLOW", effectiveDefaultScope(r), DURATIONS[DEFAULT_DURATION_I].d);

  // "Not now" is the softest control in the product; it must stay the softest
  // effect. THIS_REQUEST + ONCE, and the Undo below makes it reversible.
  const notnow = q(`[data-notnow="${cssEscape(id)}"]`);
  if (notnow) notnow.onclick = () => decide(r, "BLOCK", "THIS_REQUEST", { kind: "ONCE" });

  const change = q(`[data-change="${cssEscape(id)}"]`);
  if (change) change.onclick = () => {
    const panel = $(`change-${id}`);
    const open = !panel.classList.toggle("hide");
    change.setAttribute("aria-expanded", String(open));
    if (open) panel.querySelector("select")?.focus();
  };

  // Change… — an explicit broaden: the parent chooses the wider scope, never fatigue.
  document.querySelectorAll(`[data-approve="${cssEscape(id)}"]`).forEach((b) =>
    (b.onclick = () => decide(r, "ALLOW", $(`scope-${id}`).value, DURATIONS[+b.dataset.di].d)));

  const block = q(`[data-block="${cssEscape(id)}"]`);
  if (block) block.onclick = () => {
    const what = hostOf(r) || r.targetValue;
    if (!confirm(`Keep ${what} closed for good?\n\nYou can take this back any time under "What you've already decided".`)) return;
    decide(r, "BLOCK", "THIS_DOMAIN", { kind: "ALWAYS" });
  };
}

/** A decision that writes a STANDING rule is the only kind we can take back:
 *  the API can delete a rule, but a timed grant has no removal endpoint. */
function producesStandingRule(decision, duration) {
  return decision === "BLOCK" || duration.kind === "ALWAYS";
}

async function decide(r, decision, scope, duration) {
  const card = $(`req-${r.id}`);
  if (card) card.dataset.busy = "1";      // opacity AND pointer-events, so no double-decide
  const who = state.childName[r.childId] || "your kid";
  try {
    const out = await api(`/v1/families/${state.familyId}/requests/${r.id}/decide`,
      { method: "POST", body: { decision, scope, duration } });

    const ruleId = out?.decision?.producedRuleId;
    const undoable = producesStandingRule(decision, duration) && ruleId;
    const msg = decision === "ALLOW"
      ? `Sent to ${who}'s device — ${scopeLabel(scope, r.childId).replace("{child}", who)}`
      : `Left closed — ${who} sees the answer on their screen`;

    toast(msg, undoable ? {
      label: "Undo",
      run: async () => {
        try {
          await api(`/v1/families/${state.familyId}/rules/${ruleId}`, { method: "DELETE" });
          toast("Taken back. The ask stays answered — the rule is gone.");
          refreshRules();
        } catch (e) { const m = friendly(e); toast(m); announceAlert(m); }
      },
    } : null);
    refreshRules();
  } catch (e) {
    if (card) delete card.dataset.busy;
    const m = friendly(e);
    toast(m);
    announceAlert(m);
  }
}

// ---------------------------------------------------------------------------
// Standing decisions — the thing that makes "Not now" reversible.
// GET /rules returns STANDING rules only; timed grants expire on their own and
// have no delete endpoint, so this card never claims to list them.
// ---------------------------------------------------------------------------
async function refreshRules() {
  if (!state.familyId) return;
  const box = $("rules");
  box.setAttribute("aria-busy", "true");
  let rules = [];
  try { rules = await api(`/v1/families/${state.familyId}/rules`); }
  catch (e) {
    box.removeAttribute("aria-busy");
    box.innerHTML = `<li class="muted">Couldn't load these. ${escapeHtml(friendly(e))}</li>`;
    return;
  }
  box.removeAttribute("aria-busy");
  if (!rules.length) {
    box.innerHTML = `<li class="muted">Nothing standing yet — everything is on the family defaults.</li>`;
    return;
  }
  rules.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  box.innerHTML = rules.map((rule) => {
    const open = rule.action === "ALLOW";
    const whoFor = rule.scope?.childId ? (state.childName[rule.scope.childId] || "one kid")
      : rule.scope?.deviceId ? "one device" : "everyone";
    return `<li>
      <span class="grow">
        <span class="rt">${escapeHtml(rule.value)}</span><br />
        <span class="muted">${escapeHtml(TYPE_LABEL[rule.target] ?? rule.target)} · for ${escapeHtml(whoFor)} · set ${escapeHtml(ago(rule.createdAt))}</span>
      </span>
      <span class="tag ${open ? "tag-open" : "tag-closed"}">${open ? "Open" : "Closed"}</span>
      <button type="button" class="btn-danger" data-rm="${escapeAttr(rule.id)}"
              data-label="${escapeAttr(rule.value)}">Remove<span class="sr-only"> the ${open ? "open" : "closed"} rule for ${escapeHtml(rule.value)}</span></button>
    </li>`;
  }).join("");
  box.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => removeRule(b)));
}

async function removeRule(btn) {
  const id = btn.dataset.rm, label = btn.dataset.label;
  if (!confirm(`Remove the rule for ${label}?\n\nThings go back to your family defaults for it.`)) return;
  btn.dataset.busy = "1"; btn.setAttribute("aria-disabled", "true");
  try {
    await api(`/v1/families/${state.familyId}/rules/${id}`, { method: "DELETE" });
    toast(`Removed — ${label} is back on your defaults`);
    await refreshRules();
  } catch (e) {
    const m = friendly(e); toast(m); announceAlert(m);
    delete btn.dataset.busy; btn.removeAttribute("aria-disabled");
  }
}
$("btnRefreshRules").onclick = () => refreshRules();

// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
/** Ids come from the server, but a selector is not HTML — escape it separately. */
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
}

// Auto-resume a session (api() refreshes a stale access token automatically).
// Only an actual auth rejection clears the refresh token — a single offline
// fetch used to sign the parent out permanently.
setRegisterMode(false);
if (state.token || state.refresh) {
  $("authCard").classList.add("hide");           // don't show a form about to vanish
  afterLogin().catch((e) => {
    if (isAuthError(e)) { clearTokens(); $("authCard").classList.remove("hide"); }
    else {
      $("authCard").classList.remove("hide");
      const m = friendly(e);
      $("authErr").textContent = m;
      announceAlert(m);
    }
  });
}
