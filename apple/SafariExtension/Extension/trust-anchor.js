/**
 * ajar — the device's trust anchor (macOS Safari Web Extension).
 *
 * HAND-WRITTEN MIRROR of shared/trust/trust-anchor.ts. Read that file for why
 * this exists; the short version is that verifying a signature only proves
 * "from the server I am configured to trust", and until this module the child
 * chose which server that was. The decision functions here must agree with the
 * shared TypeScript vector-for-vector — tools/conformance/run-trust-anchor.mjs runs
 * shared/trust/trust-vectors.ts against this file and its Windows twin on every
 * CI run, so drift fails the build instead of shipping.
 *
 * Kept in lockstep with windows/extension/trust-anchor.js. The only intended
 * difference between the two is the namespace shim on the next few lines.
 *
 * No extension APIs are used by the decision half of this file, so it is
 * directly unit-testable under Node.
 */

const ext = globalThis.browser ?? globalThis.chrome;

/**
 * The address a build talks to.
 *
 * Precedent: web/parent/app.js resolveBackendUrl() honours an `?api=` override
 * only when `localStorage.cf_dev === "1"`. Same call here — the shipped UI
 * offers no way to type a different address; a developer opts in explicitly
 * with `browser.storage.local.set({ ajarDevMode: "1" })`.
 *
 * THE REAL ORIGIN, not a placeholder. This was `http://localhost:8787` — "the
 * alpha has no hosted backend" — long after `backend/wrangler.toml` bound
 * `api.ajar.family`. And `isAllowedBackendUrl` returned true for the bundled
 * address unconditionally, so a shipped build accepted an enrolment against
 * anything the child ran on port 8787: their own server, their own signing key,
 * their own policy, reachable from the extension's options page with six digits
 * they made up. The constant that was supposed to make the address untypeable
 * was the thing that allowed it.
 *
 * Local development points elsewhere the documented way — turn dev mode on
 * (`browser.storage.local.set({ ajarDevMode: "1" })`) and loopback is allowed
 * again. That is one deliberate step for a developer and no step at all for a
 * child, which is the difference that was missing.
 */
export const BUNDLED_BACKEND_URL = "https://api.ajar.family";

/**
 * The application id passed to `sendNativeMessage`.
 *
 * IT CANNOT BE THE BUNDLE ID, because there are two: this same extension ships
 * as `family.ajar.filter.SafariExtension` inside the iOS filter app and as
 * `family.ajar.safari.Extension` inside the macOS container. Safari does not
 * route on this value — it delivers to the containing app's
 * SFSafariWebExtensionHandler whichever host it is running in — so the argument
 * exists to satisfy the API, not to select a target.
 *
 * Kept in one place anyway, and imported by background.js and options.js, so
 * nobody "corrects" one copy to a bundle id and leaves the other behind.
 */
export const NATIVE_APP_ID = "family.ajar.safari.Extension";

/** Storage keys. The anchor and the setup word both OUTLIVE Disconnect. */
export const ANCHOR_KEY = "ajarTrustAnchor";
export const WORD_KEY = "ajarParentLock";   // name kept for installs that have one
const DEV_KEY = "ajarDevMode";

const PBKDF2_ITERATIONS = 210000;

/** Thrown by enroll() when the anchor says no. `reason` is a TrustReason. */
export class TrustError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "TrustError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Decisions — mirror of shared/trust/trust-anchor.ts. The behaviour has to be
// identical; the code does not.
// ---------------------------------------------------------------------------

export function normalizeBackendUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isAllowedBackendUrl(raw, opts) {
  const url = normalizeBackendUrl(raw);
  if (!url) return false;
  const host = new URL(url).hostname.toLowerCase();
  const bundled = normalizeBackendUrl(opts.bundledUrl);

  // THE BUNDLED ADDRESS IS TRUSTED BECAUSE IT IS HTTPS, NOT BECAUSE IT IS
  // BUNDLED. This used to `return true` for the bundled URL unconditionally,
  // and the value shipping in trust-anchor.js is the development placeholder
  // "http://localhost:8787". So in a shipped build, with dev mode off, a child
  // who ran any server on port 8787 could enrol the extension against it from
  // the options page — six digits they made up, their own signing key, and every
  // "policy" the browser then trusted was theirs. The check that was supposed to
  // make the address untypeable was the thing that allowed it.
  //
  // A loopback bundle is now refused outside dev mode like any other plaintext
  // origin, so the placeholder cannot become a bypass if a build ships before
  // the real origin is baked in.
  if (bundled && url === bundled && url.startsWith("https://")) return true;

  if (!opts.devMode) return false;
  // Dev builds may point anywhere, but plaintext stays loopback-only: policy is
  // signed, yet a device bearer token in the clear on a shared network is not
  // something a dev flag should quietly enable.
  return url.startsWith("https://") || LOOPBACK.has(host);
}

