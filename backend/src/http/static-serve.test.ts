import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnder } from "./node-server.js";

/**
 * The static server hands a URL path to `readUnder`, so `readUnder` is the only
 * thing standing between a request path and the filesystem.
 *
 * The sibling-prefix case is the reason this file exists. The guard used to be
 * `full.startsWith(dir)`, which passes for a directory whose name merely BEGINS
 * with dir's — serving /web/site-old to a request scoped to /web/site. Nothing
 * about that is visible in a passing smoke test of the happy path.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ajar-static-"));
  await mkdir(join(root, "site"), { recursive: true });
  await mkdir(join(root, "site-old"), { recursive: true });
  await writeFile(join(root, "site", "index.html"), "<h1>site</h1>");
  await writeFile(join(root, "site", "signup.js"), "// signup");
  await writeFile(join(root, "site-old", "leak.html"), "SHOULD NOT BE SERVED");
  await writeFile(join(root, "secret.txt"), "SHOULD NOT BE SERVED");
  return { root, site: join(root, "site") };
}

test("serves a file that is genuinely inside the directory", async () => {
  const { site } = await fixture();
  const hit = await readUnder(site, "index.html");
  assert.equal(hit?.body.toString(), "<h1>site</h1>");
  const js = await readUnder(site, "signup.js");
  assert.equal(js?.body.toString(), "// signup");
});

test("refuses to climb out with ..", async () => {
  const { site } = await fixture();
  assert.equal(await readUnder(site, "../secret.txt"), null);
  assert.equal(await readUnder(site, "../../etc/passwd"), null);
  assert.equal(await readUnder(site, "a/b/../../../secret.txt"), null);
});

test("refuses a sibling directory whose name merely starts with this one's", async () => {
  const { site } = await fixture();
  // Resolves to <root>/site-old/leak.html — which a bare startsWith(dir) allows.
  assert.equal(await readUnder(site, "../site-old/leak.html"), null);
});

test("a missing file is null, not a throw", async () => {
  const { site } = await fixture();
  assert.equal(await readUnder(site, "nope.html"), null);
});

test("an empty directory (static serving disabled) never reads anything", async () => {
  assert.equal(await readUnder("", "index.html"), null);
});
