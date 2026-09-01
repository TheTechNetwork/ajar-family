#!/usr/bin/env node
/**
 * The safety floor exists in four places and must be one list.
 *
 * A safety-floor entry is ALLOWED above every tier — above a parent's explicit
 * BLOCK, above default-deny — and is deliberately never reported, because "a
 * floor that is surveilled is not a floor". Those two properties together mean a
 * drifted copy is invisible in both directions: an extra entry silently voids a
 * rule the console still shows as active, and a missing one closes a crisis line
 * on one platform while the docs say it is open.
 *
 * The Safari and Windows mirrors both carried four entries the spec does not
 * have — who.int, cdc.gov, samhsa.gov, nhs.uk — under comments calling
 * themselves lockstep mirrors. `*.nhs.uk` alone is thousands of sites. Nothing
 * compared them, because the mirrors are hand-written JS that cannot be imported
 * (they call browser APIs at module scope) and the Swift is not JS at all.
 *
 * So this compares the source text. Crude, and it is the only thing that can see
 * all four.
 *
 *   node tools/conformance/check-safety-floor.mjs
 */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Domain literals inside the array that starts at `anchor`.
 *
 * Bounded to the array — anchor's "[" through its matching "]" — not a fixed
 * window of characters after it. A window swept up `988lifeline.org.evil.com`
 * out of the doc comment BELOW SafetyFloor.swift's list, which is a test case
 * for the suffix matcher, and reported it as a domain the Swift allows.
 */
function domainsAfter(text, anchor) {
  const i = text.indexOf(anchor);
  if (i < 0) return null;
  // The "[" of the ASSIGNMENT, not of a type annotation: `string[]` and
  // `[String]` both put a bracket pair between the name and the value.
  const eq = text.indexOf("=", i);
  const open = text.indexOf("[", eq);
  const close = text.indexOf("]", open);
  if (eq < 0 || open < 0 || close < 0) return null;
  return new Set(
    [...text.slice(open, close).matchAll(/"([a-z0-9-]+(?:\.[a-z0-9-]+)+)"/g)].map((m) => m[1]),
  );
}

const SOURCES = [
  { id: "shared (spec)", path: "../../shared/safety/safety-floor.ts", anchor: "SAFETY_FLOOR" },
  { id: "swift", path: "../../apple/AjarFilter/Shared/SafetyFloor.swift", anchor: "static let domains: [String] =" },
  { id: "safari", path: "../../apple/SafariExtension/Extension/background.js", anchor: "SAFETY_FLOOR_DOMAINS = [" },
  { id: "windows", path: "../../windows/extension/background.js", anchor: "SAFETY_FLOOR_DOMAINS = [" },
];

let failures = 0;
const fail = (m) => { console.error(`FAIL ${m}`); failures++; };

const spec = domainsAfter(read(SOURCES[0].path), SOURCES[0].anchor);
if (!spec || spec.size === 0) {
  console.error("FAIL shared/safety/safety-floor.ts: could not read the spec list");
  process.exit(1);
}

for (const s of SOURCES.slice(1)) {
  let text;
  try { text = read(s.path); } catch { fail(`${s.id}: ${s.path} is missing`); continue; }
  const got = domainsAfter(text, s.anchor);
  if (!got) { fail(`${s.id}: no list found at anchor "${s.anchor}"`); continue; }

  const extra = [...got].filter((d) => !spec.has(d));
  const missing = [...spec].filter((d) => !got.has(d));
  if (extra.length) {
    fail(`${s.id} allows ${extra.join(", ")} above every rule, and the spec does not — `
       + "a parent's block on these silently does not hold there");
  }
  if (missing.length) {
    fail(`${s.id} is missing ${missing.join(", ")} — a crisis line the spec keeps open is closed there`);
  }
}

if (failures) {
  console.error(`\n${failures} safety-floor divergence(s). This list outranks every rule and is never `
    + "reported, so a drifted copy is invisible on a device.");
  process.exit(1);
}
console.log(`safety floor: ${spec.size} domains, identical across ${SOURCES.length} implementations`);
