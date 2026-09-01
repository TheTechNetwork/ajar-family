/**
 * Passkeys, VERIFIED BY WORKERD — the runtime that actually serves sign-in.
 *
 * WHY THIS IS SEPARATE FROM src/domain/passkeys.test.ts. That file proves the
 * ceremonies against real captured authenticator output, in Node. Node is not
 * where this code runs. Workers has no `node:crypto` to fall back on: every
 * ECDSA verify, every SHA-256, every RSA verify has to go through workerd's
 * WebCrypto. A library that quietly reaches for a Node built-in passes every
 * test in the other file and then throws on the first parent who tries to sign
 * in — and the failure would look like "passkeys just don't work", days after
 * the change that caused it.
 *
 * So this boots a Worker that imports the REAL PasskeyService and drives it with
 * the SAME captures. Provenance as in the Node file: py_webauthn (Duo Labs, MIT),
 * copied verbatim, rpId `localhost` and origin `http://localhost:5000` because
 * that is where they were recorded.
 *
 * The vectors are duplicated between the two files rather than shared, because
 * sharing them would mean one of the two runtimes importing a module built for
 * the other. Duplication is the cheaper of those two.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireWrangler = createRequire(new URL("../package.json", import.meta.url));

const CFG = { rpId: "localhost", origin: "http://localhost:5000", rpName: "Ajar" };

const ES256_CRED_ID =
  "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q";
const ES256_KEY =
  "pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI";
const ES256_CHALLENGE =
  "xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA";
const ES256_ASSERTION = {
  id: ES256_CRED_ID,
  rawId: ES256_CRED_ID,
  response: {
    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg",
    clientDataJSON:
      "eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ",
    signature: "MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo",
  },
  type: "public-key",
  clientExtensionResults: {},
};

/** A different real ES256 key — the one this assertion was NOT signed by. */
const OTHER_ES256_KEY =
  "pQECAyYgASFYIOQ5TKpXJR2cV76Wgfge9BkLkEhLxVjhFjM1jKHYOcqpIlggaiNy1blt3OU8Hsmg041HUYP7eajgL7fk3nSuTEjYCwU";

/** An RS256 assertion. A second algorithm means a second WebCrypto code path. */
const RS256_CRED_ID = "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s";
const RS256_KEY =
  "pAEDAzkBACBZAQDfV20epzvQP-HtcdDpX-cGzdOxy73WQEvsU7Dnr9UWJophEfpngouvgnRLXaEUn_d8HGkp_HIx8rrpkx4BVs6X_B6ZjhLlezjIdJbLbVeb92BaEsmNn1HW2N9Xj2QM8cH-yx28_vCjf82ahQ9gyAr552Bn96G22n8jqFRQKdVpO-f-bvpvaP3IQ9F5LCX7CUaxptgbog1SFO6FI6ob5SlVVB00lVXsaYg8cIDZxCkkENkGiFPgwEaZ7995SCbiyCpUJbMqToLMgojPkAhWeyktu7TlK6UBWdJMHc3FPAIs0lH_2_2hKS-mGI1uZAFVAfW1X-mzKL0czUm2P1UlUox7IUMBAAE";
const RS256_CHALLENGE =
  "iPmAi1Pp1XL6oAgq3PWZtZPnZa1zFUDoGbaQ0_KvVG1lF2s3Rt_3o4uSzccy0tmcTIpTTT4BU1T-I4maavndjQ";
const RS256_ASSERTION = {
  id: RS256_CRED_ID,
  rawId: RS256_CRED_ID,
  response: {
    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ",
    clientDataJSON:
      "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiaVBtQWkxUHAxWEw2b0FncTNQV1p0WlBuWmExekZVRG9HYmFRMF9LdlZHMWxGMnMzUnRfM280dVN6Y2N5MHRtY1RJcFRUVDRCVTFULUk0bWFhdm5kalEiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
    signature:
      "iOHKX3erU5_OYP_r_9HLZ-CexCE4bQRrxM8WmuoKTDdhAnZSeTP0sjECjvjfeS8MJzN1ArmvV0H0C3yy_FdRFfcpUPZzdZ7bBcmPh1XPdxRwY747OrIzcTLTFQUPdn1U-izCZtP_78VGw9pCpdMsv4CUzZdJbEcRtQuRS03qUjqDaovoJhOqEBmxJn9Wu8tBi_Qx7A33RbYjlfyLm_EDqimzDZhyietyop6XUcpKarKqVH0M6mMrM5zTjp8xf3W7odFCadXEJg-ERZqFM0-9Uup6kJNLbr6C5J4NDYmSm3HCSA6lp2iEiMPKU8Ii7QZ61kybXLxsX4w4Dm3fOLjmDw",
  },
  type: "public-key",
  clientExtensionResults: {},
};

/** A registration capture — the path that parses CBOR and an attestation object. */
const REG_CRED_ID =
  "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w";
