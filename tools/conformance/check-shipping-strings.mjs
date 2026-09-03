#!/usr/bin/env node
/**
 * Strings the OS renders on a CHILD's screen must not be written for a reader of
 * this repository.
 *
 * This has now been caught twice, both times by a photograph of a phone rather
 * than by anything here:
 *   - the filter app called itself "ParentFilter PoC" in Settings;
 *   - the Safari extension's description read "Experiment scaffold — not
 *     production", under its own name, in the child's extension settings.
 * Both shipped because the string lives in a config file nobody reads as copy.
 *
 * It also flags development hosts. `host_permissions` listed localhost and
 * 127.0.0.1, and Safari renders granted hosts BY NAME in the permission screen,
 * so a child's phone showed two development addresses.
 *
 *   node tools/conformance/check-shipping-strings.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Each: [pattern, why it must not reach a child's screen]. */
const FORBIDDEN = [
  [/\bPoC\b/i, "names the thing a proof of concept"],
  [/\bscaffold\b/i, "names the thing a scaffold"],
  [/not production/i, "tells a child the product is not real"],
  [/\bexperiment(al)?\b/i, "tells a child the product is an experiment"],
  [/\bTODO\b|\bFIXME\b/i, "is an unfinished note"],
  [/localhost|127\.0\.0\.1/i, "is a development address"],
  [/example\.(com|org)/i, "is a placeholder domain"],
];

const problems = [];
let checked = 0;

/** Extension manifests: `name` and `description` are rendered in Settings. */
for (const rel of ["apple/SafariExtension/Extension", "windows/extension"]) {
  const f = join(root, rel, "manifest.json");
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, "utf8"));
  for (const field of ["name", "description"]) {
    const value = m[field];
    if (typeof value !== "string") continue;
    checked++;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(value)) {
        problems.push(`${rel}/manifest.json "${field}" ${why}:\n      ${value}`);
      }
    }
  }
  // Safari lists every granted host by name on the child's permission screen.
  for (const host of m.host_permissions ?? []) {
    checked++;
    if (/localhost|127\.0\.0\.1/i.test(host)) {
      problems.push(
        `${rel}/manifest.json host_permissions includes "${host}", a development\n` +
        `      address the child's permission screen renders by name.`,
      );
    }
  }
}

/**
 * Targets that never reach a child, so their names may say what they are.
 *
 * Adding to this list is a claim that nobody's kid will ever see the string —
 * not that the string is fine. `poc-urlfilter` is the NEURLFilter research
 * scaffold (PoC D): it is built to answer a question about Apple's API and is
 * not installed on anyone's device, so "URLFilter PoC" is accurate rather than
 * embarrassing.
 */
const NOT_SHIPPED = new Set(["poc-urlfilter"]);

/** Apple bundle display names, which appear on the home screen and in Settings. */
for (const dir of readdirSync(join(root, "apple"), { withFileTypes: true })) {
  if (!dir.isDirectory() || NOT_SHIPPED.has(dir.name)) continue;
  const f = join(root, "apple", dir.name, "project.yml");
  if (!existsSync(f)) continue;
  for (const m of readFileSync(f, "utf8").matchAll(
    /^\s*(CFBundleDisplayName|CFBundleName):\s*(.+?)\s*$/gm,
  )) {
    checked++;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(m[2])) {
        problems.push(`apple/${dir.name}/project.yml ${m[1]} ${why}:\n      ${m[2]}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("Strings a child's device will render, written for the wrong reader:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`shipping strings: ${checked} user-visible values, none naming a PoC, an experiment or a dev host`);
