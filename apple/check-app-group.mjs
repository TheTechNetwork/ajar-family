#!/usr/bin/env node
/**
 * The App Group is one string that has to be identical in six entitlements
 * files, and every way of getting it wrong is silent.
 *
 * `AjarFilter`'s app writes the signed DevicePolicySnapshot into
 * `group.family.ajar.filter`; its two network extensions read it, and so does
 * the Safari extension's native handler — in two different containers, since
 * macOS hosts the same extension in its own app.
 *
 * A drifted copy does not fail to build and does not throw.
 * `UserDefaults(suiteName:)` returns a store for a group you are not entitled
 * to, and a missing key reads back as nil. The product then behaves as though
 * the parent never enrolled the device — the one state the extension treats as
 * "allow". So a typo here is a silent, total bypass.
 *
 * It also enforces that the Safari shim does NOT keep its own copies of the
 * group name or the storage keys. It used to: it could not import PolicyStore
 * across Xcode projects, so it duplicated five string literals. The extension is
 * now a target inside AjarFilter (and compiles Shared/ on macOS), so the
 * duplication has one honest answer — don't. This check is what keeps it gone.
 *
 *   node apple/check-app-group.mjs
 */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

let failures = 0;
const fail = (msg) => { console.error(`FAIL ${msg}`); failures++; };

// ---------------------------------------------------------------------------
// The group name. PolicyStore is the definition; the entitlements grant it.
// ---------------------------------------------------------------------------
const policyStore = read("./AjarFilter/Shared/PolicyStore.swift");
const GROUP = policyStore.match(/defaultAppGroup\s*=\s*"([^"]+)"/)?.[1];
if (!GROUP) {
  fail("AjarFilter/Shared/PolicyStore.swift: no defaultAppGroup literal to check against");
  process.exit(1);
}

/** Every group named in an entitlements plist's application-groups array. */
function groupsInPlist(text) {
  const arr = text.match(/<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!arr) return [];
  return [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].trim());
}

const entitlements = [
  "AjarFilter/App/AjarFilter.entitlements",
  "AjarFilter/FilterDataProvider/FilterDataProvider.entitlements",
  "AjarFilter/FilterControlProvider/FilterControlProvider.entitlements",
  "SafariExtension/ExtensionShim/SafariExtension.entitlements",
  "AjarSafari/App/AjarSafari.entitlements",
];
for (const rel of entitlements) {
  let text;
  try { text = read(`./${rel}`); }
  catch { fail(`${rel}: missing — every target that touches policy needs the App Group`); continue; }
  // Exact values, never a substring test: "group.family.ajar.filterX" contains
  // "group.family.ajar.filter" and is a different, empty container.
  const named = groupsInPlist(text);
  if (named.length === 0) fail(`${rel}: no App Group declared`);
  else if (!named.includes(GROUP)) {
    fail(`${rel}: names ${named.map((n) => `"${n}"`).join(", ")}, not "${GROUP}"`);
  }
}

// ---------------------------------------------------------------------------
// No second copy. The shim reads policy through PolicyStore; a string literal
// here would be a fork of the storage contract that nothing would notice.
// ---------------------------------------------------------------------------
const handler = read("./SafariExtension/ExtensionShim/SafariWebExtensionHandler.swift");
if (handler.includes(`"${GROUP}"`)) {
  fail("SafariExtension shim re-declares the App Group name; read it through PolicyStore instead");
}
// The keys PolicyStore and BackendClient own. A quoted copy in the shim means
// the storage contract has forked.
for (const key of ["device_policy_snapshot_raw_v2", "policy_signing_key_spki_b64",
                   "policy_device_provisioned", "backend_device_id"]) {
  if (handler.includes(`"${key}"`)) {
    fail(`SafariExtension shim hardcodes the storage key "${key}"; use PolicyStore's accessor`);
  }
}
if (!/\bPolicyStore\b/.test(handler)) {
  fail("SafariExtension shim does not use PolicyStore — it is meant to read policy through it");
}

if (failures) {
  console.error(`\n${failures} App-Group problem(s). These fail silently open on a device.`);
  process.exit(1);
}
console.log(`app-group: ${GROUP} granted by ${entitlements.length} targets; shim keeps no copies`);