export function decideEnrollment(a) {
  const url = normalizeBackendUrl(a.backendUrl);
  if (!url) return { ok: false, reason: "bad-url" };
  if (!a.pin) return { ok: true, reason: "first-enrollment" };

  const sameServer = url === normalizeBackendUrl(a.pin.backendUrl);
  if (sameServer && a.signingKeyB64 === null) return { ok: true, reason: "preflight-same-server" };
  if (sameServer && a.signingKeyB64 === a.pin.signingKeyB64) return { ok: true, reason: "same-anchor" };
  return a.unlocked
    ? { ok: true, reason: "rotate-authorized" }
    : { ok: false, reason: "needs-parent-word" };
}

export function decideUnenroll(a) {
  if (!a.hasWord) return { ok: true, reason: "no-word-set", clearAnchor: true };
  if (a.unlocked) return { ok: true, reason: "unlocked", clearAnchor: false };
  return { ok: false, reason: "needs-parent-word", clearAnchor: false };
}

/** Copy a family reads when the anchor refuses. Plain, no blame (docs/BRAND.md). */
export function trustMessage(reason) {
  switch (reason) {
    case "needs-parent-word":
      return "This browser is already set up for a different ajar address. A parent's setup word is needed to point it somewhere else.";
    case "bad-url":
      return "That server address can't be used. Leave it as it is unless a parent told you to change it.";
    default:
      return "This browser can't be connected that way.";
  }
}

// ---------------------------------------------------------------------------
// Storage side. chrome.storage.local is the child's own profile, so everything
// below is tamper-visible to a devtools console — see the honesty note in
// shared/trust/trust-anchor.ts and docs/SECURITY.md.
// ---------------------------------------------------------------------------

export async function readTrustAnchor() {
  try {
    const v = (await ext.storage.local.get(ANCHOR_KEY))[ANCHOR_KEY];
    if (!v || typeof v.signingKeyB64 !== "string" || typeof v.backendUrl !== "string") return null;
    return v;
  } catch { return null; }
}

export async function pinTrustAnchor(backendUrl, signingKeyB64) {
  await ext.storage.local.set({
    [ANCHOR_KEY]: {
      v: 1,
      backendUrl: normalizeBackendUrl(backendUrl) ?? backendUrl,
      signingKeyB64,
      pinnedAt: new Date().toISOString(),
    },
  });
}

export async function clearTrustAnchor() {
  await ext.storage.local.remove(ANCHOR_KEY);
}

/** Dev affordance, off unless someone deliberately switched it on. */
export async function isDevMode() {
  try { return (await ext.storage.local.get(DEV_KEY))[DEV_KEY] === "1"; }
  catch { return false; }
}

// ---- the parent setup word -------------------------------------------------

const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(word, saltBytes, iterations) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(word), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, material, 256);
  return b64(bits);
}

export async function setParentWord(word) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(word, salt, PBKDF2_ITERATIONS);
  await ext.storage.local.set({
    [WORD_KEY]: { v: 1, salt: b64(salt), iterations: PBKDF2_ITERATIONS, hash },
  });
}

export async function getParentWordRecord() {
  try { return (await ext.storage.local.get(WORD_KEY))[WORD_KEY] || null; }
  catch { return null; }
}

export async function hasParentWord() {
  return (await getParentWordRecord()) !== null;
}

/** @returns true / false, or null when there is no word to check against. */
export async function checkParentWord(word) {
  const rec = await getParentWordRecord();
  if (!rec || !word) return rec ? false : null;
  const got = await derive(word, unb64(rec.salt), rec.iterations || PBKDF2_ITERATIONS);
  // Constant-time-ish compare. Both strings are fixed-length base64 of 32 bytes.
  if (got.length !== rec.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}
