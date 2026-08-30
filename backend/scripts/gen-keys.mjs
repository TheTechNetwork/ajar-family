#!/usr/bin/env node
/**
 * Generate the Worker's runtime secrets: an HMAC AUTH_SECRET and the Ed25519
 * policy-signing keypair.
 *
 *   node backend/scripts/gen-keys.mjs            # human-readable
 *   node backend/scripts/gen-keys.mjs --env      # KEY=VALUE lines, for CI
 *
 * WHY THIS EXISTS RATHER THAN "run these two openssl commands": the signing key
 * is the trust anchor for every device. Rotating it invalidates every cached
 * policy snapshot on every enrolled device at once — enforcement stops until each
 * one re-syncs and re-pins. So generation must be a deliberate, once-per-
 * environment act, and the bootstrap workflow that calls this REFUSES to
 * overwrite an existing key.
 *
 * The keypair format matches domain/signing.ts exactly: base64 of raw SPKI DER
 * (public) and PKCS8 DER (private), which is what both Node and Workers WebCrypto
 * import and what the Swift client unwraps.
 */
const b64 = (buf) => Buffer.from(buf).toString("base64");

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = b64(await crypto.subtle.exportKey("spki", kp.publicKey));
const priv = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const authSecret = b64(crypto.getRandomValues(new Uint8Array(32)));

// Prove the pair actually round-trips before anyone deploys with it: a keypair
// that cannot verify its own signature would silently break every device.
const msg = new TextEncoder().encode("ajar-keygen-selftest");
const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg);
const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, msg);
if (!ok) { console.error("FATAL: generated keypair failed its own verification"); process.exit(1); }

if (process.argv.includes("--env")) {
  process.stdout.write(`AUTH_SECRET=${authSecret}\n`);
  process.stdout.write(`SIGNING_PUBLIC_KEY_B64=${pub}\n`);
  process.stdout.write(`SIGNING_PRIVATE_KEY_B64=${priv}\n`);
} else {
  console.log("Generated (self-test passed). Treat the private key as a live credential.\n");
  console.log(`AUTH_SECRET=${authSecret}`);
  console.log(`SIGNING_PUBLIC_KEY_B64=${pub}`);
  console.log(`SIGNING_PRIVATE_KEY_B64=${priv}`);
  console.log("\nRotating SIGNING_* invalidates every device's cached policy until it re-syncs.");
}
