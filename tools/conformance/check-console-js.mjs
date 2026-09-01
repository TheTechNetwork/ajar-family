#!/usr/bin/env node
/**
 * The browser JavaScript is not compiled, not linted, and not run by any test.
 *
 * So a syntax error in it reaches a parent's browser as a blank console with a
 * message only devtools shows — and nothing in CI would have said a word. This
 * happened: a backtick inside an HTML comment inside a template literal, which
 * is exactly the failure the block page hit once already.
 *
 * Two things here:
 *   1. every browser script PARSES;
 *   2. `classifyRuleInput` — the one piece with real behaviour, turning what a
 *      parent typed into a policy target — gives the right answer.
 *
 *   node tools/conformance/check-console-js.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
const fail = (m) => { console.error(`FAIL ${m}`); failures++; };

// --- 1. everything parses --------------------------------------------------
const dirs = ["web/parent", "web/site", "apple/SafariExtension/Extension", "windows/extension"];
let checked = 0;
for (const dir of dirs) {
  let files = [];
  try { files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".js")); }
  catch { fail(`${dir} is missing`); continue; }
  for (const f of files) {
    checked++;
    try {
      // `--check` detects module syntax and reparses as ESM on its own, so the
      // extension files (which use import/export) need no flag. `--input-type`
      // cannot be combined with a file path at all.
      execFileSync(process.execPath, ["--check", join(dir, f)],
        { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      fail(`${dir}/${f} does not parse\n${String(e.stderr ?? e.message).trim().split("\n").slice(0, 4).join("\n")}`);
    }
  }
}

// --- 2. what a parent types becomes the right target -----------------------
const require_ = createRequire(import.meta.url);
let classifyRuleInput;
try {
  ({ classifyRuleInput } = require_(join(root, "web/parent/classify.js")));
} catch (e) {
  // Parses but throws on load — a reference to something that is not there.
  // `--check` cannot see this; a parent's browser would.
  fail(`web/parent/classify.js does not load: ${String(e.message).split("\n")[0]}`);
}
if (typeof classifyRuleInput !== "function") {
  console.error(`\n${failures || 1} console-JS failure(s).`);
  process.exit(1);
}

const CASES = [
  // A bare hostname means the SITE. Someone typing tiktok.com does not mean
  // "the home page of tiktok.com and nothing else".
  ["tiktok.com", "DOMAIN", "tiktok.com"],
  ["https://tiktok.com", "DOMAIN", "tiktok.com"],
  ["www.reddit.com", "DOMAIN", "reddit.com"],
  // A path means that page — closing one page must not close the site around it.
  ["https://www.reddit.com/r/space", "URL", "https://www.reddit.com/r/space"],
  ["https://example.com/a?x=1", "URL", "https://example.com/a?x=1"],
  // YouTube links are objects, not pages on youtube.com.
  ["https://youtu.be/9bZkp7q19f0", "YOUTUBE_VIDEO", "9bZkp7q19f0"],
  ["https://www.youtube.com/watch?v=9bZkp7q19f0&t=30s", "YOUTUBE_VIDEO", "9bZkp7q19f0"],
  ["https://m.youtube.com/watch?v=9bZkp7q19f0", "YOUTUBE_VIDEO", "9bZkp7q19f0"],
  ["https://www.youtube.com/shorts/abcdefghijk", "YOUTUBE_VIDEO", "abcdefghijk"],
  ["https://www.youtube.com/playlist?list=PLabcdefghij", "YOUTUBE_PLAYLIST", "PLabcdefghij"],
  ["https://www.youtube.com/@SomeCreator", "YOUTUBE_CHANNEL", "@SomeCreator"],
  ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "YOUTUBE_CHANNEL", "UCabcdefghijklmnopqrstuv"],
];
/** Never let a throw from the classifier crash this script — report it. A
 *  reference error inside the function body survives `--check` and survives
 *  loading; it only appears when a parent types something. */
function classify(input) {
  try { return { ok: true, value: classifyRuleInput(input) }; }
  catch (e) { return { ok: false, error: String(e.message).split("\n")[0] }; }
}

for (const [input, target, value] of CASES) {
  checked++;
  const r = classify(input);
  if (!r.ok) { fail(`classify(${JSON.stringify(input)}) threw: ${r.error}`); continue; }
  const got = r.value;
  if (!got) { fail(`classify(${JSON.stringify(input)}) returned nothing`); continue; }
  if (got.target !== target || got.value !== value) {
    fail(`classify(${JSON.stringify(input)}) = ${got.target}:${got.value}, expected ${target}:${value}`);
  }
}
// Nothing usable must not become a rule.
for (const bad of ["", "   ", "not a url", "ftp://x.com/a", "javascript:alert(1)"]) {
  checked++;
  const r = classify(bad);
  if (!r.ok) { fail(`classify(${JSON.stringify(bad)}) threw: ${r.error}`); continue; }
  if (r.value !== null) fail(`classify(${JSON.stringify(bad)}) should refuse, got a target`);
}

if (failures) {
  console.error(`\n${failures} console-JS failure(s).`);
  process.exit(1);
}
console.log(`console js: ${checked} checks passed`);
