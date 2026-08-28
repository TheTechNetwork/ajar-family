/**
 * Direct-to-backend client for the Safari Web Extension (browser-testable E2E).
 *
 * Same contract as windows/extension/backend-client.js — kept in lockstep — with
 * a namespace shim so it runs under Safari/Firefox (`browser`) and Chromium
 * (`chrome`). In production on macOS the child agent / native host is the policy
 * source and this HTTP path is for development; either way every snapshot is
 * Ed25519-verified (policy-verify.js) before it is trusted (fail closed).
 */
import { verifySnapshotSignature } from "./policy-verify.js";

const ext = globalThis.browser ?? globalThis.chrome;
const store = ext.storage.local;
const CFG_KEY = "backendConfig";

export async function getConfig() {
  const v = await store.get(CFG_KEY);
  return v[CFG_KEY] ?? {};
}
async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await store.set({ [CFG_KEY]: next });
  return next;
}
export async function clearConfig() {
  await store.remove(CFG_KEY);
}

function b64(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export async function enroll(backendUrl, code, displayName) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const res = await fetch(`${backendUrl}/v1/enroll/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, devicePublicKey: b64(spki), displayName }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  await setConfig({
    backendUrl,
    deviceToken: body.deviceToken,
    deviceId: body.device.id,
    childId: body.device.childId,
    signingKeyB64: body.signingPublicKeyB64,
    version: 0,
  });
  return body.device;
}

/** Long-poll the backend forever; call onSnapshot(snapshot, serverNowMs) per
 *  new, signature-verified snapshot. */
export async function startPolicySync(onSnapshot) {
  for (;;) {
    const cfg = await getConfig();
    if (!cfg.backendUrl || !cfg.deviceToken || !cfg.deviceId) { await sleep(3000); continue; }
    try {
      const url = `${cfg.backendUrl}/v1/devices/${cfg.deviceId}/policy/wait?since=${cfg.version ?? 0}&timeout=25000`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (!res.ok) { await sleep(2000); continue; }
      const serverNowMs = Date.parse(res.headers.get("date") ?? "") || Date.now();
      const body = await res.json();
      if (body && body.upToDate) continue;
      if (body && typeof body.version === "number") {
        if (!(await verifySnapshotSignature(body, cfg.signingKeyB64))) { await sleep(2000); continue; }
        await setConfig({ version: body.version });
        onSnapshot(body, serverNowMs);
      }
    } catch {
      await sleep(2000);
    }
  }
}

export async function postAccessRequest({ targetType, targetValue, title, url, reason }) {
  const cfg = await getConfig();
  if (!cfg.backendUrl || !cfg.deviceToken) throw new Error("not enrolled");
  const res = await fetch(`${cfg.backendUrl}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.deviceToken}` },
    body: JSON.stringify({ targetType, targetValue, title, url, reason }),
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
