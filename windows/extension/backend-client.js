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

  // Generate a device keypair (the backend records the public key at enrollment;
  // device auth uses the returned bearer token).
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
    tokenIssuedAt: Date.now(),
    deviceId: body.device.id,
    childId: body.device.childId,
    signingKeyB64: body.signingPublicKeyB64,
    version: 0,
  });
  await pinTrustAnchor(url, body.signingPublicKeyB64);
  return body.device;
}

/**
 * Device tokens last 30 days and NOTHING renewed them.
 *
 * The renewal endpoint has existed since device tokens were introduced and no
 * client called it, so on day 31 a child's device stopped syncing policy —
 * silently, weeks after anyone touched it — and the only recovery was a parent
 * re-enrolling the device by hand. That is the worst shape a failure can take
 * in this product: enforcement quietly stops being updated while the app still
 * looks enrolled.
 *
 * Renewal has to be PROACTIVE. `/token/refresh` authenticates with the token
 * being replaced, so a device that waits for a 401 has already lost: an expired
 * token cannot mint its successor. The loop below asks a third of the way
 * through the lifetime, which leaves twenty days of failed attempts before
 * anything breaks.
 *
 * A device enrolled before this existed has no issue date recorded. It is
 * treated as due immediately: refreshing a healthy token costs one request, and
 * guessing "probably fine" costs a device that stops filtering.
 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_AFTER_MS = TOKEN_TTL_MS / 3;

export async function refreshDeviceTokenIfDue() {
  const cfg = await getConfig();
  if (!cfg.backendUrl || !cfg.deviceToken || !cfg.deviceId) return false;
  const issued = typeof cfg.tokenIssuedAt === "number" ? cfg.tokenIssuedAt : 0;
  if (Date.now() - issued < TOKEN_REFRESH_AFTER_MS) return false;
  try {
    const res = await fetch(
      `${cfg.backendUrl}/v1/devices/${encodeURIComponent(cfg.deviceId)}/token/refresh`,
      { method: "POST", headers: { authorization: `Bearer ${cfg.deviceToken}` } });
    if (!res.ok) return false; // keep the old token; it may still have weeks left
    const body = await res.json();
    if (!body || typeof body.deviceToken !== "string") return false;
    // The signing key is NOT re-pinned here. Renewal is a routine, unattended
    // call; letting it change the trust anchor would make "wait for a refresh"
    // a way to swap the key that verifies every policy this device enforces.
    // Anchor changes stay a deliberate act at enrollment (trust-anchor.js).
    await setConfig({ deviceToken: body.deviceToken, tokenIssuedAt: Date.now() });
    return true;
  } catch {
    return false; // offline; the old token keeps working and we retry next loop
  }
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
    // Renew before polling, and re-read: the poll below must use the token the
    // refresh may have just replaced, or the first request after a renewal
    // would be the one that fails.
    if (await refreshDeviceTokenIfDue()) cfg = await getConfig();
    try {
      const url = `${cfg.backendUrl}/v1/devices/${cfg.deviceId}/policy/wait?since=${cfg.version ?? 0}&timeout=25000`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (!res.ok) { await sleep(2000); continue; }
      const serverNowMs = Date.parse(res.headers.get("date") ?? "") || Date.now();
      const body = await res.json();
      if (body && body.upToDate) continue; // no change within the window; re-poll
      if (body && typeof body.version === "number") {
        const okSig = await verifySnapshotSignature(body, await getVerifyingKey());
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
    const key = await getVerifyingKey();
    if (!cfg.backendUrl || !cfg.deviceToken || !key) { await sleep(5000); continue; }
    try {
      const since = cfg.filterVersion ?? -1;
      const res = await fetch(`${cfg.backendUrl}/v1/categories/filters?since=${since}`,
        { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
      if (res.ok) {
        const body = await res.json();
        if (body && body.set && body.signature) {
          if (await verifyCanonicalSignature(body.set, body.signature, key)) {
            await setConfig({ filterVersion: body.set.version });
            // The signature travels with the set: the cache it is written to is
            // child-writable, so it has to be re-checkable on the next load.
            onFilters(body.set, body.signature);
          }
        }
      }
    } catch { /* network error → keep the cached set */ }
    await sleep(6 * 60 * 60 * 1000); // refresh a few times a day; version-gated
  }
}

/**
 * Report that a single-use ("just once") grant has been spent.
 *
 * WHY IT MATTERS: without this call `grantKind: "ONCE"` is an unlimited-replay
 * window that happens to be five minutes long, because the five-minute TTL is
 * only the server's BACKSTOP — the grant is meant to end at the first load. The
 * endpoint has existed since the grant semantics landed and nothing called it,
 * which made "just once" the option in the console that did not do what it said.
 *
 * Best-effort by construction: consumption is client-attested (see
 * ApprovalService.consumeGrant), so a failure here costs at most the rest of the
 * backstop window and must never stop the page the parent just approved.
 */
export async function consumeGrant(ruleId) {
  const cfg = await getConfig();
  if (!cfg.backendUrl || !cfg.deviceToken || !cfg.deviceId) return false;
  try {
    const res = await fetch(
      `${cfg.backendUrl}/v1/devices/${encodeURIComponent(cfg.deviceId)}/grants/${encodeURIComponent(ruleId)}/consume`,
      { method: "POST", headers: { authorization: `Bearer ${cfg.deviceToken}` } });
    // 410 GONE means somebody already spent it — the outcome we wanted, so it is
    // a success from here.
    return res.ok || res.status === 410;
  } catch {
    return false;
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

/**
 * What the parent actually decided, for this device's child.
 *
 * The block page used to INFER a refusal from a temporary BLOCK rule sitting in
 * the snapshot — and a refusal writes a grant that expires after five minutes,
 * which the backend then drops. So a refused child saw the answer briefly and
 * then the page went back to "waiting on a parent" for up to a week. This is
 * the server saying what happened instead.
 *
 * Grants nothing and is consulted by no enforcement path: `decide()` still
 * reads only the signed snapshot. This endpoint exists to make a SCREEN honest.
 */
export async function getAnswers() {
  const cfg = await getConfig();
  if (!cfg.backendUrl || !cfg.deviceToken) throw new Error("not enrolled");
  const res = await fetch(`${cfg.backendUrl}/v1/devices/${encodeURIComponent(cfg.deviceId)}/answers`,
    { headers: { authorization: `Bearer ${cfg.deviceToken}` } });
  if (!res.ok) throw new Error(`answers failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.answers) ? body.answers : [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
