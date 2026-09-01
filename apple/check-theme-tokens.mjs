#!/usr/bin/env node
/**
 * Check the Swift copies of the palette against web/parent/tokens.css.
 *
 *   node apple/check-theme-tokens.mjs
 *
 * WHY THIS EXISTS. tokens.css is the canonical palette and CI recomputes its
 * contrast ratios (web/parent/check-contrast.mjs). The four extension surfaces
 * inline a copy and sync-tokens.mjs proves those match. The SwiftUI apps hold a
 * third and fourth copy, in a different syntax that neither tool could read — so
 * the two files where a wrong hex would ship to a real device were the only
 * unchecked ones. A drifted `muted` in Swift is a contrast failure that passes
 * every check in this repo.
 *
 * The check is one-directional. Swift deliberately omits tokens it has no use
 * for (--accent is decorative-only and has no Swift constant at all), so a CSS
 * token with no Swift counterpart is fine. A Swift token with no CSS
 * counterpart is not: that is a colour invented here, which is the drift.
 *
 * Zero dependencies, Node's stdlib only — keep it that way.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const SWIFT = ["apple/AjarParent/App/Theme.swift", "apple/AjarFilter/App/Theme.swift"];

/** `--field-line` -> `fieldLine`, `--surface-2` -> `surface2`. */
const swiftName = (cssVar) =>
  cssVar.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Pull `--name: #RRGGBB` pairs out of one CSS block. */
function paletteFrom(css, blockRe) {
  const block = css.match(blockRe);
  if (!block) throw new Error(`tokens.css: could not find block ${blockRe}`);
  const out = new Map();
  for (const [, name, hex] of block[0].matchAll(/(--[a-z0-9-]+):\s*#([0-9a-fA-F]{6})\b/g)) {
    out.set(swiftName(name), hex.toUpperCase());
  }
  return out;
}

const css = readFileSync(join(repo, "web/parent/tokens.css"), "utf8");
const light = paletteFrom(css, /:root\s*\{[\s\S]*?\n\}/);
const dark = paletteFrom(css, /@media \(prefers-color-scheme: dark\)[\s\S]*?\n  \}/);

let failures = 0;
const fail = (file, msg) => {
  console.error(`FAIL  ${file}: ${msg}`);
  failures++;
};

for (const rel of SWIFT) {
  const swift = readFileSync(join(repo, rel), "utf8");
  const before = failures;
  let checked = 0;

  // static let ink2 = dyn(0x3E4F49, 0xC3D2CC)   — a light/dark pair
  // static let yes  = hex(0xFF8A5B)             — one colour in both themes
  for (const m of swift.matchAll(
    /static let (\w+)\s*=\s*(dyn|hex)\(0x([0-9A-Fa-f]{6})(?:,\s*0x([0-9A-Fa-f]{6}))?\)/g,
  )) {
    const [, name, fn, a, b] = m;
    const wantLight = light.get(name);
    if (wantLight === undefined) {
      fail(rel, `${name} has no --${name} in tokens.css — a colour invented in Swift`);
      continue;
    }
    checked++;
    if (a.toUpperCase() !== wantLight) {
      fail(rel, `${name} light is 0x${a.toUpperCase()}, tokens.css says #${wantLight}`);
    }
    if (fn === "dyn") {
      const wantDark = dark.get(name);
      if (wantDark === undefined) fail(rel, `${name} is dyn() but tokens.css has no dark value`);
      else if (b.toUpperCase() !== wantDark) {
        fail(rel, `${name} dark is 0x${b.toUpperCase()}, tokens.css says #${wantDark}`);
      }
    } else if (dark.get(name) !== undefined && dark.get(name) !== wantLight) {
      // hex() means "same in both themes". Only wrong if the CSS disagrees.
      fail(rel, `${name} is hex() but tokens.css gives it a different dark value #${dark.get(name)}`);
    }
  }

  if (checked === 0) fail(rel, "no tokens matched — the file's shape changed and this check went blind");
  else if (failures === before) console.log(`ok\t${rel}\t${checked} tokens`);
}

if (failures > 0) {
  console.error(`\n${failures} theme token mismatch(es). tokens.css is canonical; fix the Swift.`);
  process.exit(1);
}
console.log("theme tokens ok — Swift matches tokens.css in both themes");
