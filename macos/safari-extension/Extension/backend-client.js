/**
 * Direct-to-backend client for the Safari Web Extension (browser-testable E2E).
 *
 * Same contract as windows/extension/backend-client.js — kept in lockstep — with
 * a namespace shim so it runs under Safari/Firefox (`browser`) and Chromium
 * (`chrome`). In production on macOS the child agent / native host is the policy
 * source and this HTTP path is for development; either way every snapshot is
 * Ed25519-verified (policy-verify.js) before it is trusted (fail closed).
 *
 * WHICH key is the whole question, so it is no longer read from this module's
 * own config: it comes from the PINNED trust anchor (trust-anchor.js) when one
 * exists, and enroll() will not move that pin without the parent setup word.
 */
import { verifySnapshotSignature, verifyCanonicalSignature } from "./policy-verify.js";
import {
  BUNDLED_BACKEND_URL, TrustError, checkParentWord, decideEnrollment, isAllowedBackendUrl,
  isDevMode, normalizeBackendUrl, pinTrustAnchor, readTrustAnchor, trustMessage,
} from "./trust-anchor.js";

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

/**
 * The key this device verifies policy with.
 *
 * The pinned anchor wins over the config copy whenever one exists, so rewriting
 * `backendConfig.signingKeyB64` alone buys an attacker nothing.
 */
export async function getVerifyingKey() {
  const pin = await readTrustAnchor();
  if (pin) return pin.signingKeyB64;
  return (await getConfig()).signingKeyB64;
}

/**
 * Enroll this browser as a device using a one-time code from the parent app.
 *
 * `opts.parentWord` is checked against the stored setup word, and is what makes
 * a change of trust anchor a deliberate act. Enrollment is refused — leaving the
 * existing config untouched — when the anchor says no.
 */
export async function enroll(backendUrl, code, displayName, opts = {}) {
  const url = normalizeBackendUrl(backendUrl);
  const pin = await readTrustAnchor();
  // The address a build ships with, plus the one this device is already pinned
  // to — a device enrolled by an older build must still be able to re-link to
  // its own server without dev mode.
  const allowed = !!url && (url === normalizeBackendUrl(pin?.backendUrl)
    || isAllowedBackendUrl(url, { bundledUrl: BUNDLED_BACKEND_URL, devMode: await isDevMode() }));
  if (!allowed) throw new TrustError("bad-url", trustMessage("bad-url"));

  const unlocked = (await checkParentWord(opts.parentWord)) === true;

  // PRE-FLIGHT, before the one-time code is spent: an attempt we already know we
  // will refuse must not cost the parent their code.
  const pre = decideEnrollment({ pin, backendUrl: url, signingKeyB64: null, unlocked });
  if (!pre.ok) throw new TrustError(pre.reason, trustMessage(pre.reason));

  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const res = await fetch(`${url}/v1/enroll/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, devicePublicKey: b64(spki), displayName }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const body = await res.json();

  // The server has now named its signing key, so decide again. A server that
  // answers with a key this device never pinned does not become trusted merely
  // by having answered.
  const post = decideEnrollment({ pin, backendUrl: url, signingKeyB64: body.signingPublicKeyB64, unlocked });
  if (!post.ok) throw new TrustError(post.reason, trustMessage(post.reason));

  await setConfig({
    backendUrl: url,
    deviceToken: body.deviceToken,
    deviceId: body.device.id,
    childId: body.device.childId,
    signingKeyB64: body.signingPublicKeyB64,
    version: 0,
  });
  await pinTrustAnchor(url, body.signingPublicKeyB64);
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
        if (!(await verifySnapshotSignature(body, await getVerifyingKey()))) { await sleep(2000); continue; }
        await setConfig({ version: body.version });
        onSnapshot(body, serverNowMs);
      }
    } catch {
      await sleep(2000);
    }
  }
}

/** Poll the signed category Bloom-filter asset; hand verified sets to onFilters.
 *  Global dataset, changes rarely → slow, version-gated poll, no per-URL calls. */
export async function startCategoryFilterSync(onFilters) {
  for (;;) {
    const cfg = await getConfig();
    const key = await getVerifyingKey();
    if (!cfg.backendUrl || !cfg.deviceToken || !key) { await sleep(5000); continue; }
    try {
      const res = await fetch(`${cfg.backendUrl}/v1/categories/filters?since=${cfg.filterVersion ?? -1}`,
        { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (res.ok) {
        const body = await res.json();
        if (body && body.set && body.signature &&
            await verifyCanonicalSignature(body.set, body.signature, key)) {
          await setConfig({ filterVersion: body.set.version });
          // The signature travels with the set: the cache it is written to is
          // child-writable, so it has to be re-checkable on the next load.
          onFilters(body.set, body.signature);
        }
      }
    } catch { /* keep cached set */ }
    await sleep(6 * 60 * 60 * 1000);
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
