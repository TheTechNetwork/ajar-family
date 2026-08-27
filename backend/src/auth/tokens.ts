/**
 * Minimal bearer tokens for the alpha, using WebCrypto HMAC-SHA256 so they work
 * on Node and Workers. Format: base64url(payloadJSON).base64url(hmac). Short-lived
 * access tokens; production adds refresh-token rotation, Sign in with Apple, and
 * passkeys (see docs/ARCHITECTURE.md §7).
 */
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string; familyId: string; childId: string };

interface Payload extends Record<string, unknown> { exp: number }

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueToken(secret: string, principal: Principal, ttlSeconds = 3600): Promise<string> {
  const payload: Payload = { ...principal, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken(secret: string, token: string): Promise<Principal | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig), enc.encode(body));
  if (!ok) return null;
  let payload: Payload;
  try { payload = JSON.parse(Buffer.from(unb64url(body)).toString("utf8")); } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.kind === "user" && typeof payload.userId === "string")
    return { kind: "user", userId: payload.userId };
  if (payload.kind === "device" && typeof payload.deviceId === "string")
    return { kind: "device", deviceId: payload.deviceId as string, familyId: payload.familyId as string, childId: payload.childId as string };
  return null;
}
