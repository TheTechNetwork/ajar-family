/**
 * Regression tests for the bug that broke registration in production while every
 * test passed: Cloudflare Workers rejects a PBKDF2 derivation above 100,000
 * iterations, and we were asking for 210,000 in one call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, MAX_ITERATIONS_PER_CALL } from "./password.js";

test("no single derivation may exceed the platform's iteration ceiling", async () => {
  // THE guard. Local workerd does not enforce the limit and Node has none, so no
  // runtime test can catch a regression here — only an explicit assertion can.
  // Intercept what we actually ask WebCrypto for.
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  const requested: number[] = [];
  (crypto.subtle as unknown as { deriveBits: typeof crypto.subtle.deriveBits }).deriveBits =
    ((algo: AlgorithmIdentifier & { iterations?: number }, ...rest: unknown[]) => {
      if (typeof algo === "object" && typeof algo.iterations === "number") requested.push(algo.iterations);
      return (original as (...a: unknown[]) => Promise<ArrayBuffer>)(algo, ...rest);
    }) as typeof crypto.subtle.deriveBits;
  try {
    await hashPassword("correct horse battery staple");
  } finally {
    (crypto.subtle as unknown as { deriveBits: typeof crypto.subtle.deriveBits }).deriveBits = original;
  }
  assert.ok(requested.length > 0, "hashing performed at least one derivation");
  const worst = Math.max(...requested);
  assert.ok(worst <= MAX_ITERATIONS_PER_CALL,
    `a single derivation asked for ${worst}; Workers rejects anything above ${MAX_ITERATIONS_PER_CALL}`);
  // Chained, so the total work factor stays high despite the per-call ceiling.
  const total = requested.reduce((a, b) => a + b, 0);
  assert.ok(total >= 600_000, `effective work factor ${total} is below the 600k target`);
});

test("a password round-trips, and a wrong one is rejected", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword("correct horse battery staple", null), false);
});

test("the stored form records the chain so it can be re-derived", async () => {
  const stored = await hashPassword("correct horse battery staple");
  const [algo, spec] = stored.split("$");
  assert.equal(algo, "pbkdf2-sha256");
  assert.match(spec!, /^\d+x\d+$/, "records iterations-per-round and round count");
});

test("legacy single-round hashes still verify", async () => {
  // Written by a Node host before the chained format existed. Must keep working,
  // or every parent registered before this change is locked out.
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode("legacy password"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 50_000, hash: "SHA-256" }, key, 256);
  const b64url = (b: Uint8Array) =>
    Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const stored = `pbkdf2-sha256$50000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
  assert.equal(await verifyPassword("legacy password", stored), true);
  assert.equal(await verifyPassword("nope", stored), false);
});

test("short passwords are refused", async () => {
  await assert.rejects(() => hashPassword("short"), /at least 8/);
});
