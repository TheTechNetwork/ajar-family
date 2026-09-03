#!/usr/bin/env node
/**
 * An operator-facing variable must work on BOTH deploy targets, or be listed
 * here as target-specific with a reason.
 *
 * `check-env-documented.mjs` already proves every variable the server reads is
 * written down where an operator will look. It cannot see the other half of the
 * same failure: a variable that is documented, that the operator sets correctly,
 * and that their particular deploy target never reads. Nothing errors. The
 * setting simply does nothing, which is indistinguishable from it working — and
 * for `ALLOWED_ORIGIN` that is the difference between CORS locked to the console
 * and CORS open to every origin.
 *
 * The seam is real: `src/index.ts` (Node/self-host) reads `process.env`, and
 * `src/worker.ts` (Cloudflare) reads its own `Env` interface. They are written
 * separately, so a variable added to one and forgotten in the other is a one-line
 * mistake that no test, type or build catches. They agree today; this is what
 * keeps them agreeing.
 *
 * Borrowed from serverless-dns-01, which pins env semantics in unit tests rather
 * than trusting that a config surface stays consistent by inspection.
 *
 *   node tools/conformance/check-env-parity.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Deliberately Node-only, each because the concept does not exist on Workers.
 * Adding to this list is a decision to make a setting unavailable to anyone
 * self-hosting on Cloudflare, so it needs a reason someone can disagree with.
 */
const NODE_ONLY = {
  PORT: "Workers does not bind a port; the platform routes to fetch().",
  DATABASE_FILE: "Workers uses the D1 binding (DB) instead of a file path.",
  ALLOW_INSECURE_AUTH: "Local-testing escape hatch for the in-memory store. Workers "
    + "has no in-memory path and rejects a missing AUTH_SECRET outright.",
  PARENT_UI_DIR: "Node serves the console from disk; Workers uses the ASSETS binding.",
  TRUST_PROXY_HEADERS: "Workers gets a trustworthy client IP from cf-connecting-ip "
    + "at the edge, so there is no forwarded header to opt into trusting.",
};

/** Workers *bindings*, not environment variables — they have no Node equivalent. */
const WORKER_BINDINGS = new Set(["DB", "ASSETS", "EMAIL"]);

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// What the Node/self-host target reads, anywhere in the backend.
const nodeVars = new Set();
for (const f of tsFiles(join(root, "backend", "src"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)) nodeVars.add(m[1]);
}

// What the Workers target declares it accepts.
const workerSrc = readFileSync(join(root, "backend", "src", "worker.ts"), "utf8");
const envBlock = workerSrc.match(/interface Env\s*\{([\s\S]*?)\n\}/);
if (!envBlock) {
  console.error("check-env-parity: could not find the `Env` interface in backend/src/worker.ts.");
  process.exit(1);
}
const workerVars = new Set(
  [...envBlock[1].matchAll(/^\s*([A-Z][A-Z_0-9]*)\??\s*:/gm)].map((m) => m[1]),
);

const problems = [];

for (const v of [...nodeVars].sort()) {
  if (workerVars.has(v) || NODE_ONLY[v]) continue;
  problems.push(
    `${v} is read on the Node target but is not in worker.ts's Env interface.\n` +
    `    A Cloudflare operator who sets it gets no error and no effect.\n` +
    `    Add it to Env and honour it, or add it to NODE_ONLY here with a reason.`,
  );
}

for (const v of [...workerVars].sort()) {
  if (nodeVars.has(v) || WORKER_BINDINGS.has(v)) continue;
  problems.push(
    `${v} is accepted by the Workers target but nothing reads it on Node.\n` +
    `    A self-hosting operator who sets it gets no error and no effect.\n` +
    `    Read it in the Node path, or add it to WORKER_BINDINGS if it is a binding.`,
  );
}

// A stale reason is worse than none: it documents a divergence that no longer exists.
for (const v of Object.keys(NODE_ONLY)) {
  if (!nodeVars.has(v)) {
    problems.push(`${v} is listed in NODE_ONLY but nothing on the Node target reads it. Remove the entry.`);
  }
}

if (problems.length > 0) {
  console.error("Environment variables differ between the two deploy targets:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

const shared = [...nodeVars].filter((v) => workerVars.has(v)).length;
console.log(
  `env parity: ${shared} variables honoured on both targets, ` +
  `${Object.keys(NODE_ONLY).length} Node-only with reasons, ` +
  `${WORKER_BINDINGS.size} Workers bindings`,
);
