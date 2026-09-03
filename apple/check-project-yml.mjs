#!/usr/bin/env node
/**
 * Two invariants about the XcodeGen projects that nothing else can see, because
 * both failures leave the build green.
 *
 * 1. A web-extension resource directory must NOT be a folder reference.
 *    `type: folder` copies the DIRECTORY into the appex, so the bundle gets
 *    Resources/Extension/manifest.json. Safari looks for manifest.json at the
 *    resources ROOT, finds nothing, and the extension never appears in Safari
 *    Settings — which reads as "it didn't get bundled", not as a path problem.
 *    xcodebuild is perfectly happy either way, so CI cannot catch it and neither
 *    can a person who is not looking for it.
 *
 * 2. Every generated Info.plist must be gitignored and untracked.
 *    Each is declared as an `info.path` and written by `xcodegen generate`. When
 *    one is not ignored it shows up as an untracked file, which reads as "somebody
 *    forgot to commit this" — and committing it is how three stale plists at a
 *    dead path, still displaying "ParentFilter PoC", once got into the repo (see
 *    .gitignore). The ignore list used to be enumerated target by target and had
 *    fallen behind by two targets.
 *
 *   node apple/check-project-yml.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const projects = readdirSync(join(ROOT, "apple"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, "apple", e.name, "project.yml")))
  .map((e) => join(ROOT, "apple", e.name, "project.yml"));

const problems = [];

/** Files that make a directory a web-extension bundle root. */
const WEBEXT_MARKER = "manifest.json";

for (const proj of projects) {
  const rel = relative(ROOT, proj);
  const lines = readFileSync(proj, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*path:\s*(\S+)\s*$/);
    if (!m) continue;

    // Gather this list entry's own keys (until the next `- ` at the same indent).
    const indent = lines[i].search(/\S/);
    const keys = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].search(/\S/);
      if (ind === -1) continue;
      if (ind <= indent) break;
      keys.push(lines[j].trim());
    }

    const isResources = keys.some((k) => k === "buildPhase: resources");
    const isFolderRef = keys.some((k) => k === "type: folder");
    if (!isResources || !isFolderRef) continue;

    const dir = resolve(dirname(proj), m[1]);
    if (!existsSync(join(dir, WEBEXT_MARKER))) continue;

    problems.push(
      `${rel}:${i + 1} — ${m[1]} holds ${WEBEXT_MARKER} and is a folder reference.\n` +
      `    The appex would get Resources/${m[1].split("/").pop()}/${WEBEXT_MARKER};\n` +
      `    Safari only reads ${WEBEXT_MARKER} at the resources root, so the extension\n` +
      `    never appears. Remove \`type: folder\` — XcodeGen still re-globs the\n` +
      `    directory, so new files need no project edit.`,
    );
  }

  // Every declared info.path is generated output.
  for (const m of readFileSync(proj, "utf8").matchAll(/^\s*path:\s*(\S*Info\.plist)\s*$/gm)) {
    const abs = resolve(dirname(proj), m[1]);
    const p = relative(ROOT, abs);

    let ignored = true;
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: ROOT });
    } catch {
      ignored = false;
    }
    if (!ignored) {
      problems.push(
        `${p} is generated (declared as an info.path in ${rel}) but is not gitignored.\n` +
        `    It will show up as untracked and invite being committed.`,
      );
    }

    const tracked = execFileSync("git", ["ls-files", "--", p], { cwd: ROOT, encoding: "utf8" }).trim();
    if (tracked) {
      problems.push(`${p} is generated but IS tracked in git. Remove it with \`git rm --cached\`.`);
    }
  }
}

// 3. Every path the manifest names must exist, and must be a bare filename.
//    Resources are flattened into the appex root (that is the whole point of not
//    using a folder reference), so `images/icon-48.png` would arrive as
//    `icon-48.png` and the manifest's path would resolve to nothing. Safari does
//    not report a missing icon or content script; the extension just behaves as
//    though the file were empty.
const extDir = join(ROOT, "apple", "SafariExtension", "Extension");
if (existsSync(join(extDir, WEBEXT_MARKER))) {
  const manifest = JSON.parse(readFileSync(join(extDir, WEBEXT_MARKER), "utf8"));
  const referenced = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      if (/\.(js|html|png|css|json)$/i.test(v)) referenced.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(manifest);

  for (const ref of [...referenced].sort()) {
    if (ref.includes("/")) {
      problems.push(
        `manifest.json references "${ref}", which is inside a directory.\n` +
        `    Copy Bundle Resources flattens the extension into the appex root, so\n` +
        `    that path cannot resolve. Move the file up beside manifest.json, or\n` +
        `    give its directory its own folder reference in both project.yml files.`,
      );
    } else if (!existsSync(join(extDir, ref))) {
      problems.push(
        `manifest.json references "${ref}" but apple/SafariExtension/Extension/${ref}\n` +
        `    does not exist. Safari reports nothing for a missing resource — the\n` +
        `    extension simply behaves as though the file were empty.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("XcodeGen project problems that leave the build green:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`project.yml: ${projects.length} projects — no web-extension folder references, every generated Info.plist ignored and untracked`);
