/**
 * Minimal App Store Connect API client.
 *
 * ES256 JWT via node:crypto — `ieee-p1363` gives the raw r||s signature JWS
 * requires; the default DER encoding is rejected by Apple with a bare 401.
 *
 * Credentials come from `~/.ajar-signing`, never from this repository: the
 * private key (`AuthKey_<id>.p8`) stays on the machine that holds it. Only the
 * key ID, the issuer ID and the team ID are here, and none of them authenticates
 * anything on its own.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const SIGNING_DIR = process.env.AJAR_SIGNING_DIR ?? `${homedir()}/.ajar-signing`;

// Single source of truth, so rotating the key is one file edit and not a hunt
// through every script. Rotation is expected: an ASC key that has been pasted
// anywhere should be replaced, and the old one 401s the moment it is revoked.
const KEY_ID = readFileSync(`${SIGNING_DIR}/key-id.txt`, "utf8").trim();
const ISSUER = process.env.ASC_ISSUER_ID ?? "117fa8bb-898e-4802-85a8-773631cfb394";
const KEY = readFileSync(`${SIGNING_DIR}/AuthKey_${KEY_ID}.p8`, "utf8");

export { KEY_ID, ISSUER };

const b64u = (b) => Buffer.from(b).toString("base64url");

export function token() {
  const header = b64u(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({
    iss: ISSUER, iat: now, exp: now + 900, aud: "appstoreconnect-v1",
  }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key: KEY, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

export async function asc(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join("; ") ?? text;
    throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}
