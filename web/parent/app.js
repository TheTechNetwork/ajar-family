/**
 * Ajar — Parent Console. A minimal static web UI for the approval loop, served by
 * the backend at `/` (one process, no separate web server). Talks to the REST API
 * with a bearer token (CORS enabled on the backend).
 *
 * UX (docs/UX_PRINCIPLES.md): the console reacts in seconds via a long-poll push
 * (§1), and each ask collapses to ONE primary "Say yes" with the narrowest-useful
 * default; the full scope/duration matrix hides behind "Change…" (§2/§3).
 */
const $ = (id) => document.getElementById(id);
const state = {
  backendUrl: localStorage.getItem("cf_backend") || "http://localhost:8787",
  token: localStorage.getItem("cf_access") || null,        // short-lived access token
  refresh: localStorage.getItem("cf_refresh") || null,     // long-lived refresh token
  familyId: localStorage.getItem("cf_family") || null,
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

function flash(msg) {
  const f = $("flash"); f.textContent = msg; f.classList.add("show");
  setTimeout(() => f.classList.remove("show"), 1800);
}
async function rawApi(path, { method = "GET", body, auth = true, signal } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(state.backendUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
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

// ---- auth ----
$("btnRegister").onclick = () => auth(true);
$("btnLogin").onclick = () => auth(false);
async function auth(register) {
  state.backendUrl = $("backendUrl").value.replace(/\/+$/, "");
  localStorage.setItem("cf_backend", state.backendUrl);
  $("authErr").textContent = "";
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const out = register
      ? await api("/v1/auth/register", { method: "POST", auth: false, body: { email, password, displayName: $("name").value.trim() || email } })
      : await api("/v1/auth/login", { method: "POST", auth: false, body: { email, password } });
    setTokens(out);
    await afterLogin();
  } catch (e) { $("authErr").textContent = String(e.message || e); }
}

$("signout").onclick = async () => {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch { /* revoke best-effort */ }
  clearTokens();
  location.reload();
};

async function afterLogin() {
  const me = await api("/v1/me");
  $("who").textContent = `${me.displayName} · ${me.email}`;
  $("signout").classList.remove("hide");
  $("authCard").classList.add("hide");
  $("familyCard").classList.remove("hide");
  renderFamilyPick(me.families);
  if (!state.familyId && me.families[0]) selectFamily(me.families[0].familyId);
  else if (state.familyId) selectFamily(state.familyId);
}

function renderFamilyPick(families) {
  const box = $("familyPick");
  if (!families.length) { box.innerHTML = `<div class="muted">No family yet — create one below.</div>`; return; }
  box.innerHTML = `<label>Family</label>` + families.map((f) =>
    `<button class="${f.familyId === state.familyId ? "" : "secondary"}" data-fid="${f.familyId}">${escapeHtml(f.family?.name ?? f.familyId)} · ${f.role}</button>`
  ).join(" ");
  box.querySelectorAll("button").forEach((b) => (b.onclick = () => selectFamily(b.dataset.fid)));
}

$("btnCreateFamily").onclick = async () => {
  const name = $("familyName").value.trim(); if (!name) return;
  const fam = await api("/v1/families", { method: "POST", body: { name } });
  flash("Family created"); await afterLogin(); selectFamily(fam.id);
};

async function selectFamily(fid) {
  state.familyId = fid; localStorage.setItem("cf_family", fid);
  $("childrenBox").classList.remove("hide");
  $("requestsCard").classList.remove("hide");
  await refreshChildren();
  startLiveRequests();
  const me = await api("/v1/me"); renderFamilyPick(me.families);
}

// ---- children + enrollment ----
async function refreshChildren() {
  const kids = await api(`/v1/families/${state.familyId}/children`);
  $("children").innerHTML = kids.length
    ? kids.map((k) => `<div class="row" style="margin:0.25rem 0"><div>${escapeHtml(k.displayName)}</div><div style="flex:0"><button class="secondary" data-cid="${k.id}">Enroll a device</button></div></div>`).join("")
    : `<div class="muted">No children yet.</div>`;
  $("children").querySelectorAll("button").forEach((b) => (b.onclick = () => enrollDevice(b.dataset.cid)));
}
$("btnAddChild").onclick = async () => {
  const displayName = $("childName").value.trim(); if (!displayName) return;
  await api(`/v1/families/${state.familyId}/children`, { method: "POST", body: { displayName } });
  $("childName").value = ""; flash("Child added"); refreshChildren();
};
async function enrollDevice(childId) {
  const out = await api(`/v1/families/${state.familyId}/enroll`, { method: "POST", body: { childId, platform: "WINDOWS" } });
  $("enrollBox").classList.remove("hide");
  $("enrollCode").textContent = out.code;
  $("enrollMeta").textContent = `expires ${new Date(out.expiresAt).toLocaleTimeString()}`;
  flash("Enrollment code generated");
}

// ---- asks (live via long-poll push; §1) ----
const DURATIONS = [
  { label: "15 min", d: { kind: "MINUTES", minutes: 15 } },
  { label: "30 min", d: { kind: "MINUTES", minutes: 30 } },
  { label: "1 hour", d: { kind: "MINUTES", minutes: 60 } },
  { label: "End of day", d: { kind: "UNTIL_END_OF_DAY" } },
  { label: "Just once", d: { kind: "ONCE" } },
  { label: "Always", d: { kind: "ALWAYS" } },
];
const DEFAULT_DURATION_I = 1; // 30 min — the narrowest-useful default (§3)
const SCOPES = ["THIS_VIDEO", "THIS_CHANNEL", "THIS_URL", "THIS_DOMAIN", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY", "THIS_REQUEST"];

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

let liveActive = false;
let lastCount = -1;

// Long-poll loop: park on the server until an ask arrives or is decided, then
// re-render immediately. Falls back to a short delay + retry on any error.
async function startLiveRequests() {
  if (liveActive) return;
  liveActive = true;
  lastCount = -1;
  while (liveActive && state.familyId) {
    try {
      const out = await api(`/v1/families/${state.familyId}/requests/wait?count=${lastCount}&timeout=25000`);
      renderRequests(out.requests || []);
    } catch {
      // Backend unreachable or auth blip — brief pause, then retry (reconnect).
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function renderRequests(reqs) {
  lastCount = reqs.length;
  $("reqCount").textContent = reqs.length;
  $("liveDot").textContent = "· live";
  const box = $("requests");
  if (!reqs.length) { box.innerHTML = `<div class="empty">No asks right now. New ones appear here the moment a child sends them.</div>`; return; }
  box.innerHTML = reqs.map((r) => renderRequest(r)).join("");
  reqs.forEach((r) => wireRequest(r));
}

function renderRequest(r) {
  const noun = TARGET_NOUN[r.targetType] || "this";
  const human = r.title || `${r.targetType} ${r.targetValue}`;
  const defLabel = DURATIONS[DEFAULT_DURATION_I].label;
  return `<div class="req" id="req-${r.id}">
    <div class="t">${escapeHtml(human)}</div>
    <div class="meta">${escapeHtml(r.targetType)}:${escapeHtml(r.targetValue)}</div>
    ${r.reason ? `<div class="meta">“${escapeHtml(r.reason)}”</div>` : ""}
    ${r.url ? `<details><summary>Details</summary><div class="meta">${escapeHtml(r.url)}</div></details>` : ""}
    <div class="actions">
      <button class="yes" data-yes="${r.id}">Say yes · ${escapeHtml(noun)} · ${defLabel}</button>
      <button class="notnow" data-notnow="${r.id}">Not now</button>
      <button class="ghost" data-change="${r.id}">Change…</button>
    </div>
    <div class="change hide" id="change-${r.id}">
      <label>Open</label>
      <select id="scope-${r.id}">${SCOPES.map((s) => `<option${s === defaultScopeFor(r.targetType) ? " selected" : ""}>${s}</option>`).join("")}</select>
      <label>For how long</label>
      <div class="grid">
        ${DURATIONS.map((x, i) => `<button class="secondary" data-approve="${r.id}" data-di="${i}">${escapeHtml(x.label)}</button>`).join("")}
      </div>
      <div class="grid" style="margin-top:0.4rem">
        <button class="secondary" data-block="${r.id}">Block this</button>
      </div>
    </div>
  </div>`;
}

function wireRequest(r) {
  // Primary: narrowest-useful default (THIS_VIDEO / 30 min), one tap (§3).
  const yes = document.querySelector(`[data-yes="${r.id}"]`);
  if (yes) yes.onclick = () => decide(r.id, "ALLOW", defaultScopeFor(r.targetType), DURATIONS[DEFAULT_DURATION_I].d);
  const notnow = document.querySelector(`[data-notnow="${r.id}"]`);
  if (notnow) notnow.onclick = () => decide(r.id, "BLOCK", "THIS_REQUEST", { kind: "ONCE" });
  const change = document.querySelector(`[data-change="${r.id}"]`);
  if (change) change.onclick = () => $(`change-${r.id}`).classList.toggle("hide");
  // Change… — explicit broaden: parent, not fatigue, chooses the wider scope.
  document.querySelectorAll(`[data-approve="${r.id}"]`).forEach((b) =>
    (b.onclick = () => decide(r.id, "ALLOW", $(`scope-${r.id}`).value, DURATIONS[+b.dataset.di].d)));
  const block = document.querySelector(`[data-block="${r.id}"]`);
  if (block) block.onclick = () => decide(r.id, "BLOCK", "THIS_DOMAIN", { kind: "ALWAYS" });
}

async function decide(requestId, decision, scope, duration) {
  // Optimistic: drop the card immediately so the parent sees the tap land (§1).
  const card = $(`req-${requestId}`); if (card) card.style.opacity = "0.5";
  try {
    await api(`/v1/families/${state.familyId}/requests/${requestId}/decide`, { method: "POST", body: { decision, scope, duration } });
    flash(decision === "ALLOW" ? "Unlocked — the device updates in seconds" : "Left closed");
    // The decide wakes our own long-poll; it re-renders the fresh list.
  } catch (e) { if (card) card.style.opacity = "1"; flash(String(e.message || e)); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Auto-resume a session (api() refreshes a stale access token automatically).
$("backendUrl").value = state.backendUrl;
if (state.token || state.refresh) afterLogin().catch(() => clearTokens());
