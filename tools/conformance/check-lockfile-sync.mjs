#!/usr/bin/env node
/**
 * Every dependency a workspace declares must match the root lockfile.
 *
 * WHY IT IS SEPARATE FROM `npm ci`, WHICH ALREADY CHECKS THIS. `npm ci` fails
 * with sixty lines of usage text in which one sentence is the actual problem
 * ("lock file's X@13.3.3 does not satisfy X@14.0.0") and none of them is the
 * fix. This runs BEFORE the install, needs no node_modules, and says what to do.
 *
 * WHY IT KEEPS HAPPENING. Renovate edits `backend/package.json` and updates the
 * root `package-lock.json` in a second step. When that step fails or is skipped
 * the PR is still opened, and it cannot be merged or built — the failure lands
 * on whoever looks at CI rather than on the bot that made it.
 *
 *   node tools/conformance/check-lockfile-sync.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

const problems = [];
let checked = 0;

/** Where the lock records a workspace's own declared deps. */
const lockPackages = lock.packages ?? {};

for (const ws of ["", ...(rootPkg.workspaces ?? [])]) {
  const pkgPath = join(root, ws, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  // The lock mirrors each workspace's package.json under its path.
  const mirrored = lockPackages[ws] ?? lockPackages[ws || ""] ?? null;
  if (ws && !mirrored) {
    problems.push(`the lockfile has no entry for the "${ws}" workspace at all.`);
    continue;
  }
  const lockDeclared = mirrored
    ? { ...(mirrored.dependencies ?? {}), ...(mirrored.devDependencies ?? {}) }
    : {};

  for (const [name, range] of Object.entries(declared)) {
    checked++;
    const inLock = lockDeclared[name];
    if (inLock === undefined) {
      problems.push(`${ws || "."}/package.json requires ${name}@${range}, which the lockfile does not record for that workspace.`);
    } else if (inLock !== range) {
      problems.push(`${ws || "."}/package.json requires ${name}@${range}, but the lockfile records ${name}@${inLock}.`);
    }
  }
}

if (problems.length > 0) {
  console.error("package.json and package-lock.json disagree:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\n`npm ci` will refuse to install. Fix it on this branch with:\n" +
    "\n    npm install\n" +
    "\nthen commit the updated package-lock.json. Do not edit the lockfile by hand,\n" +
    "and do not switch CI to `npm install` — `npm ci` refusing is the check working.",
  );
  process.exit(1);
}

console.log(`lockfile: ${checked} declared dependencies, all matching package-lock.json`);
