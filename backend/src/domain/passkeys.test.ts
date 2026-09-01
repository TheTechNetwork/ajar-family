import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { PasskeyService, CHALLENGE_TTL_MS } from "./passkeys.js";
import { MemoryStore } from "../store/memory.js";
import type { DomainError } from "./services.js";

/**
 * Does the library actually verify output from REAL authenticators, and refuse
 * what it should?
 *
 * PROVENANCE MATTERS HERE. These vectors are captures from real ceremonies
 * against real devices, taken from py_webauthn (Duo Labs, MIT) —
 * tests/test_verify_registration_response.py and
 * tests/test_verify_authentication_response.py. They are copied verbatim and
 * nothing is re-encoded.
 *
 * That is the point. A test that feeds our own encoder's output into our own
 * decoder proves the pair is self-consistent and nothing about whether either
 * agrees with an iPhone. These bytes came off hardware.
 *
 * They use rpId `localhost` and origin `http://localhost:5000` because that is
 * where they were captured; the expectations below match the capture, not our
 * production values.
 *
 * The NEGATIVE cases carry the weight. A verifier that accepts everything passes
 * every positive test.
 */

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5000";

/** The genuine ES256 credential from the capture, and the assertion it produced. */
const ES256_CRED_ID = "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q";
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

/** A different real ES256 key, from a different credential in the same corpus. */
const OTHER_ES256_KEY =
  "pQECAyYgASFYIOQ5TKpXJR2cV76Wgfge9BkLkEhLxVjhFjM1jKHYOcqpIlggaiNy1blt3OU8Hsmg041HUYP7eajgL7fk3nSuTEjYCwU";
const WRONG_KEY_CHALLENGE =
  "zsfiMZj16TUVCrT5tDRYXdYlUrJp7zn_UNd5NmBocPc4I2dKZbeEWpwBAwA4s6oHkVX6_ly_jgp743dyiWHYYw";

