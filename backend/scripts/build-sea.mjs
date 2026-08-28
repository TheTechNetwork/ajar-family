/**
 * Build a single self-contained executable of the backend (API + parent
 * console) using Node's Single Executable Application feature, so a self-hoster
 * runs it with NO Node toolchain on the box (see docs/INSTALL.md).
 *
 * Steps (per Node's SEA docs, https://nodejs.org/api/single-executable-applications.html):
 *   1. esbuild bundles src/index.ts -> dist/backend.cjs (done by `npm run bundle`)
 *   2. node --experimental-sea-config generates the SEA blob
 *   3. copy the running `node` binary and inject the blob with postject
 *   4. on macOS, strip then re-apply an ad-hoc code signature (required)
 *
 * Runs on whatever OS invokes it — the produced binary targets that OS/arch.
 * Usage: node scripts/build-sea.mjs [outfile]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "..");
const distDir = join(backendDir, "dist");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const outfile = resolve(
  process.argv[2] ?? join(distDir, isWin ? "wren-backend.exe" : "wren-backend"),
);

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const blob = join(distDir, "sea-prep.blob");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: backendDir, ...opts });
}

mkdirSync(distDir, { recursive: true });

// 1. Generate the SEA blob from dist/backend.cjs (bundle must exist).
run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);

// 2. Copy the current node binary to the output path.
rmSync(outfile, { force: true });
copyFileSync(process.execPath, outfile);

// 3. On macOS the copied binary keeps node's signature — remove it before injecting.
if (isMac) {
  try {
    run("codesign", ["--remove-signature", outfile]);
  } catch {
    // codesign may be absent on minimal runners; ad-hoc re-sign below still helps.
  }
}

// 4. Inject the blob. postject flags differ slightly on macOS (Mach-O segment).
const postjectArgs = [
  "postject",
  outfile,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  FUSE,
];
if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
run("npx", ["--yes", ...postjectArgs], { shell: isWin });

// 5. macOS requires a valid (ad-hoc is fine) signature to run the modified binary.
if (isMac) {
  run("codesign", ["--sign", "-", outfile]);
}

// eslint-disable-next-line no-console
console.log(`\nSEA binary written: ${outfile}`);
