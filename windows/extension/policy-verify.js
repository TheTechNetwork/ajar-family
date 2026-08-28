/**
 * Pure policy-snapshot verification for the extension (no chrome APIs, so it is
 * unit-testable under Node). Verifies the backend's Ed25519 signature over the
 * canonical JSON of the snapshot minus its `signature` field — the SAME bytes the
 * backend signs (backend/src/util/canonical.ts + domain/signing.ts). A snapshot
 * that fails verification MUST be rejected (fail closed): it means the cached
 * policy was tampered with or came from the wrong signer.
 */

/** Deterministic JSON: object keys sorted recursively, arrays preserved.
 *  Must match backend/src/util/canonical.ts exactly. */
export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {object} snapshot  DevicePolicySnapshot with a base64 `signature`.
 * @param {string} spkiB64   Backend signing public key (SPKI DER, base64) from GET /v1/signing-key.
 * @returns {Promise<boolean>}
 */
export async function verifySnapshotSignature(snapshot, spkiB64) {
  if (!snapshot || !snapshot.signature) return false;
  const { signature, ...rest } = snapshot;
  return verifyCanonicalSignature(rest, signature, spkiB64);
}

/**
 * Verify an Ed25519 signature over the canonical JSON of `obj` — the bytes
 * `backend/src/domain/signing.ts signCanonical` signs. Used for the category
 * filter asset ({ set, signature }): verify `set` before trusting the filters.
 * @returns {Promise<boolean>}
 */
export async function verifyCanonicalSignature(obj, signatureB64, spkiB64) {
  if (!signatureB64) return false;
  try {
    const key = await crypto.subtle.importKey("spki", b64ToBytes(spkiB64), { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(canonicalJSON(obj));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(signatureB64), data);
  } catch {
    return false;
  }
}
