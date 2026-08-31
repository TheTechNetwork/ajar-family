/**
 * Self-contained password hashing — no external identity provider. PBKDF2-HMAC-
 * SHA-256 via WebCrypto, so it runs identically on Node and Cloudflare Workers.
 *
 * # The 100,000-iteration ceiling (found in production, not in tests)
 *
 * Cloudflare Workers REFUSES a PBKDF2 derivation above 100,000 iterations:
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000)
 *
 * This code previously asked for 210,000 in a single call, which works in Node
 * and fails on Workers — so registration and login were completely broken in the
 * deployed product while every test passed. The local workerd test did not catch
 * it either: local workerd does not enforce the limit. Only a real deployment did.
 *
 * Lowering to 100,000 would cut the work factor below current guidance, so
 * instead the derivation is CHAINED: N sequential PBKDF2 rounds of at most
 * 100,000 iterations each, feeding each round's output in as the next round's
 * key material. An attacker must perform the same total work, so the effective
 * factor is `PER_ROUND x ROUNDS` (600,000 — OWASP 2023 for PBKDF2-HMAC-SHA256)
 * while no single call ever exceeds what the platform allows.
 *
 * # Stored form
 *
 *   pbkdf2-sha256$<perRound>x<rounds>$<saltB64url>$<hashB64url>
 *
 * The legacy single-round form `pbkdf2-sha256$<iterations>$...` is still VERIFIED
 * so existing hashes keep working; anything written from now on is chained. Note
 * a legacy hash above the cap can no longer be verified on Workers at all — it
 * could not have been created there either, so this only affects rows written by
 * a Node host before this change.
 */
const enc = new TextEncoder();

/** Hard platform ceiling — Workers rejects any single derivation above this. */
export const MAX_ITERATIONS_PER_CALL = 100_000;
const PER_ROUND = 100_000;
const ROUNDS = 6; // 600,000 effective
const KEYLEN = 32; // bytes
const SALTLEN = 16;

const b64url = (buf: Uint8Array) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

/** One PBKDF2 derivation. Throws rather than silently exceeding the platform cap. */
async function derive(material: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  if (iterations > MAX_ITERATIONS_PER_CALL) {
    throw new Error(
      `PBKDF2 iterations ${iterations} exceeds the ${MAX_ITERATIONS_PER_CALL} platform limit; ` +
      "raise ROUNDS instead of PER_ROUND");
  }
  const key = await crypto.subtle.importKey("raw", material as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, key, KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

/** `rounds` sequential derivations; total work is perRound x rounds. */
async function deriveChained(
  password: string, salt: Uint8Array, perRound: number, rounds: number,
): Promise<Uint8Array> {
  let material: Uint8Array = enc.encode(password);
  let out: Uint8Array = material;
  for (let i = 0; i < rounds; i++) {
    out = await derive(material, salt, perRound);
    material = out;
  }
  return out;
}

/** Minimum acceptable password length. */
export const MIN_PASSWORD_LENGTH = 8;

/** Hash a password for storage. Rejects passwords below the minimum length. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)
    throw Object.assign(new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`), { code: "BAD_REQUEST" });
  const salt = crypto.getRandomValues(new Uint8Array(SALTLEN));
  const hash = await deriveChained(password, salt, PER_ROUND, ROUNDS);
  return `pbkdf2-sha256$${PER_ROUND}x${ROUNDS}$${b64url(salt)}$${b64url(hash)}`;
}

/** Constant-time verify. Understands both the chained and the legacy single-round form. */
export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;

  const spec = parts[1] ?? "";
  let perRound: number, rounds: number;
  const m = /^(\d+)x(\d+)$/.exec(spec);
  if (m) {
    perRound = Number(m[1]); rounds = Number(m[2]);
  } else {
    perRound = Number(spec); rounds = 1; // legacy
  }
  if (!Number.isInteger(perRound) || perRound < 1 || !Number.isInteger(rounds) || rounds < 1) return false;

  const salt = unb64url(parts[2]!);
  const expected = unb64url(parts[3]!);
  let actual: Uint8Array;
  try {
    actual = await deriveChained(password, salt, perRound, rounds);
  } catch {
    return false; // e.g. a legacy hash above the platform cap on this runtime
  }
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
