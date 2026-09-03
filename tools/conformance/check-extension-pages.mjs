#!/usr/bin/env node
/**
 * The browser-extension pages, on BOTH extensions, checked for the mistakes that
 * leave a page looking perfect and doing nothing.
 *
 * WHY IT EXISTS. `apple/SafariExtension/Extension/blocked.html` held its entire
 * logic in an inline `<script>`. MV3's default extension-page CSP is
 * `script-src 'self'`, so the browser refused to run any of it: the page showed
 * its static placeholders — a hard-coded "A YouTube video" and a literal "…"
 * where the URL goes — and "Ask to open it" had no handler. It screenshots
 * perfectly. The HTML is valid, the JavaScript is valid, the build is green, and
 * the one screen the product exists for is dead.
 *
 * WHY IT COVERS BOTH. `windows/extension/blocked.html` already loaded its script
 * from a file and was fine. So this was not a mistake anyone made twice — it was
 * one copy drifting from the other, with nothing comparing them. That is the
 * same failure the policy mirrors exist to prevent, applied to page structure.
 *
 *   node tools/conformance/check-extension-pages.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXTENSIONS = [
  "apple/SafariExtension/Extension",
  "windows/extension",
];

/** External schemes a page may legitimately point at. */
const EXTERNAL = /^(https?:|data:|mailto:|#|\/\/|blob:)/i;

const problems = [];
let pagesChecked = 0;

for (const rel of EXTENSIONS) {
  const dir = join(root, rel);
  if (!existsSync(dir)) continue;

  for (const name of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(join(dir, name), "utf8");
    pagesChecked++;

    // An inline <script> with a body. `<script src=...></script>` is the fix.
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      problems.push(
        `${rel}/${name} contains an inline <script>.\n` +
        `    MV3's extension-page CSP is script-src 'self': the browser refuses to run\n` +
        `    it, so the page renders its static placeholders and every control is dead.\n` +
        `    Move the code beside it as a .js file and load it with <script src="...">.`,
      );
    }

    // Inline handlers are refused by the same CSP, and fail just as quietly.
    for (const m of html.matchAll(/\s(on[a-z]+)\s*=\s*"/gi)) {
      problems.push(
        `${rel}/${name} uses an inline ${m[1]}= handler, which the extension CSP refuses.\n` +
        `    Attach it with addEventListener in the page's script instead.`,
      );
    }

    // Every local file the page names must actually be there.
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (EXTERNAL.test(ref)) continue;
      const target = ref.split(/[?#]/)[0];
      if (!existsSync(join(dir, target))) {
        problems.push(`${rel}/${name} references "${ref}", which does not exist in ${rel}/.`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("Extension pages that would load and do nothing:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`extension pages: ${pagesChecked} checked across ${EXTENSIONS.length} extensions — no inline script, no inline handlers, every local reference resolves`);
