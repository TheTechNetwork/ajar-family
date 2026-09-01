/**
 * Trust-anchor conformance: does a device let someone change which server, and
 * which signing key, it trusts?
 *
 * Two halves, both of which run in CI (`npm run conformance`):
 *
 *  1. VECTOR AGREEMENT. shared/trust/trust-vectors.ts is run against the shared
 *     TypeScript spec and against both hand-written extension mirrors. Same
 *     anti-drift job as run-mirrors.mjs does for the evaluator: a Mac build that
 *     lets you re-point it while Windows refuses is a CI failure, not a support
 *     ticket.
 *
 *  2. STORAGE-LEVEL SCENARIOS. The real `backend-client.js` of each extension is
 *     imported with a fake `chrome.storage.local` and a fake `fetch`, and driven
 *     through the attack the pin exists to stop: disconnect the browser, point
 *     it at a server that hands out its own signing key, and see whether the
 *     device adopts it. These assert on what ends up in storage, not on what the
 *     UI says — the options page is only one of the callers.
 *
 *   node tools/conformance/run-trust-anchor.mjs
 */
import assert from "node:assert/strict";
import {
  decideEnrollment as sharedDecideEnrollment,
  decideUnenroll as sharedDecideUnenroll,
  isAllowedBackendUrl as sharedIsAllowedBackendUrl,
} from "../../shared/dist/trust/trust-anchor.js";
import {
  ENROLL_VECTORS, UNENROLL_VECTORS, URL_VECTORS, VECTOR_BUNDLED_URL,
} from "../../shared/dist/trust/trust-vectors.js";

let failures = 0;
let checks = 0;

