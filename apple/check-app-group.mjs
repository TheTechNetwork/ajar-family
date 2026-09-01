#!/usr/bin/env node
/**
 * The App Group is a string that has to be identical in seven places, and every
 * way of getting it wrong is silent.
 *
 * `AjarFilter`'s containing app writes the signed DevicePolicySnapshot into
 * `group.family.ajar.filter`; its two network extensions read it, and now so
 * does the Safari extension's native handler — which cannot import
 * `PolicyStore` (different Xcode project) and therefore keeps its own copy of
 * the group name AND of the four UserDefaults keys.
 *
 * A drifted copy does not fail to build and does not throw. `UserDefaults(suiteName:)`
 * happily returns a store for a group you are not entitled to, and a missing key
 * reads back as nil. The product just quietly behaves as though the parent never
 * enrolled the device — which, since that is the one state the extension treats
 * as "allow", means a typo here is a silent, total bypass of Safari filtering.
 *
 *   node apple/check-app-group.mjs
 */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

let failures = 0;
const fail = (msg) => { console.error(`FAIL ${msg}`); failures++; };

/** The literal a Swift file assigns to `name`, e.g. `let snapshotKey = "..."`. */
const literalFor = (text, name) => text.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];

// ---------------------------------------------------------------------------
// The group name itself. PolicyStore is the definition; everything else copies.
// ---------------------------------------------------------------------------
const policyStore = read("./AjarFilter/Shared/PolicyStore.swift");
const groupMatch = policyStore.match(/defaultAppGroup\s*=\s*"([^"]+)"/);
if (!groupMatch) {
  fail("AjarFilter/Shared/PolicyStore.swift: no defaultAppGroup literal to check against");
  process.exit(1);
}
const GROUP = groupMatch[1];

const copies = [
  ["AjarFilter/App/AjarFilter.entitlements", "./AjarFilter/App/AjarFilter.entitlements"],
  ["AjarFilter/FilterDataProvider/FilterDataProvider.entitlements", "./AjarFilter/FilterDataProvider/FilterDataProvider.entitlements"],
  ["AjarFilter/FilterControlProvider/FilterControlProvider.entitlements", "./AjarFilter/FilterControlProvider/FilterControlProvider.entitlements"],
  ["AjarSafari/App/AjarSafari.entitlements", "./AjarSafari/App/AjarSafari.entitlements"],
  ["AjarSafari/ExtensionShim/AjarSafariExtension.entitlements", "./AjarSafari/ExtensionShim/AjarSafariExtension.entitlements"],
  ["AjarSafari/ExtensionShim/SafariWebExtensionHandler.swift", "./AjarSafari/ExtensionShim/SafariWebExtensionHandler.swift"],
];
/** Every group named in an entitlements plist's application-groups array. */
function groupsInPlist(text) {
  const arr = text.match(/<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!arr) return [];
  return [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].trim());
}

for (const [label, path] of copies) {
  let text;
  try { text = read(path); } catch { fail(`${label}: missing — every target that touches policy needs the App Group`); continue; }
  // Exact values, never a substring test: "group.family.ajar.filterX" contains
  // "group.family.ajar.filter" and is a different, empty container.
  const named = path.endsWith(".swift")
    ? [literalFor(text, "appGroup")].filter((v) => v !== undefined)
    : groupsInPlist(text);
  if (named.length === 0) fail(`${label}: no App Group declared`);
  else if (!named.includes(GROUP)) fail(`${label}: names ${named.map((n) => `"${n}"`).join(", ")}, not "${GROUP}"`);
}

// ---------------------------------------------------------------------------
// The UserDefaults keys the Safari handler duplicates. Written where they are
// defined; read where they are copied.
// ---------------------------------------------------------------------------
const backendClient = read("./AjarFilter/App/BackendClient.swift");
const handler = read("./AjarSafari/ExtensionShim/SafariWebExtensionHandler.swift");

const keys = [
  ["snapshotKey", policyStore, "PolicyStore"],
  ["signingKeyKey", null, "PolicyStore"],       // named enrolledKeyKey there
  ["provisionedKey", policyStore, "PolicyStore"],
  ["deviceIdKey", backendClient, "BackendClient"],
];

for (const [name, source, owner] of keys) {
  const copy = literalFor(handler, name);
  if (copy === undefined) { fail(`SafariWebExtensionHandler.swift: no ${name} literal`); continue; }
  // signingKeyKey is called enrolledKeyKey in PolicyStore — same string, and the
  // rename is exactly the kind of thing that would otherwise drift unnoticed.
  const truth = name === "signingKeyKey"
    ? literalFor(policyStore, "enrolledKeyKey")
    : literalFor(source, name);
  if (truth === undefined) { fail(`${owner}: no source literal for ${name}`); continue; }
  if (copy !== truth) {
    fail(`SafariWebExtensionHandler.${name} is "${copy}" but ${owner} writes "${truth}" — Safari would read nothing`);
  }
}

if (failures) {
  console.error(`\n${failures} App-Group mismatch(es). A drifted copy makes Safari filtering fail silently open.`);
  process.exit(1);
}
console.log(`app-group: ${GROUP} consistent across ${copies.length} targets, ${keys.length} keys match their source`);