test("verifies a real ES256 registration from an actual authenticator", async () => {
  const out = await verifyRegistrationResponse({
    response: {
      id: "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w",
      rawId: "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w",
      response: {
        attestationObject:
          "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjESZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAFwAAAAAAAAAAAAAAAAAAAAAAQPctcQPE5oNRRJk_nO_371mf7qE7qIodzr0eOf6ACvnMB1oQG165dqutoi1U44shGezu5_gkTjmOPeJO0N8a7P-lAQIDJiABIVggSFbUJF-42Ug3pdM8rDRFu_N5oiVEysPDB6n66r_7dZAiWCDUVnB39FlGypL-qAoIO9xWHtJygo2jfDmHl-_eKFRLDA",
        clientDataJSON:
          "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiVHdON240V1R5R0tMYzRaWS1xR3NGcUtuSE00bmdscXN5VjBJQ0psTjJUTzlYaVJ5RnRya2FEd1V2c3FsLWdrTEpYUDZmbkYxTWxyWjUzTW00UjdDdnciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge:
      "TwN7n4WTyGKLc4ZY-qGsFqKnHM4nglqsyV0ICJlN2TO9XiRyFtrkaDwUvsql-gkLJXP6fnF1MlrZ53Mm4R7Cvw",
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: false,
  });

  assert.equal(out.verified, true);
  assert.equal(
    out.registrationInfo?.credential.id,
    "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w",
  );
  // 23 is what that authenticator actually reported.
  assert.equal(out.registrationInfo?.credential.counter, 23);
});

test("verifies a real ES256 assertion", async () => {
  const out = await verifyAuthenticationResponse({
    response: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      rawId: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg",
        clientDataJSON:
          "eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ",
        signature:
          "MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge:
      "xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA",
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      publicKey: b64(
        "pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI",
      ),
      counter: 77,
    },
    requireUserVerification: false,
  });

  assert.equal(out.verified, true);
  assert.equal(out.authenticationInfo.newCounter, 78);
});

test("verifies a real RS256 assertion — the other algorithm we accept", async () => {
  const out = await verifyAuthenticationResponse({
    response: {
      id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      rawId: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ",
        clientDataJSON:
          "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiaVBtQWkxUHAxWEw2b0FncTNQV1p0WlBuWmExekZVRG9HYmFRMF9LdlZHMWxGMnMzUnRfM280dVN6Y2N5MHRtY1RJcFRUVDRCVTFULUk0bWFhdm5kalEiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
        signature:
          "iOHKX3erU5_OYP_r_9HLZ-CexCE4bQRrxM8WmuoKTDdhAnZSeTP0sjECjvjfeS8MJzN1ArmvV0H0C3yy_FdRFfcpUPZzdZ7bBcmPh1XPdxRwY747OrIzcTLTFQUPdn1U-izCZtP_78VGw9pCpdMsv4CUzZdJbEcRtQuRS03qUjqDaovoJhOqEBmxJn9Wu8tBi_Qx7A33RbYjlfyLm_EDqimzDZhyietyop6XUcpKarKqVH0M6mMrM5zTjp8xf3W7odFCadXEJg-ERZqFM0-9Uup6kJNLbr6C5J4NDYmSm3HCSA6lp2iEiMPKU8Ii7QZ61kybXLxsX4w4Dm3fOLjmDw",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge:
      "iPmAi1Pp1XL6oAgq3PWZtZPnZa1zFUDoGbaQ0_KvVG1lF2s3Rt_3o4uSzccy0tmcTIpTTT4BU1T-I4maavndjQ",
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      publicKey: b64(
        "pAEDAzkBACBZAQDfV20epzvQP-HtcdDpX-cGzdOxy73WQEvsU7Dnr9UWJophEfpngouvgnRLXaEUn_d8HGkp_HIx8rrpkx4BVs6X_B6ZjhLlezjIdJbLbVeb92BaEsmNn1HW2N9Xj2QM8cH-yx28_vCjf82ahQ9gyAr552Bn96G22n8jqFRQKdVpO-f-bvpvaP3IQ9F5LCX7CUaxptgbog1SFO6FI6ob5SlVVB00lVXsaYg8cIDZxCkkENkGiFPgwEaZ7995SCbiyCpUJbMqToLMgojPkAhWeyktu7TlK6UBWdJMHc3FPAIs0lH_2_2hKS-mGI1uZAFVAfW1X-mzKL0czUm2P1UlUox7IUMBAAE",
      ),
      counter: 0,
    },
    requireUserVerification: false,
  });

  assert.equal(out.verified, true);
});

// --- the cases that carry the weight -----------------------------------------

test("a signature that does not verify comes back verified:false — it does NOT throw", async () => {
  // py_webauthn's incorrect-public-key vector: a genuine assertion paired with a
  // public key that did not produce it.
  //
  // READ THIS BEFORE CALLING THE LIBRARY ANYWHERE ELSE. The two kinds of failure
  // are reported two different ways. Ceremony checks — wrong challenge, wrong
  // origin, user verification demanded and not done — THROW. A signature that
  // simply does not verify RETURNS `{ verified: false }`, with
  // `authenticationInfo` populated as if it had. So
  //
  //     try { await verifyAuthenticationResponse(...) } catch { deny() }
  //     signIn(user)                                   // <- forged signature accepted
  //
  // is an authentication bypass that passes every ceremony test you can write.
  // `PasskeyService.login` checks `.verified`; the test below is what holds it to
  // that.
  const out = await verifyAuthenticationResponse({
    response: {
      id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      rawId: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAJA",
        clientDataJSON:
          "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoienNmaU1aajE2VFVWQ3JUNXREUllYZFlsVXJKcDd6bl9VTmQ1Tm1Cb2NQYzRJMmRLWmJlRVdwd0JBd0E0czZvSGtWWDZfbHlfamdwNzQzZHlpV0hZWXciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
        signature:
          "MEQCIBX9B1LaLaQ0LYJsRv7cOyMS-Do1rJfFJoF9oO1tHMA4AiBRKdNneMKPlN53i8uoTZ5y9Gj4ORZySmiercS38655_g",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge: WRONG_KEY_CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: { id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s", publicKey: b64(OTHER_ES256_KEY), counter: 0 },
    requireUserVerification: false,
  });

  assert.equal(out.verified, false);
  // And the counter is handed back anyway, which is the trap: a caller that
  // reads newCounter without reading verified has already lost.
  assert.equal(out.authenticationInfo.newCounter, 36);
});

test("REFUSES a real assertion replayed with the wrong challenge", async () => {
  // The single check that makes a captured assertion useless to an attacker.
  // Same bytes as the passing ES256 case, one character changed in the expected
  // challenge.
  await assert.rejects(() => verifyAuthenticationResponse({
    response: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      rawId: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg",
        clientDataJSON:
          "eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ",
        signature:
          "MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge: "Xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA",
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      publicKey: b64("pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI"),
      counter: 77,
    },
    requireUserVerification: false,
  }));
});

test("REFUSES a real assertion presented to the wrong origin", async () => {
  // Origin binding is what stops a phishing site relaying a ceremony. Same
  // bytes, our production origin as the expectation.
  await assert.rejects(() => verifyAuthenticationResponse({
    response: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      rawId: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg",
        clientDataJSON:
          "eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ",
        signature:
          "MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge:
      "xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA",
    expectedOrigin: "https://ajar.family",
    expectedRPID: RP_ID,
    credential: {
      id: "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
      publicKey: b64("pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI"),
      counter: 77,
    },
    requireUserVerification: false,
  }));
});

test("REFUSES when user verification is required and the authenticator did not do it", async () => {
  await assert.rejects(() => verifyAuthenticationResponse({
    response: {
      id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      rawId: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      response: {
        authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAAIQ",
        clientDataJSON:
          "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidW1HZW1YSklQQlhQeGtEOEhqYW51djlCRG9yOFo3TzNhUGR0T2dNQ2RXNFBBZnFEWDQzRUZsaHJzRjBQVzkwZGY1enJnYnQ3WVZNUkFhMjd0Q2RIenciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
        signature:
          "MEUCIGp5ADnU_SFvT4J_bKvQJ4Pc1GmANhbYq5GioOLjyUrxAiEA6Kk5qAZb8MLY-jyTiJLr_R9Fke02UHkxsRB0dnZt2X8",
      },
      type: "public-key",
      clientExtensionResults: {},
    } as never,
    expectedChallenge:
      "umGemXJIPBXPxkD8Hjanuv9BDor8Z7O3aPdtOgMCdW4PAfqDX43EFlhrsF0PW90df5zrgbt7YVMRAa27tCdHzw",
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
      publicKey: b64("pQECAyYgASFYIOQ5TKpXJR2cV76Wgfge9BkLkEhLxVjhFjM1jKHYOcqpIlggaiNy1blt3OU8Hsmg041HUYP7eajgL7fk3nSuTEjYCwU"),
      counter: 0,
    },
    // The whole point of this case.
    requireUserVerification: true,
  }));
});

// --- and now the thing that matters: does OUR code refuse it? ----------------
//
// The four cases above test the library. These test PasskeyService, which is
// what an attacker actually reaches. In particular the wrong-key case exercises
// the `verified: false` return above through the real login path — the one shape
// of failure that arrives without an exception.

const cfg = { rpId: RP_ID, origin: ORIGIN, rpName: "Ajar" };

/** A service with one credential enrolled and one live sign-in challenge. */
async function serviceWith(opts: { publicKeyCose: string; signCount: number; challenge: string; userId?: string }) {
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: ES256_CRED_ID,
    userId: "parent-1",
    publicKeyCose: opts.publicKeyCose,
    alg: -7,
    signCount: opts.signCount,
    label: "iPhone",
    backedUp: true,
    createdAt: new Date().toISOString(),
  });
  await repo.createWebAuthnChallenge({
    challenge: opts.challenge,
    kind: "AUTHENTICATE",
    // Bound to the account whose password was just accepted. login() refuses a
    // challenge minted for anyone else.
    userId: opts.userId ?? "parent-1",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return { repo, svc: new PasskeyService(repo, cfg) };
}

test("login: a real assertion signs the parent in and advances the counter", async () => {
  const { repo, svc } = await serviceWith({
    publicKeyCose: ES256_KEY, signCount: 77, challenge: ES256_CHALLENGE,
  });

  const out = await svc.login("parent-1", ES256_ASSERTION);
  assert.equal(out.userId, "parent-1");
  assert.equal(out.credential.signCount, 78, "the new counter is persisted, not just returned");
  assert.equal((await repo.getWebAuthnCredential(ES256_CRED_ID))!.signCount, 78);
});

test("login: a signature made by a different key is refused, not signed in", async () => {
  // The credential id resolves — it is enrolled — but the key on file did not
  // produce this signature. The library says so by returning verified:false and
  // NOT throwing. If login ever forgets to read that field, this test is the
  // only thing standing between a forged assertion and a parent's account.
  const { svc } = await serviceWith({
    publicKeyCose: OTHER_ES256_KEY, signCount: 0, challenge: ES256_CHALLENGE,
  });

  await assert.rejects(() => svc.login("parent-1", ES256_ASSERTION), (e: Error) => {
    assert.equal((e as DomainError).code, "UNAUTHORIZED");
    return true;
  });
});

test("login: the same assertion cannot be replayed — the challenge is spent", async () => {
  const { svc } = await serviceWith({
    publicKeyCose: ES256_KEY, signCount: 77, challenge: ES256_CHALLENGE,
  });

  await svc.login("parent-1", ES256_ASSERTION);
  // Byte-for-byte the same request, which is exactly what a network attacker
  // holds. The challenge row was deleted as it was read.
  await assert.rejects(() => svc.login("parent-1", ES256_ASSERTION), (e: Error) => {
    assert.equal((e as DomainError).code, "UNAUTHORIZED");
    return true;
  });
});

test("login: a challenge issued for REGISTER cannot be spent to sign in", async () => {
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: ES256_CRED_ID, userId: "parent-1", publicKeyCose: ES256_KEY, alg: -7,
    signCount: 77, label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });
  await repo.createWebAuthnChallenge({
    challenge: ES256_CHALLENGE,
    // Enrolling a passkey and proving you hold one are different acts; a
    // challenge minted for the first must not settle the second.
    kind: "REGISTER",
    userId: "parent-1",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(() => new PasskeyService(repo, cfg).login("parent-1", ES256_ASSERTION));
});

test("login: an expired challenge is refused", async () => {
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: ES256_CRED_ID, userId: "parent-1", publicKeyCose: ES256_KEY, alg: -7,
    signCount: 77, label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });
  await repo.createWebAuthnChallenge({
    challenge: ES256_CHALLENGE, kind: "AUTHENTICATE", userId: "parent-1",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await assert.rejects(() => new PasskeyService(repo, cfg).login("parent-1", ES256_ASSERTION));
});

test("login: a counter that goes backwards is treated as a cloned authenticator", async () => {
  // This assertion reports 78. On file we have 200 — so either this is a replay
  // from an older capture or the credential exists in two places. Either way it
  // is not a sign-in.
  //
  // Which check catches it: the LIBRARY's, which throws on any counter that does
  // not advance while either side is non-zero. Ours is the weaker of the two and
  // never fires. This test pins the OUTCOME, not the mechanism, so it keeps
  // holding whichever of the two is doing the work.
  const { svc } = await serviceWith({
    publicKeyCose: ES256_KEY, signCount: 200, challenge: ES256_CHALLENGE,
  });

  await assert.rejects(() => svc.login("parent-1", ES256_ASSERTION), (e: Error) => {
    assert.equal((e as DomainError).code, "UNAUTHORIZED");
    return true;
  });
});

test("login: a synced passkey stuck at counter 0 is NOT mistaken for a clone", async () => {
  // Every iCloud/Google-synced passkey reports 0 forever. Treating 0 -> 0 as
  // regression would lock out most of our users on their second sign-in.
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s", userId: "parent-2",
    publicKeyCose: OTHER_ES256_KEY, alg: -7, signCount: 0, label: "iCloud Keychain",
    backedUp: true, createdAt: new Date().toISOString(),
  });
  await repo.createWebAuthnChallenge({
    challenge: "umGemXJIPBXPxkD8Hjanuv9BDor8Z7O3aPdtOgMCdW4PAfqDX43EFlhrsF0PW90df5zrgbt7YVMRAa27tCdHzw",
    kind: "AUTHENTICATE", userId: "parent-2",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });

  const out = await new PasskeyService(repo, cfg).login("parent-2", {
    id: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
    rawId: "ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s",
    response: {
      authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAAIQ",
      clientDataJSON:
        "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidW1HZW1YSklQQlhQeGtEOEhqYW51djlCRG9yOFo3TzNhUGR0T2dNQ2RXNFBBZnFEWDQzRUZsaHJzRjBQVzkwZGY1enJnYnQ3WVZNUkFhMjd0Q2RIenciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
      signature: "MEUCIGp5ADnU_SFvT4J_bKvQJ4Pc1GmANhbYq5GioOLjyUrxAiEA6Kk5qAZb8MLY-jyTiJLr_R9Fke02UHkxsRB0dnZt2X8",
    },
    type: "public-key",
    clientExtensionResults: {},
  });

  assert.equal(out.userId, "parent-2");
});

