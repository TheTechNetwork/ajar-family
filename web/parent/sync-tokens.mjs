#!/usr/bin/env node
/**
 * Re-paste web/parent/tokens.css into the four extension surfaces' inline copies.
 *
 *   node web/parent/sync-tokens.mjs          # write
 *   node web/parent/sync-tokens.mjs --check  # exit 1 if any copy has drifted
 *
 * WHY THIS EXISTS. MV3 and Safari Web Extension pages can only load CSS from
 * inside their own bundle, and this project has no build step, so the token
 * block genuinely has to be duplicated. Duplication that nothing checks is how a
 * palette drifts back into a contrast failure, so this checks it. Zero
 * dependencies, Node's stdlib only — keep it that way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const tokens = readFileSync(join(here, "tokens.css"), "utf8").replace(/\n+$/, "");

const START =
  "/* =============================================================================\n" +
  "   ajar — design tokens + primitives.  CANONICAL SOURCE.";
const END = /\n\/\* ---- (?:block screen|setup page) layout/;

const TARGETS = [
  "windows/extension/blocked.html",
  "windows/extension/options.html",
  "macos/safari-extension/Extension/blocked.html",
  "macos/safari-extension/Extension/options.html",
];

const check = process.argv.includes("--check");
let drift = 0;

for (const rel of TARGETS) {
  const path = join(repo, rel);
  const src = readFileSync(path, "utf8");
  const start = src.indexOf(START);
  if (start < 0) { console.error(`no token block found in ${rel}`); process.exit(2); }
  END.lastIndex = 0;
  const tail = END.exec(src.slice(start));
  if (!tail) { console.error(`no end marker after the token block in ${rel}`); process.exit(2); }
  const end = start + tail.index;

  if (src.slice(start, end) === tokens) { console.log(`ok      ${rel}`); continue; }
  drift++;
  if (check) { console.error(`DRIFTED ${rel}`); continue; }
  writeFileSync(path, src.slice(0, start) + tokens + src.slice(end));
  console.log(`synced  ${rel}`);
}

if (check && drift) {
  console.error(`\n${drift} inline token cop${drift === 1 ? "y has" : "ies have"} drifted from web/parent/tokens.css. Run: node web/parent/sync-tokens.mjs`);
  process.exit(1);
}
