/**
 * Ed25519 signing of policy snapshots (ADR-010), using **WebCrypto** so the same
 * code runs on Node 22 (local/alpha) and on Cloudflare Workers (deploy target).
 * The backend holds the private key; devices ship the public key and verify every
 * snapshot, failing CLOSED on a bad signature so a child cannot forge an approval
 * or edit the cache.
 *
 * Keys are carried as base64 of the raw SPKI (public) / PKCS8 (private) DER, which
 * both runtimes' WebCrypto can import.
 */
import { canonicalJSON } from "../util/canonical.js";
import type { DevicePolicySnapshot } from "@ajar/shared/policy";

const ALG = { name: "Ed25519" } as const;
const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
/** Returns a plain ArrayBuffer (not SharedArrayBuffer) so WebCrypto's BufferSource types are satisfied. */
const unb64 = (s: string): ArrayBuffer => {
  const b = Buffer.from(s, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export interface SigningKeyPair {
  publicKeyB64: string; // SPKI DER, base64
  privateKeyB64: string; // PKCS8 DER, base64
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  return { publicKeyB64: b64(spki), privateKeyB64: b64(pkcs8) };
}

/** Canonical bytes the signature covers: the snapshot minus its own signature. */
export function snapshotSigningBytes(snapshot: DevicePolicySnapshot): ArrayBuffer {
  const { signature: _omit, ...rest } = snapshot;
  const u = new TextEncoder().encode(canonicalJSON(rest));
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export async function signSnapshot(
  snapshot: DevicePolicySnapshot,
  privateKeyB64: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), ALG, false, ["sign"]);
  const sig = await crypto.subtle.sign(ALG, key, snapshotSigningBytes(snapshot));
  return b64(sig);
}

/** Sign any JSON value over its canonical serialization (same key + alg as
 *  snapshots). Used for the category filter asset devices fetch separately. */
export async function signCanonical(obj: unknown, privateKeyB64: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), ALG, false, ["sign"]);
  const u = new TextEncoder().encode(canonicalJSON(obj));
  const bytes = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  return b64(await crypto.subtle.sign(ALG, key, bytes));
}

/** Verify a `signCanonical` signature over any JSON value. */
export async function verifyCanonical(obj: unknown, signature: string, publicKeyB64: string): Promise<boolean> {
  if (!signature) return false;
  try {
    const key = await crypto.subtle.importKey("spki", unb64(publicKeyB64), ALG, false, ["verify"]);
    const u = new TextEncoder().encode(canonicalJSON(obj));
    const bytes = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    return await crypto.subtle.verify(ALG, key, unb64(signature), bytes);
  } catch {
    return false;
  }
}

export async function verifySnapshot(
  snapshot: DevicePolicySnapshot,
  publicKeyB64: string,
): Promise<boolean> {
  if (!snapshot.signature) return false;
  try {
    const key = await crypto.subtle.importKey("spki", unb64(publicKeyB64), ALG, false, ["verify"]);
    return await crypto.subtle.verify(ALG, key, unb64(snapshot.signature), snapshotSigningBytes(snapshot));
  } catch {
    return false;
  }
}