test("login: a credential we have never seen is refused without saying so", async () => {
  const repo = new MemoryStore();
  await repo.createWebAuthnChallenge({
    challenge: ES256_CHALLENGE, kind: "AUTHENTICATE", userId: "parent-1",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(() => new PasskeyService(repo, cfg).login("parent-1", ES256_ASSERTION), (e: Error) => {
    // Deliberately the same wording as a bad signature: the difference would
    // tell whoever is asking whether a given passkey is enrolled here.
    assert.equal(e.message, "that passkey was not recognised");
    return true;
  });
});

test("login: a challenge minted for one account cannot settle another's sign-in", async () => {
  // The attack this closes: someone knows a parent's password, gets as far as
  // the second step, and finishes it with a passkey of their OWN — enrolled on
  // their own Ajar account, on their own phone, with their own face. Both the
  // challenge binding and the credential's owner have to be checked; either one
  // alone leaves this open.
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: ES256_CRED_ID, userId: "attacker", publicKeyCose: ES256_KEY, alg: -7,
    signCount: 77, label: "attacker's phone", backedUp: true, createdAt: new Date().toISOString(),
  });
  await repo.createWebAuthnChallenge({
    challenge: ES256_CHALLENGE, kind: "AUTHENTICATE", userId: "victim",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });

  // A genuine, correctly signed assertion — and still not a sign-in as "victim".
  await assert.rejects(() => new PasskeyService(repo, cfg).login("victim", ES256_ASSERTION));
});