function check(label, fn) {
  checks++;
  try { fn(); } catch (e) {
    failures++;
    console.error(`FAIL ${label}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

async function checkAsync(label, fn) {
  checks++;
  try { await fn(); } catch (e) {
    failures++;
    console.error(`FAIL ${label}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// A fake extension world: storage.local backed by a Map we can reset, and a
// fetch that answers /v1/enroll/redeem with a server of our choosing.
// ---------------------------------------------------------------------------
const DB = new Map();
const REQUESTS = [];

const storage = {
  local: {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (DB.has(k)) out[k] = structuredClone(DB.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) DB.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) DB.delete(k); },
  },
};
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const api = {
  storage: { ...storage, onChanged: listener },
  runtime: {
    getURL: (p) => `ext://test/${p}`,
    connectNative: () => ({ onMessage: listener, onDisconnect: listener, postMessage: noop }),
    onMessage: listener,
    lastError: null,
  },
  webRequest: { onBeforeRequest: listener },
  webNavigation: { onBeforeNavigate: listener, onCommitted: listener, onHistoryStateUpdated: listener },
  tabs: { update: noop, query: async () => [] },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
};
globalThis.chrome = api;
globalThis.browser = api;

/** The server on the other end of the next enrollment. */
let SERVER = { signingKey: "SERVER-KEY-A==", deviceId: "dev-1", childId: "kid-1" };

globalThis.fetch = async (url, init) => {
  REQUESTS.push({ url: String(url), init });
  if (!String(url).endsWith("/v1/enroll/redeem")) throw new Error(`unexpected fetch: ${url}`);
  const body = {
    deviceToken: "device-token",
    signingPublicKeyB64: SERVER.signingKey,
    device: { id: SERVER.deviceId, childId: SERVER.childId, displayName: "Test PC" },
  };
  return { ok: true, status: 200, json: async () => body, text: async () => "" };
};

function reset() { DB.clear(); REQUESTS.length = 0; }

// ---------------------------------------------------------------------------
// 1. Vector agreement across the spec and both mirrors.
// ---------------------------------------------------------------------------
const MIRRORS = [
  { id: "shared", mod: { decideEnrollment: sharedDecideEnrollment, decideUnenroll: sharedDecideUnenroll, isAllowedBackendUrl: sharedIsAllowedBackendUrl } },
  { id: "windows", mod: await import(new URL("../../windows/extension/trust-anchor.js", import.meta.url).href) },
  { id: "macos", mod: await import(new URL("../../macos/safari-extension/Extension/trust-anchor.js", import.meta.url).href) },
];

for (const m of MIRRORS) {
  for (const v of ENROLL_VECTORS) {
    check(`[${m.id}] enroll: ${v.name}`, () => {
      assert.deepEqual(m.mod.decideEnrollment(v.attempt), v.expect);
    });
  }
  for (const v of UNENROLL_VECTORS) {
    check(`[${m.id}] disconnect: ${v.name}`, () => {
      assert.deepEqual(m.mod.decideUnenroll(v.input), v.expect);
    });
  }
  for (const v of URL_VECTORS) {
    check(`[${m.id}] address: ${v.name}`, () => {
      assert.equal(
        m.mod.isAllowedBackendUrl(v.url, { bundledUrl: VECTOR_BUNDLED_URL, devMode: v.devMode }),
        v.expect,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Scenarios against each extension's real backend-client.js.
// ---------------------------------------------------------------------------
const CLIENTS = [
  { id: "windows", path: "../../windows/extension/backend-client.js", anchorPath: "../../windows/extension/trust-anchor.js" },
  { id: "macos", path: "../../macos/safari-extension/Extension/backend-client.js", anchorPath: "../../macos/safari-extension/Extension/trust-anchor.js" },
];

const CODE = "K7M2P9QR";

async function expectRefused(label, fn, reason) {
  checks++;
  try {
    await fn();
    failures++;
    console.error(`FAIL ${label}\n  expected a TrustError (${reason}), the call succeeded`);
    return null;
  } catch (e) {
    if (e?.name !== "TrustError" || e.reason !== reason) {
      failures++;
      console.error(`FAIL ${label}\n  expected TrustError(${reason}), got ${e?.name}(${e?.reason ?? ""}): ${e?.message}`);
    }
    return e;
  }
}

async function expectOk(label, fn) {
  checks++;
  try { return await fn(); } catch (e) {
    failures++;
    console.error(`FAIL ${label}\n  expected success, threw ${e?.name}: ${e?.message}`);
    return null;
  }
}

for (const c of CLIENTS) {
  const client = await import(new URL(c.path, import.meta.url).href);
  const anchor = await import(new URL(c.anchorPath, import.meta.url).href);
  const HOME = anchor.BUNDLED_BACKEND_URL;
  const EVIL = "https://allow-all.example";

  // ---- a parent sets the device up ----------------------------------------
  reset();
  SERVER = { signingKey: "REAL-KEY==", deviceId: "dev-1", childId: "kid-1" };
  await expectOk(`[${c.id}] first setup succeeds`, () =>
    client.enroll(HOME, CODE, "Test PC", { parentWord: "correct horse" }));
  await anchor.setParentWord("correct horse");

  check(`[${c.id}] first setup pins the signing key`, () => {
    assert.equal(DB.get("ajarTrustAnchor").signingKeyB64, "REAL-KEY==");
    assert.equal(DB.get("ajarTrustAnchor").backendUrl, HOME);
  });

  // ---- the child disconnects ----------------------------------------------
  await client.clearConfig();
  check(`[${c.id}] disconnect does not take the pin with it`, () => {
    assert.equal(DB.get("ajarTrustAnchor").signingKeyB64, "REAL-KEY==");
  });

  // ---- and re-enrolls against their own server ----------------------------
  SERVER = { signingKey: "ATTACKER-KEY==", deviceId: "dev-x", childId: "kid-x" };

  reqCountReset();
  await expectRefused(`[${c.id}] THE BYPASS: another address in a shipped build`, () =>
    client.enroll(EVIL, CODE, "Test PC"), "bad-url");
  check(`[${c.id}] …and the address was never contacted`, () => {
    assert.equal(REQUESTS.length, 0);
  });

  // Dev mode lifts the address constraint. The pin must still hold — that is the
  // difference between a build flag and a trust decision.
  await storage.local.set({ ajarDevMode: "1" });

  reqCountReset();
  await expectRefused(`[${c.id}] THE BYPASS: another address, dev mode on, no word`, () =>
    client.enroll(EVIL, CODE, "Test PC"), "needs-parent-word");
  check(`[${c.id}] …refused before the enrollment code was spent`, () => {
    assert.equal(REQUESTS.length, 0);
  });

  await expectRefused(`[${c.id}] THE BYPASS: another address, wrong word`, () =>
    client.enroll(EVIL, CODE, "Test PC", { parentWord: "hunter2" }), "needs-parent-word");

  check(`[${c.id}] a refused enrollment writes no config`, () => {
    assert.equal(DB.has("backendConfig"), false);
    assert.equal(DB.get("ajarTrustAnchor").signingKeyB64, "REAL-KEY==");
  });

  // ---- the pinned address, a different key --------------------------------
  reqCountReset();
  await expectRefused(`[${c.id}] the pinned address answering with a new key, no word`, () =>
    client.enroll(HOME, CODE, "Test PC"), "needs-parent-word");
  check(`[${c.id}] …the key that answered is not adopted`, () => {
    assert.equal(DB.has("backendConfig"), false);
    assert.equal(DB.get("ajarTrustAnchor").signingKeyB64, "REAL-KEY==");
  });

  // ---- a parent re-links the device to the same server --------------------
  SERVER = { signingKey: "REAL-KEY==", deviceId: "dev-1", childId: "kid-1" };
  await expectOk(`[${c.id}] re-linking to the pinned server needs nothing extra`, () =>
    client.enroll(HOME, CODE, "Test PC"));
  await checkAsync(`[${c.id}] …and verification still uses the pinned key`, async () => {
    assert.equal(await client.getVerifyingKey(), "REAL-KEY==");
  });

  // ---- rewriting the config copy of the key achieves nothing ---------------
  const cfg = DB.get("backendConfig");
  DB.set("backendConfig", { ...cfg, signingKeyB64: "ATTACKER-KEY==" });
  await checkAsync(`[${c.id}] the pin beats a rewritten backendConfig.signingKeyB64`, async () => {
    assert.equal(await client.getVerifyingKey(), "REAL-KEY==");
  });

  // ---- the parent's escape hatch ------------------------------------------
  SERVER = { signingKey: "NEW-HOME-KEY==", deviceId: "dev-2", childId: "kid-1" };
  await client.clearConfig();
  await expectOk(`[${c.id}] with the word, a parent can move the device`, () =>
    client.enroll(EVIL, CODE, "Test PC", { parentWord: "correct horse" }));
  check(`[${c.id}] …and the anchor moves with it`, () => {
    assert.equal(DB.get("ajarTrustAnchor").backendUrl, EVIL);
    assert.equal(DB.get("ajarTrustAnchor").signingKeyB64, "NEW-HOME-KEY==");
  });
}

function reqCountReset() { REQUESTS.length = 0; }

// ---------------------------------------------------------------------------
// 3. The pin has to be load-bearing.
//
// Pinning a key means nothing if the worker adopts whatever snapshot is sitting
// in storage on restart — storage is the child's own profile directory. So:
// plant a hand-written allow-all snapshot, and check that each background
// worker discards it and enforces nothing rather than enforcing it.
// ---------------------------------------------------------------------------
const { canonicalJSON } = await import(
  new URL("../../windows/extension/policy-verify.js", import.meta.url).href);

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
let bin = "";
for (const b of spki) bin += String.fromCharCode(b);
const REAL_SPKI_B64 = btoa(bin);

const baseSnapshot = {
  version: 7, familyId: "f", childId: "c", deviceId: "d",
  defaults: { webDefault: "ALLOW", youTubeDefault: "BLOCK" },
  rules: [], temporaryRules: [], issuedAt: "2026-01-01T00:00:00.000Z",
};

async function signed(snap) {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(canonicalJSON(snap)));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return { ...snap, signature: btoa(s) };
}

/** What a child would write by hand: everything open, signature invented. */
const FORGED = {
  ...baseSnapshot,
  defaults: { webDefault: "ALLOW", youTubeDefault: "ALLOW" },
  signature: "bm90LWEtc2lnbmF0dXJl",
};
const GENUINE = await signed(baseSnapshot);

reset();   // module-scope startup code must see an unenrolled device

const WORKERS = [
  { id: "windows", path: "../../windows/extension/background.js", key: "snapshot" },
  { id: "macos", path: "../../macos/safari-extension/Extension/background.js", key: "devicePolicySnapshot" },
];

for (const w of WORKERS) {
  const mod = await import(new URL(w.path, import.meta.url).href);

  reset();
  DB.set("ajarTrustAnchor", { v: 1, backendUrl: "https://api.example", signingKeyB64: REAL_SPKI_B64 });

  DB.set(w.key, FORGED);
  await checkAsync(`[${w.id}] a hand-written allow-all snapshot is not enforced`, async () => {
    const got = await mod.restoreCachedPolicy();
    assert.equal(got, null, "the forged snapshot was adopted");
    assert.equal(DB.has(w.key), false, "the forged snapshot was left in the cache");
  });

  DB.set(w.key, GENUINE);
  await checkAsync(`[${w.id}] a snapshot signed by the pinned key is restored`, async () => {
    const got = await mod.restoreCachedPolicy();
    assert.equal(got?.version, 7);
  });

  // The same genuine snapshot, judged against a DIFFERENT pin: signed, valid,
  // and not ours.
  DB.set("ajarTrustAnchor", { v: 1, backendUrl: "https://api.example", signingKeyB64: "AAAA" });
  DB.set(w.key, GENUINE);
  await checkAsync(`[${w.id}] a real signature from the wrong signer is refused`, async () => {
    const got = await mod.restoreCachedPolicy();
    assert.equal(got, null);
  });
}

console.log(`trust anchor: ${checks - failures}/${checks} checks passed across ${MIRRORS.length} implementations`);
if (failures) {
  console.error(`\n${failures} trust-anchor failure(s) — a client will adopt a signing key it was not enrolled with.`);
  process.exit(1);
}
