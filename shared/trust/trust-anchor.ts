/**
 * TRUST ANCHOR — which server, and which signing key, a device believes.
 *
 * Every client verifies policy snapshots with an Ed25519 public key. That proves
 * "this came from the server I am configured to trust" and nothing more, so the
 * whole guarantee rests on who gets to choose that key. Until this module, the
 * answer on both browser extensions was: whoever can open the options page —
 * i.e. the child. Disconnect wiped the config, re-connecting against any address
 * adopted that server's key, and correctly-signed allow-all policy sailed
 * through every check.
 *
 * So the key is PINNED at first enrollment, and moving the pin is a decision,
 * not a default:
 *
 *   - first enrollment on a fresh install pins {backendUrl, signingKeyB64};
 *   - re-enrolling against the SAME address and the SAME key is free (a parent
 *     re-linking a device after a wipe should not need anything extra);
 *   - a DIFFERENT address or a DIFFERENT key needs the parent setup word;
 *   - the pin survives Disconnect. Disconnect stops enforcement here; it does
 *     not hand the next person the right to pick a new signer.
 *
 * This file is the SPEC. windows/extension/trust-anchor.js and
 * apple/SafariExtension/Extension/trust-anchor.js are hand-written mirrors of
 * it (the extensions have no build step and cannot import from here), and
 * tools/conformance/run-trust-anchor.mjs runs shared/trust/trust-vectors.ts against
 * all three, so they cannot silently disagree.
 *
 * WHAT THIS CANNOT DO. The pin lives in extension storage, which the child's own
 * browser can read and write from a devtools console. A page cannot defend
 * against a debugger attached to itself. What this changes is the cost: the
 * bypass stops being two clicks in a supported UI and becomes deliberate
 * tampering with the client's storage. Written down in docs/SECURITY.md.
 */

/** The pinned anchor, as stored on the device. */
export interface TrustPin {
  v: 1;
  /** Normalized backend origin (+ optional path prefix), no trailing slash. */
  backendUrl: string;
  /** Ed25519 SPKI public key, base64 — the only key this device will verify with. */
  signingKeyB64: string;
  pinnedAt?: string;
}

export interface EnrollAttempt {
  /** The device's current pin, or null on a fresh install. */
  pin: TrustPin | null;
  /** Address being enrolled against. */
  backendUrl: string;
  /**
   * The signing key the server answered with, or null for the PRE-FLIGHT check
   * that runs before the one-time code is redeemed. Pre-flight exists so an
   * attempt we already know we will refuse does not burn the parent's code.
   */
  signingKeyB64: string | null;
  /** True only when the parent setup word was verified against the stored hash. */
  unlocked: boolean;
}

export type TrustReason =
  | "first-enrollment"      // nothing pinned yet: this enrollment sets the anchor
  | "same-anchor"           // same address, same key — no change of trust
  | "preflight-same-server" // pre-flight against the pinned address; key not known yet
  | "rotate-authorized"     // different address and/or key, and the word checked out
  | "needs-parent-word"     // different address and/or key, and it did not
  | "bad-url";              // not a usable http(s) address

export interface TrustDecision {
  ok: boolean;
  reason: TrustReason;
}

/**
 * Normalize an address for comparison against the pin. Returns null for
 * anything that is not an http(s) URL, so a `javascript:` or `data:` string can
 * never become a backend address.
 */
export function normalizeBackendUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Is this an address this build is willing to talk to at all?
 *
 * The precedent is web/parent/app.js resolveBackendUrl(): the console honours an
 * `?api=` override ONLY when `localStorage.cf_dev === "1"`, so the affordance
 * exists for development and is off in every build nobody deliberately switched
 * on. Same call here — a shipped build talks to the address baked into the
 * bundle and nothing else; a developer sets `ajarDevMode` in extension storage
 * to point it somewhere else.
 *
 * `devMode` is not a security boundary (a child with a devtools console can set
 * that flag too). It is what stops "type a different address" from being an
 * ordinary, supported step in the shipped UI. The pin is the part that still
 * costs the parent's word even once dev mode is on.
 */
export function isAllowedBackendUrl(
  raw: string | null | undefined,
  opts: { bundledUrl: string; devMode?: boolean },
): boolean {
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

/** Should this enrollment be allowed to write config and (re)pin the anchor? */
export function decideEnrollment(a: EnrollAttempt): TrustDecision {
  const url = normalizeBackendUrl(a.backendUrl);
  if (!url) return { ok: false, reason: "bad-url" };
  if (!a.pin) return { ok: true, reason: "first-enrollment" };

  const sameServer = url === normalizeBackendUrl(a.pin.backendUrl);
  if (sameServer && a.signingKeyB64 === null) {
    // Pre-flight against the pinned address: the key is not known yet, and a
    // server that answers with the pinned key needs nothing further.
    return { ok: true, reason: "preflight-same-server" };
  }
  if (sameServer && a.signingKeyB64 === a.pin.signingKeyB64) {
    return { ok: true, reason: "same-anchor" };
  }
  return a.unlocked
    ? { ok: true, reason: "rotate-authorized" }
    : { ok: false, reason: "needs-parent-word" };
}

export interface UnenrollDecision {
  ok: boolean;
  reason: "unlocked" | "needs-parent-word" | "no-word-set";
  /**
   * Whether Disconnect should also drop the pin. Normally it should NOT — the
   * anchor outliving the device config is the whole point. The exception is a
   * device with no setup word saved (an install from before the word existed):
   * there is nothing to authenticate a later re-pin with, so keeping the anchor
   * would only lock the parent out of their own device while stopping nobody.
   */
  clearAnchor: boolean;
}

export function decideUnenroll(a: { hasWord: boolean; unlocked: boolean }): UnenrollDecision {
  if (!a.hasWord) return { ok: true, reason: "no-word-set", clearAnchor: true };
  if (a.unlocked) return { ok: true, reason: "unlocked", clearAnchor: false };
  return { ok: false, reason: "needs-parent-word", clearAnchor: false };
}
