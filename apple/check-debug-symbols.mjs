#!/usr/bin/env node
/**
 * A member declared behind `#if DEBUG` and used outside one does not exist in a
 * Release build. Nothing in this repo notices until the slowest CI job — the
 * macOS Xcode build — fails minutes later with "cannot find X in scope".
 *
 * That is not hypothetical: `spentGrantsKey` was declared next to
 * `devUnsignedKey` inside PolicyStore's `#if DEBUG`, while `spendGrant()` — the
 * function that burns a ONCE approval on a real device — used it
 * unconditionally. Debug builds were fine. Release did not compile, and had it
 * compiled it would have been a production feature quietly deleted.
 *
 * This runs in seconds on Linux, so the `check` job catches it before the Apple
 * job starts.
 *
 * SCOPE, deliberately narrow so it does not cry wolf:
 *   - only declarations at file scope or type-member scope (brace depth 0/1),
 *     never locals inside a function body — `let data` in one debug method must
 *     not collide with `let data` in a release one;
 *   - only inside a type that Release DOES compile. A type wholly behind
 *     `#if DEBUG` (DebugHarnessView, FlowLog) is fine and its member names are
 *     its own business;
 *   - references are matched within the same file, which is where an implicit
 *     `self.member` reference lives. Cross-file uses go through an explicit
 *     instance and would fail the same build anyway.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function swiftFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...swiftFiles(p));
    else if (e.name.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** Strip string literals and line comments so neither can fake a declaration or a use. */
const scrub = (line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "");

/**
 * Per line: is it compiled only in DEBUG?
 *
 * `#else` of a `#if DEBUG` is the RELEASE branch and is reported as unguarded —
 * the safe direction, since a symbol declared there must exist in Release.
 */
function debugMask(lines) {
  const mask = new Array(lines.length).fill(false);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#if\b/.test(t)) stack.push({ dbg: /\bDEBUG\b/.test(t) && !/^#if\s*!/.test(t) });
    else if (/^#elseif\b/.test(t) && stack.length) stack[stack.length - 1].dbg = /\bDEBUG\b/.test(t);
    else if (/^#else\b/.test(t) && stack.length) stack[stack.length - 1].dbg = false;
    else if (/^#endif\b/.test(t)) stack.pop();
    mask[i] = stack.some((f) => f.dbg);
  }
  return mask;
}

/** Brace depth at the START of each line, ignoring braces in strings/comments. */
function depths(lines) {
  const out = new Array(lines.length).fill(0);
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    out[i] = d;
    const s = scrub(lines[i]);
    for (const ch of s) { if (ch === "{") d++; else if (ch === "}") d--; }
  }
  return out;
}

const TYPE = /\b(?:class|struct|enum|protocol|actor|extension)\b/;
const MEMBER = /\b(?:let|var|func)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

const failures = [];

for (const f of swiftFiles(join(ROOT, "apple"))) {
  const lines = readFileSync(f, "utf8").split("\n");
  const mask = debugMask(lines);
  const depth = depths(lines);

  // Members declared DEBUG-only inside a type Release still compiles.
  const decls = new Map(); // name -> declaration line index
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i] || depth[i] > 1) continue;
    // Find the enclosing top-level declaration; if IT is debug-only, skip.
    let enclosingIsDebug = false;
    if (depth[i] === 1) {
      for (let j = i; j >= 0; j--) {
        if (depth[j] === 0 && TYPE.test(scrub(lines[j]))) { enclosingIsDebug = mask[j]; break; }
      }
    }
    if (enclosingIsDebug) continue;
    for (const m of scrub(lines[i]).matchAll(MEMBER)) decls.set(m[1], i);
  }
  if (decls.size === 0) continue;

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    for (const m of scrub(lines[i]).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const declLine = decls.get(m[1]);
      if (declLine === undefined || declLine === i) continue;
      failures.push({
        name: m[1],
        declaredAt: `${relative(ROOT, f)}:${declLine + 1}`,
        use: `${relative(ROOT, f)}:${i + 1}`,
        text: lines[i].trim(),
      });
    }
  }
}

if (failures.length > 0) {
  console.error("Members declared behind #if DEBUG but used where Release also compiles:\n");
  for (const x of failures) {
    console.error(`  ${x.name}`);
    console.error(`    declared (DEBUG only): ${x.declaredAt}`);
    console.error(`    used (all configs):    ${x.use}`);
    console.error(`      ${x.text}`);
  }
  console.error(
    "\nMove the declaration out of #if DEBUG if the feature is real, or put the use\n" +
    "inside one if it is not. A Release build cannot see it.",
  );
  process.exit(1);
}

console.log("debug symbols: no DEBUG-only member is used from Release-compiled code");