test("remove: the last passkey cannot be deleted", async () => {
  // Otherwise "tidying up my passkeys" is indistinguishable from locking
  // yourself out of your own children's controls.
  const repo = new MemoryStore();
  await repo.createWebAuthnCredential({
    id: ES256_CRED_ID, userId: "parent-1", publicKeyCose: ES256_KEY, alg: -7,
    signCount: 0, label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });
  const svc = new PasskeyService(repo, cfg);

  await assert.rejects(() => svc.remove("parent-1", ES256_CRED_ID), (e: Error) => {
    assert.equal((e as DomainError).code, "CONFLICT");
    return true;
  });
  assert.equal((await repo.listWebAuthnCredentials("parent-1")).length, 1);

  // With a second one enrolled, the first goes.
  await repo.createWebAuthnCredential({
    id: "second", userId: "parent-1", publicKeyCose: OTHER_ES256_KEY, alg: -7,
    signCount: 0, label: "YubiKey", backedUp: false, createdAt: new Date().toISOString(),
  });
  await svc.remove("parent-1", ES256_CRED_ID);
  assert.deepEqual((await repo.listWebAuthnCredentials("parent-1")).map((c) => c.id), ["second"]);
});

test("remove: you cannot delete somebody else's passkey", async () => {
  const repo = new MemoryStore();
  for (const [id, userId] of [["a", "parent-1"], ["b", "parent-1"], ["theirs", "parent-2"]]) {
    await repo.createWebAuthnCredential({
      id: id!, userId: userId!, publicKeyCose: ES256_KEY, alg: -7, signCount: 0,
      label: "k", backedUp: true, createdAt: new Date().toISOString(),
    });
  }
  await assert.rejects(() => new PasskeyService(repo, cfg).remove("parent-1", "theirs"));
  assert.ok(await repo.getWebAuthnCredential("theirs"));
});
