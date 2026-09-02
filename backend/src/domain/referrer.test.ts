/**
 * The referring host: useful to a parent, and never allowed to decide anything.
 *
 * "The same video from classroom.google.com and from a YouTube search results
 * page" are not the same decision, and the console showed them identically. So
 * the ask now carries where the child was.
 *
 * THE TRUST BOUNDARY IS THE WHOLE FEATURE. The referrer is supplied by the
 * child's device, and this codebase has been bitten three times by exactly that
 * shape: `resolvedHosts` opened the safety floor, `list=` opened every video on
 * YouTube, and an unvalidated `targetType` opened the entire web. A referrer is
 * worse in one way — a child does not need to forge it. Any approved domain
 * that hosts user content (a forum, a doc, a subreddit) is a laundering
 * surface: put the link there, follow it, and the referrer honestly names an
 * approved domain.
 *
 * So it is display only, and these tests are what keeps it that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "../app.js";
import { normalizeReferrerHost } from "./services.js";

test("a referrer is reduced to a plausible host, or dropped", () => {
  // The HOST, never the URL: the product's claim is that only the thing a child
  // explicitly asks about is ever sent. "From reddit.com" is the signal a parent
  // needs; the rest of that URL is not ours to move.
  assert.equal(normalizeReferrerHost("classroom.google.com"), "classroom.google.com");
  assert.equal(normalizeReferrerHost("WWW.Reddit.com"), "reddit.com");
  assert.equal(normalizeReferrerHost("reddit.com."), "reddit.com");
  // A client that sent the whole referrer is absorbed, not punished — and the
  // path goes no further than this function.
  assert.equal(normalizeReferrerHost("https://reddit.com/r/something-private?x=1"), "reddit.com");

  // Anything that is not a plausible host is DROPPED, not shown. A parent
  // reading "from <something odd>" would be told something the product cannot
  // stand behind.
  for (const junk of ["", "   ", "localhost", "com", "not a host",
                      "javascript:alert(1)", "a".repeat(300), "-bad-.com", "..", "1"]) {
    assert.equal(normalizeReferrerHost(junk), undefined, `${JSON.stringify(junk)} should be dropped`);
  }
  assert.equal(normalizeReferrerHost(undefined), undefined);
});

test("the referrer reaches the parent, and junk does not", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const owner = await app.family.createUser("o@e.com", "O");
  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Kid");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "MACOS");
  const dev = await app.enrollment.redeem(tok.code, "pk", "Mac");
  const base = { familyId: fam.id, childId: child.id, deviceId: dev.id } as const;

  const good = await app.approvals.createRequest({
    ...base, targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0",
    referrerHost: "https://classroom.google.com/c/whatever",
  });
  assert.equal(good.referrerHost, "classroom.google.com", "the host is kept, the path is not");

  const junk = await app.approvals.createRequest({
    ...base, targetType: "DOMAIN", targetValue: "example.com", referrerHost: "not a host",
  });
  assert.equal(junk.referrerHost, undefined);

  // The FIRST referrer wins on a deduped re-file: a re-file after the child has
  // wandered elsewhere would otherwise rewrite where they were when they hit it,
  // which is the one thing this field is for.
  const again = await app.approvals.createRequest({
    ...base, targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0",
    referrerHost: "youtube.com",
  });
  assert.equal(again.id, good.id, "still the same ask");
  assert.equal(again.referrerHost, "classroom.google.com", "the original referrer is not overwritten");
});

test("nothing that decides can see a referrer", () => {
  // A structural check, because this is the property that erodes.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  // The spec and the Swift never touch it at all: they have no part in carrying
  // a referrer anywhere, so any mention is a mistake.
  for (const rel of ["shared/policy/policy-model.ts", "shared/policy/target-validate.ts",
                     "apple/AjarFilter/Shared/PolicyStore.swift"]) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.ok(!/referrer/i.test(text),
      `${rel} mentions a referrer — nothing that decides may see one`);
  }

  // The extension mirrors DO carry it — capture, block page, then the ask — so
  // the check is scoped to the region that decides: matchTarget through the end
  // of decide(), stopping where the block-page URL is built.
  for (const rel of [
    "apple/SafariExtension/Extension/background.js",
    "windows/extension/background.js",
  ]) {
    const text = readFileSync(join(root, rel), "utf8");
    const from = text.indexOf("function matchTarget(");
    const to = text.indexOf("function hostOf(");
    assert.ok(from > 0 && to > from, `${rel}: could not locate the decision region`);
    // COMMENTS ARE STRIPPED FIRST. The property is that no CODE in the decision
    // path touches a referrer; a comment explaining that boundary is exactly
    // what should be there, and an earlier version of this test failed on the
    // doc comment that says so.
    const code = text.slice(from, to)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/referrer|\bmsg\.from\b|\bfromHost\b/i.test(code),
      `${rel}: a referrer appears inside the evaluator — it is evidence for a person, not an input`);
  }

  // And the shared context type must not grow one.
  const model = readFileSync(join(root, "shared/policy/policy-model.ts"), "utf8");
  const at = model.indexOf("interface EvalContext");
  assert.ok(at > 0, "EvalContext not found");
  assert.ok(!/referrer/i.test(model.slice(at, at + 1600)), "EvalContext must not carry a referrer");
});
