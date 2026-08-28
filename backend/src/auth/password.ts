/**
 * Self-contained password hashing — no external identity provider. PBKDF2-HMAC-
 * SHA-256 via WebCrypto, so it runs identically on Node and Cloudflare Workers.
 *
 * Stored form is self-describing: `pbkdf2-sha256$<iterations>$<saltB64url>$<hashB64url>`,
 * so the iteration count can be raised over time without breaking existing hashes.
 */
const enc = new TextEncoder();
const ITERATIONS = 210_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const KEYLEN = 32; // bytes
const SALTLEN = 16;

const b64url = (buf: Uint8Array) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, key, KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

/** Minimum acceptable password length. */
export const MIN_PASSWORD_LENGTH = 8;

/** Hash a password for storage. Rejects passwords below the minimum length. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)
    throw Object.assign(new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`), { code: "BAD_REQUEST" });
  const salt = crypto.getRandomValues(new Uint8Array(SALTLEN));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

/** Constant-time verify of a password against a stored hash. */
export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = unb64url(parts[2]!);
  const expected = unb64url(parts[3]!);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
