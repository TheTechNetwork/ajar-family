/**
 * Parent Console — a minimal static web UI for the approval workflow, so the MVP
 * loop is clickable in a browser (the production parent experience is the iOS app;
 * a web admin was noted as optional in the brief). Talks to the backend REST API
 * with a bearer token; requires CORS on the backend (enabled for the alpha).
 */
const $ = (id) => document.getElementById(id);
const state = {
  backendUrl: localStorage.getItem("cf_backend") || "http://localhost:8787",
  token: localStorage.getItem("cf_token") || null,
  familyId: localStorage.getItem("cf_family") || null,
};

function flash(msg) {
  const f = $("flash"); f.textContent = msg; f.classList.add("show");
  setTimeout(() => f.classList.remove("show"), 1800);
}
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(state.backendUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
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
    const out = register
      ? await api("/v1/auth/register", { method: "POST", auth: false, body: { email, displayName: $("name").value.trim() || email } })
      : await api("/v1/auth/login", { method: "POST", auth: false, body: { email } });
    state.token = out.token; localStorage.setItem("cf_token", out.token);
    await afterLogin();
  } catch (e) { $("authErr").textContent = String(e.message || e); }
}

async function afterLogin() {
  const me = await api("/v1/me");
  $("who").textContent = `${me.displayName} · ${me.email}`;
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
    `<button class="${f.familyId === state.familyId ? "" : "secondary"}" data-fid="${f.familyId}">${f.family?.name ?? f.familyId} · ${f.role}</button>`
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
  startPolling();
  const me = await api("/v1/me"); renderFamilyPick(me.families);
}

// ---- children + enrollment ----
async function refreshChildren() {
  const kids = await api(`/v1/families/${state.familyId}/children`);
  $("children").innerHTML = kids.length
    ? kids.map((k) => `<div class="row" style="margin:0.25rem 0"><div>${k.displayName}</div><div style="flex:0"><button class="secondary" data-cid="${k.id}">Enroll a device</button></div></div>`).join("")
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

// ---- requests (polled) ----
const DURATIONS = [
  { label: "15m", d: { kind: "MINUTES", minutes: 15 } },
  { label: "30m", d: { kind: "MINUTES", minutes: 30 } },
  { label: "1h", d: { kind: "MINUTES", minutes: 60 } },
  { label: "End of day", d: { kind: "UNTIL_END_OF_DAY" } },
  { label: "Once", d: { kind: "ONCE" } },
  { label: "Always", d: { kind: "ALWAYS" } },
];
let pollTimer = null;
function startPolling() { if (pollTimer) clearInterval(pollTimer); refreshRequests(); pollTimer = setInterval(refreshRequests, 3000); }

async function refreshRequests() {
  let reqs;
  try { reqs = await api(`/v1/families/${state.familyId}/requests?status=PENDING`); } catch { return; }
  $("reqCount").textContent = reqs.length;
  const box = $("requests");
  if (!reqs.length) { box.innerHTML = `<div class="empty">No pending requests. Approvals appear here in real time.</div>`; return; }
  box.innerHTML = reqs.map((r) => renderRequest(r)).join("");
  reqs.forEach((r) => wireRequest(r));
}
function renderRequest(r) {
  const scopes = ["THIS_VIDEO", "THIS_CHANNEL", "THIS_URL", "THIS_DOMAIN", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY", "THIS_REQUEST"];
  return `<div class="req" id="req-${r.id}">
    <div class="t">${escapeHtml(r.title || r.targetType)} <span class="pill">${r.targetType}:${escapeHtml(r.targetValue)}</span></div>
    <div class="meta">${escapeHtml(r.url || "")}</div>
    ${r.reason ? `<div class="meta">“${escapeHtml(r.reason)}”</div>` : ""}
    <label>Scope</label>
    <select id="scope-${r.id}">${scopes.map((s) => `<option${s === "THIS_VIDEO" ? " selected" : ""}>${s}</option>`).join("")}</select>
    <div class="actions">
      ${DURATIONS.map((x, i) => `<button class="ok" data-approve="${r.id}" data-di="${i}">Allow ${x.label}</button>`).join("")}
      <button class="danger" data-deny="${r.id}">Deny</button>
    </div>
  </div>`;
}
function wireRequest(r) {
  document.querySelectorAll(`[data-approve="${r.id}"]`).forEach((b) => (b.onclick = () => decide(r.id, "ALLOW", DURATIONS[+b.dataset.di].d)));
  const deny = document.querySelector(`[data-deny="${r.id}"]`);
  if (deny) deny.onclick = () => decide(r.id, "BLOCK", { kind: "ALWAYS" });
}
async function decide(requestId, decision, duration) {
  const scope = $(`scope-${requestId}`).value;
  try {
    await api(`/v1/families/${state.familyId}/requests/${requestId}/decide`, { method: "POST", body: { decision, scope, duration } });
    flash(decision === "ALLOW" ? "Approved — child device will update in seconds" : "Denied");
    refreshRequests();
  } catch (e) { flash(String(e.message || e)); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Auto-resume a session.
$("backendUrl").value = state.backendUrl;
if (state.token) afterLogin().catch(() => { state.token = null; localStorage.removeItem("cf_token"); });
