#!/usr/bin/env node
/**
 * Every environment variable the server READS must be documented where an
 * operator will look.
 *
 * This is not tidiness. `MAIL_ENDPOINT`, `MAIL_TOKEN` and `VERIFY_EMAIL_URL`
 * were absent from INSTALL.md, so anyone self-hosting followed the guide exactly
 * and could not create an account: the server accepts the sign-up, answers 202,
 * says "check your email", and drops the message. No error on any screen. Same
 * shape for `PASSKEY_RP_ID` — undocumented, defaults to localhost, and every
 * passkey ceremony is silently refused by the browser on a real domain.
 *
 * A variable that changes whether the product works at all, and is not written
 * down, is a variable that does not exist as far as an operator is concerned.
 *
 *   node tools/conformance/check-env-documented.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Variables read only by tests, tooling, or the CI harness. */
const NOT_OPERATOR_FACING = new Set([
  "NODE_ENV", "CI", "TRUST_PROXY_HEADERS_TEST",
]);

/** Where an operator is told to look. A var may be documented in any of these. */
const DOCS = ["docs/INSTALL.md", "docs/DEPLOYMENT.md", "backend/wrangler.toml"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const sources = walk(join(root, "backend", "src"));
const found = new Map();   // VAR -> first file that reads it
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  // process.env.FOO and env.FOO on the Workers Env object.
  for (const m of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
    if (!found.has(m[1])) found.set(m[1], file.slice(root.length + 1));
  }
  for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
    if (!found.has(m[1])) found.set(m[1], file.slice(root.length + 1));
  }
}

const docText = DOCS.map((d) => {
  try { return readFileSync(join(root, d), "utf8"); } catch { return ""; }
}).join("\n");

let failures = 0;
for (const [name, where] of [...found].sort()) {
  if (NOT_OPERATOR_FACING.has(name)) continue;
  if (docText.includes(name)) continue;
  console.error(`FAIL ${name} is read by ${where} and documented in none of: ${DOCS.join(", ")}`);
  failures++;
}

if (failures) {
  console.error(`\n${failures} undocumented environment variable(s). An operator following the `
    + "guide exactly must end up with a working deployment, not a silent one.");
  process.exit(1);
}
console.log(`env: ${found.size} variables read, all documented`);
