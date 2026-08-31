/**
 * Direct-to-backend client for the extension (browser-testable end-to-end path).
 *
 * In production on Windows, the LocalSystem service is the policy source and this
 * HTTP path is optional; for development you can point the extension straight at
 * the backend (options page) and exercise the whole loop in Chrome/Edge:
 *   enroll → long-poll /policy/wait (verified, signed) → evaluate → on block POST
 *   /v1/requests → refresh when the approval lands.
 *
 * Every snapshot is Ed25519-verified (policy-verify.js) against the backend's
 * signing key before it is trusted — fail closed on a bad signature.
 */
import { verifySnapshotSignature, verifyCanonicalSignature } from "./policy-verify.js";

const CFG_KEY = "backendConfig";

/** @returns {Promise<{backendUrl?:string,deviceToken?:string,deviceId?:string,childId?:string,signingKeyB64?:string,version?:number}>} */
export async function getConfig() {
  const v = await chrome.storage.local.get(CFG_KEY);
  return v[CFG_KEY] ?? {};
}
async function setConfig(patch) {
  const cur = await getConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [CFG_KEY]: next });
  return next;
}
export async function clearConfig() {
  await chrome.storage.local.remove(CFG_KEY);
}

function b64(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

/** Enroll this browser as a device using a one-time code from the parent app. */
export async function enroll(backendUrl, code, displayName) {
  // Generate a device keypair (the backend records the public key at enrollment;
  // device auth uses the returned bearer token).
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

/**
 * Long-poll the backend for policy changes forever. Calls
 * `onSnapshot(snapshot, serverNowMs)` for each new, signature-verified snapshot.
 * Cross-runtime (no streaming): returns the new snapshot the instant an approval
 * bumps the version, else times out and re-polls.
 */
export async function startPolicySync(onSnapshot) {
  for (;;) {
    let cfg = await getConfig();
    if (!cfg.backendUrl || !cfg.deviceToken || !cfg.deviceId) {
      await sleep(3000);
      continue;
    }
    try {
      const url = `${cfg.backendUrl}/v1/devices/${cfg.deviceId}/policy/wait?since=${cfg.version ?? 0}&timeout=25000`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (!res.ok) { await sleep(2000); continue; }
      const serverNowMs = Date.parse(res.headers.get("date") ?? "") || Date.now();
      const body = await res.json();
      if (body && body.upToDate) continue; // no change within the window; re-poll
      if (body && typeof body.version === "number") {
        const okSig = await verifySnapshotSignature(body, cfg.signingKeyB64);
        if (!okSig) { await sleep(2000); continue; } // fail closed on bad signature
        await setConfig({ version: body.version });
        onSnapshot(body, serverNowMs);
      }
    } catch {
      await sleep(2000); // network error → back off, keep enforcing cached policy
    }
  }
}

/**
 * Poll the signed category Bloom-filter asset and hand verified sets to
 * `onFilters(rawSet)`. Separate from policy sync because the dataset is global
 * and changes rarely; a slow poll keeps the compact membership data fresh with
 * no per-URL calls. Fails closed on a bad signature (keeps the cached set).
 */
export async function startCategoryFilterSync(onFilters) {
  for (;;) {
    let cfg = await getConfig();
    if (!cfg.backendUrl || !cfg.deviceToken || !cfg.signingKeyB64) { await sleep(5000); continue; }
    try {
      const since = cfg.filterVersion ?? -1;
      const res = await fetch(`${cfg.backendUrl}/v1/categories/filters?since=${since}`,
        { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (res.ok) {
        const body = await res.json();
        if (body && body.set && body.signature) {
          if (await verifyCanonicalSignature(body.set, body.signature, cfg.signingKeyB64)) {
            await setConfig({ filterVersion: body.set.version });
            onFilters(body.set);
          }
        }
      }
    } catch { /* network error → keep the cached set */ }
    await sleep(6 * 60 * 60 * 1000); // refresh a few times a day; version-gated
  }
}

/** Post an access request from the block page. */
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
