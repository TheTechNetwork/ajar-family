/**
 * CROSS-IMPLEMENTATION TRUST-ANCHOR VECTORS.
 *
 * Same idea as shared/conformance/vectors.ts, for the other thing three
 * codebases have to agree about: when a device is allowed to change which
 * server and which signing key it trusts. The shared TypeScript is the spec; the
 * two extension `trust-anchor.js` files are hand-written mirrors of it.
 * tools/conformance/run-mirrors.mjs runs every vector below against every
 * implementation, so "the Mac build lets you re-point it and Windows doesn't"
 * fails CI instead of shipping.
 */
import type { EnrollAttempt, TrustReason, UnenrollDecision } from "./trust-anchor.js";

const PIN = {
  v: 1 as const,
  backendUrl: "https://api.ajar.family",
  signingKeyB64: "PINNEDKEY==",
  pinnedAt: "2026-01-01T00:00:00.000Z",
};

export interface EnrollVector {
  name: string;
  attempt: EnrollAttempt;
  expect: { ok: boolean; reason: TrustReason };
}

export const ENROLL_VECTORS: EnrollVector[] = [
  { name: "fresh install pins whatever it first enrolls against",
    attempt: { pin: null, backendUrl: "https://api.ajar.family", signingKeyB64: "K1", unlocked: false },
    expect: { ok: true, reason: "first-enrollment" } },

  { name: "re-enrolling against the same server and key needs no word",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family", signingKeyB64: "PINNEDKEY==", unlocked: false },
    expect: { ok: true, reason: "same-anchor" } },

  { name: "a trailing slash is the same address",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family/", signingKeyB64: "PINNEDKEY==", unlocked: false },
    expect: { ok: true, reason: "same-anchor" } },

  { name: "pre-flight against the pinned address gets as far as redeeming",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family", signingKeyB64: null, unlocked: false },
    expect: { ok: true, reason: "preflight-same-server" } },

  // ---- the hole this module exists to close -------------------------------
  { name: "THE BYPASS: another server, no word — refused before the code is spent",
    attempt: { pin: PIN, backendUrl: "https://evil.example", signingKeyB64: null, unlocked: false },
    expect: { ok: false, reason: "needs-parent-word" } },

  { name: "THE BYPASS: another server answering with its own key, no word — refused",
    attempt: { pin: PIN, backendUrl: "https://evil.example", signingKeyB64: "ATTACKERKEY==", unlocked: false },
    expect: { ok: false, reason: "needs-parent-word" } },

  { name: "the pinned address answering with a DIFFERENT key, no word — refused",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family", signingKeyB64: "ATTACKERKEY==", unlocked: false },
    expect: { ok: false, reason: "needs-parent-word" } },

  { name: "same host, different port is a different server",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family:8443", signingKeyB64: "PINNEDKEY==", unlocked: false },
    expect: { ok: false, reason: "needs-parent-word" } },

  { name: "http:// is not the pinned https:// address",
    attempt: { pin: PIN, backendUrl: "http://api.ajar.family", signingKeyB64: "PINNEDKEY==", unlocked: false },
    expect: { ok: false, reason: "needs-parent-word" } },

  // ---- the parent's way through -------------------------------------------
  { name: "with the setup word, a parent can move the device to another server",
    attempt: { pin: PIN, backendUrl: "https://api2.ajar.family", signingKeyB64: "K2", unlocked: true },
    expect: { ok: true, reason: "rotate-authorized" } },

  { name: "with the setup word, a rotated server key is accepted",
    attempt: { pin: PIN, backendUrl: "https://api.ajar.family", signingKeyB64: "ROTATED==", unlocked: true },
    expect: { ok: true, reason: "rotate-authorized" } },

  // ---- addresses that are not addresses -----------------------------------
  { name: "a javascript: string is never a backend",
    attempt: { pin: null, backendUrl: "javascript:alert(1)", signingKeyB64: "K1", unlocked: true },
    expect: { ok: false, reason: "bad-url" } },
  { name: "empty address is refused even on a fresh install",
    attempt: { pin: null, backendUrl: "", signingKeyB64: "K1", unlocked: true },
    expect: { ok: false, reason: "bad-url" } },
];

export interface UnenrollVector {
  name: string;
  input: { hasWord: boolean; unlocked: boolean };
  expect: UnenrollDecision;
}

export const UNENROLL_VECTORS: UnenrollVector[] = [
  { name: "no word typed, a word is set — Disconnect does nothing",
    input: { hasWord: true, unlocked: false },
    expect: { ok: false, reason: "needs-parent-word", clearAnchor: false } },
  { name: "the word checks out — Disconnect runs, the anchor stays pinned",
    input: { hasWord: true, unlocked: true },
    expect: { ok: true, reason: "unlocked", clearAnchor: false } },
  { name: "no word was ever set — Disconnect runs and drops the anchor with it",
    input: { hasWord: false, unlocked: false },
    expect: { ok: true, reason: "no-word-set", clearAnchor: true } },
];

export interface UrlVector {
  name: string;
  url: string;
  devMode: boolean;
  expect: boolean;
}

/** The bundled address these vectors are written against. */
export const VECTOR_BUNDLED_URL = "https://api.ajar.family";

export const URL_VECTORS: UrlVector[] = [
  { name: "the bundled address is always allowed", url: "https://api.ajar.family", devMode: false, expect: true },
  { name: "…with a trailing slash", url: "https://api.ajar.family/", devMode: false, expect: true },
  { name: "anything else is refused in a shipped build", url: "https://evil.example", devMode: false, expect: false },
  { name: "loopback is refused in a shipped build too", url: "http://localhost:8787", devMode: false, expect: false },
  { name: "dev mode allows loopback", url: "http://localhost:8787", devMode: true, expect: true },
  { name: "dev mode allows https anywhere", url: "https://staging.example", devMode: true, expect: true },
  { name: "dev mode still refuses plaintext to a remote host", url: "http://staging.example", devMode: true, expect: false },
  { name: "a file: URL is never allowed", url: "file:///etc/passwd", devMode: true, expect: false },
];