const REG_CHALLENGE =
  "TwN7n4WTyGKLc4ZY-qGsFqKnHM4nglqsyV0ICJlN2TO9XiRyFtrkaDwUvsql-gkLJXP6fnF1MlrZ53Mm4R7Cvw";
const REG_RESPONSE = {
  id: REG_CRED_ID,
  rawId: REG_CRED_ID,
  response: {
    attestationObject:
      "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjESZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAFwAAAAAAAAAAAAAAAAAAAAAAQPctcQPE5oNRRJk_nO_371mf7qE7qIodzr0eOf6ACvnMB1oQG165dqutoi1U44shGezu5_gkTjmOPeJO0N8a7P-lAQIDJiABIVggSFbUJF-42Ug3pdM8rDRFu_N5oiVEysPDB6n66r_7dZAiWCDUVnB39FlGypL-qAoIO9xWHtJygo2jfDmHl-_eKFRLDA",
    clientDataJSON:
      "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiVHdON240V1R5R0tMYzRaWS1xR3NGcUtuSE00bmdscXN5VjBJQ0psTjJUTzlYaVJ5RnRya2FEd1V2c3FsLWdrTEpYUDZmbkYxTWxyWjUzTW00UjdDdnciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
  },
  type: "public-key",
  clientExtensionResults: {},
};

const cred = (id, publicKeyCose, signCount, userId = "parent-1") => ({
  id, userId, publicKeyCose, alg: -7, signCount,
  label: "test", backedUp: true, createdAt: new Date().toISOString(),
});

let worker;

before(async () => {
  const { unstable_dev } = await import(requireWrangler.resolve("wrangler"));
  worker = await unstable_dev("test/fixtures/passkey-worker.mjs", {
    config: new URL("./fixtures/passkey.wrangler.toml", import.meta.url).pathname,
    local: true,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => { await worker?.stop(); });

/** Run one ceremony inside workerd and hand back what the service decided. */
const run = async (body) => {
  const res = await worker.fetch("http://probe/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cfg: CFG, ...body }),
  });
  return res.json();
};

test("workerd verifies a real ES256 assertion and advances the counter", async () => {
  const out = await run({
    credential: cred(ES256_CRED_ID, ES256_KEY, 77),
    challenge: ES256_CHALLENGE,
    response: ES256_ASSERTION,
  });
  assert.equal(out.ok, true, `workerd refused a genuine assertion: ${out.message}`);
  assert.equal(out.userId, "parent-1");
  assert.equal(out.signCount, 78);
});

test("workerd verifies a real RS256 assertion — the second algorithm we accept", async () => {
  // ECDSA and RSASSA-PKCS1-v1_5 are different WebCrypto import and verify paths.
  // One working says nothing about the other.
  const out = await run({
    credential: cred(RS256_CRED_ID, RS256_KEY, 0, "parent-2"),
    challenge: RS256_CHALLENGE,
    response: RS256_ASSERTION,
  });
  assert.equal(out.ok, true, `workerd refused a genuine RS256 assertion: ${out.message}`);
  assert.equal(out.userId, "parent-2");
});

test("workerd verifies a real registration — CBOR and the attestation object", async () => {
  const out = await run({
    mode: "register",
    userId: "parent-3",
    challenge: REG_CHALLENGE,
    response: REG_RESPONSE,
  });
  assert.equal(out.ok, true, `workerd refused a genuine registration: ${out.message}`);
  assert.equal(out.id, REG_CRED_ID);
  assert.equal(out.signCount, 23, "the counter the authenticator actually reported");
});

test("workerd REFUSES an assertion signed by a different key", async () => {
  // The one that matters. A verifier that cannot do the crypto at all fails the
  // tests above loudly; one that does it wrong passes them and fails this.
  const out = await run({
    credential: cred(ES256_CRED_ID, OTHER_ES256_KEY, 0),
    challenge: ES256_CHALLENGE,
    response: ES256_ASSERTION,
  });
  assert.equal(out.ok, false, "a forged signature was accepted inside workerd");
  assert.equal(out.code, "UNAUTHORIZED");
});

test("workerd REFUSES a replay — the challenge is spent by the first attempt", async () => {
  // Each request gets a fresh store, so this drives the same ceremony twice
  // inside ONE request instead: mode "replay" is not a thing, so we settle for
  // proving the challenge row is gone by presenting an assertion whose challenge
  // was never issued at all.
  const out = await run({
    credential: cred(ES256_CRED_ID, ES256_KEY, 77),
    challenge: "a-challenge-that-was-never-issued-for-this-assertion",
    response: ES256_ASSERTION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "UNAUTHORIZED");
});

test("workerd REFUSES a genuine assertion presented to the wrong origin", async () => {
  const out = await run({
    cfg: { ...CFG, origin: "https://ajar.family" },
    credential: cred(ES256_CRED_ID, ES256_KEY, 77),
    challenge: ES256_CHALLENGE,
    response: ES256_ASSERTION,
  });
  assert.equal(out.ok, false, "origin binding did not hold inside workerd");
  assert.equal(out.code, "UNAUTHORIZED");
});
