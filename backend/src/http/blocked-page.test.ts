/**
 * The block page's `u` parameter.
 *
 * This is the screen whose entire job is to let a child ask, and it is reflected
 * input on an unauthenticated page — so it has to be permissive enough to work
 * and strict enough not to become a redirect into `javascript:`.
 *
 * The bug that prompted these tests: iOS substitutes the flow URL into
 * `remediationMap`, and for a socket flow there is no full URL, so it passes the
 * HOST. A real child hitting a real block got `?u=www.youtube.com/`, the
 * `^https?://` guard rejected it, and the page rendered "No address came
 * through" with no button. The fix must not be "drop the guard".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBlockedTarget, blockedTargetParam, buildRouter } from "./api.js";
import { App } from "../app.js";
import type { HttpRequest } from "./router.js";

test("a bare host gets a scheme instead of being thrown away", async () => {
  // Exactly what iOS sent in the report.
  assert.equal(normalizeBlockedTarget("www.youtube.com/"), "https://www.youtube.com/");
  assert.equal(normalizeBlockedTarget("www.youtube.com"), "https://www.youtube.com/");
  assert.equal(normalizeBlockedTarget("youtu.be/dQw4w9WgXcQ"), "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(
    normalizeBlockedTarget("www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

test("a host with a port is a host, not a scheme", async () => {
  // `.` and `-` are legal scheme characters, so matching /^[a-z][a-z0-9+.-]*:/
  // against the whole string reads this as the scheme "www.youtube.com" and
  // discards an ordinary URL. The port has to be told apart from a scheme.
  assert.equal(normalizeBlockedTarget("example.com:8080/x"), "https://example.com:8080/x");
  assert.equal(normalizeBlockedTarget("localhost:8787/blocked"), "https://localhost:8787/blocked");
});

test("http and https still pass through", async () => {
  assert.equal(normalizeBlockedTarget("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(normalizeBlockedTarget("http://example.com/"), "http://example.com/");
  assert.equal(normalizeBlockedTarget("HTTPS://EXAMPLE.com/A"), "https://example.com/A");
});

test("every other scheme is refused", async () => {
  // The whole reason the guard exists. Each of these is reflected into an href
  // if it gets through.
  for (const hostile of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ajar://request?u=x",
    "vbscript:msgbox(1)",
    "  javascript:alert(1)",
  ]) {
    assert.equal(normalizeBlockedTarget(hostile), "", `accepted ${JSON.stringify(hostile)}`);
  }
});

test("a protocol-relative URL is refused", async () => {
  // `//evil.com` inherits the page's scheme and is a redirect in disguise. Its
  // authority is empty, which is what the shape check has to catch.
  assert.equal(normalizeBlockedTarget("//evil.com/x"), "");
  assert.equal(normalizeBlockedTarget("///evil.com"), "");
});

test("nothing, or nonsense, comes back as nothing", async () => {
  for (const empty of ["", "   ", "/", "?x=1", "#frag", ":", "http://"]) {
    assert.equal(normalizeBlockedTarget(empty), "", `accepted ${JSON.stringify(empty)}`);
  }
});

// --- and through the real route ------------------------------------------

function get(router: ReturnType<typeof buildRouter>, path: string) {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method: "GET", path: url.pathname, query: url.searchParams,
    // Both live adapters pass this; the block page is the one route that needs
    // it, and testing without it would test the lossy fallback instead.
    rawQuery: url.search.replace(/^\?/, ""),
    headers: {}, params: {}, json: async () => ({}) as never,
  };
  return router.handle(req);
}

/** A request shaped like the one iOS actually sends: `u` substituted raw. */
const rawReq = (rawQuery: string): HttpRequest => ({
  method: "GET", path: "/blocked",
  query: new URLSearchParams(rawQuery),
  rawQuery,
  headers: {}, params: {}, json: async () => ({}) as never,
});

test("a target with its own query survives intact — & does not end it", async () => {
  // THE case this exists for, and it is not YouTube. iOS substitutes the flow
  // URL unencoded, so URLSearchParams would hand back "…?id=123" and drop
  // "&page=2" — and a non-YouTube block becomes a URL rule for that exact
  // string, so the parent approves a URL the child is not on.
  assert.equal(
    blockedTargetParam(rawReq("u=https://example.com/a?id=123&page=2")),
    "https://example.com/a?id=123&page=2",
  );
  assert.equal(
    blockedTargetParam(rawReq("u=example.com/search?q=frogs&safe=off&page=3")),
    "example.com/search?q=frogs&safe=off&page=3",
  );
  // And the same shape through normalisation, end to end.
  assert.equal(
    normalizeBlockedTarget(blockedTargetParam(rawReq("u=example.com/a?id=1&page=2"))),
    "https://example.com/a?id=1&page=2",
  );
});

test("YouTube was the only case the old parse survived", async () => {
  // Kept as a regression marker: `v` precedes the first `&`, which is why the
  // truncation looked harmless. It is not a reason to stop reading at the `&`.
  assert.equal(
    blockedTargetParam(rawReq("u=https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&pp=xyz")),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&pp=xyz",
  );
});

test("params before u are still parsed as params", async () => {
  // The ordering contract: `u` runs to the end, so everything else goes first.
  const req = rawReq("ally=Dad&u=example.com/a?x=1&y=2");
  assert.equal(req.query.get("ally"), "Dad");
  assert.equal(blockedTargetParam(req), "example.com/a?x=1&y=2");
});

test("a parameter merely ENDING in u is not mistaken for u", async () => {
  assert.equal(blockedTargetParam(rawReq("menu=x")), "");
  assert.equal(blockedTargetParam(rawReq("nu=x&u=example.com/")), "example.com/");
});

test("an encoded target is decoded exactly once", async () => {
  // The extensions percent-encode properly; iOS does not. Both have to work.
  assert.equal(
    blockedTargetParam(rawReq(`u=${encodeURIComponent("https://example.com/a?id=1&page=2")}`)),
    "https://example.com/a?id=1&page=2",
  );
  // A malformed escape must not throw and take the page down with it.
  assert.equal(blockedTargetParam(rawReq("u=example.com/100%discount")), "example.com/100%discount");
});

test("the page a child actually gets has the ask button on it", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  const res = await get(r, "/blocked?u=www.youtube.com/");
  assert.equal(res.status, 200);
  const page = String(res.body);

  assert.match(page, /You can ask to open this page/);
  assert.match(page, /ajar:\/\/request\?u=/, "the deep link the button opens");
  assert.doesNotMatch(page, /This page is closed/);
  // The site name, not a uuid and not the raw string with its scheme.
  assert.match(page, /youtube\.com/);
});

test("a hostile target still renders the closed page, not a link", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  const res = await get(r, `/blocked?u=${encodeURIComponent("javascript:alert(1)")}`);
  assert.match(String(res.body), /This page is closed/);
  assert.doesNotMatch(String(res.body), /javascript:/i);
});

test("the child's name is shown when the device passes one", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const res = await get(r, "/blocked?u=www.youtube.com/&ally=Dad");
  assert.match(String(res.body), /Ask Dad/);
});

test("end to end: a multi-param page reaches the button with its query whole", async () => {
  // The engine was never the problem — normalizeExactUrl sorts params and drops
  // the fragment, so an exact-URL rule matches robustly. It only ever gets the
  // URL the block page captured, which is why the capture had to be exact.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  const res = await get(r, "/blocked?u=example.com/article?id=123&page=2");
  const page = String(res.body);

  assert.match(page, /You can ask to open this page/);
  // The deep link carries the WHOLE thing; the app turns it into the URL rule.
  const link = /href="(ajar:\/\/request\?u=[^"]*)"/.exec(page)?.[1];
  assert.ok(link, "the ask button is a deep link");
  const carried = new URL(link!.replace(/&amp;/g, "&")).searchParams.get("u");
  assert.equal(carried, "https://example.com/article?id=123&page=2");
});

// --- getting back to the page after a parent says yes ------------------------

test("the page offers a way back to the target without any script", async () => {
  // The load-bearing path. A child whose parent has just approved needs an
  // action that works with no JS, no storage and no policy lookup: navigating to
  // the target puts the question to the filter, which is the only thing whose
  // answer is authoritative.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked?u=www.youtube.com/watch?v=abc&t=30")).body);

  const again = /<a class="btn again" href="([^"]*)"/.exec(page)?.[1];
  assert.equal(again?.replace(/&amp;/g, "&"), "https://www.youtube.com/watch?v=abc&t=30");
});

test("the auto-retry fires only on a RELOAD, which is what stops it looping", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked?u=www.youtube.com/")).body);

  // The filter's own render is a "navigate", and so is the one that comes back
  // from a refused retry — so the retry can never chain into a second.
  assert.match(page, /reloaded = nav\.type === "reload"/);
  assert.match(page, /if \(reloaded\) location\.replace\(target\)/);
  assert.doesNotMatch(page, /setInterval|setTimeout/, "no polling, no timers");
});

test("the closed page carries no script at all", async () => {
  // Nothing to retry, so nothing to run.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked")).body);
  assert.doesNotMatch(page, /<script/);
});

test("the target is escaped for a script context, not just for HTML", async () => {
  // JSON.stringify alone would let a `</script>` in the value close the element.
  // A parsed URL cannot carry one — `<` is percent-encoded and a `<` in the host
  // makes parsing throw — but the escaping does not rely on that reasoning.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, `/blocked?u=${encodeURIComponent("example.com/</script><img src=x>")}`)).body);

  assert.doesNotMatch(page, /<\/script><img/, "the value did not break out of the script");
  assert.match(page, /var target = "[^"]*"/, "and it is still a plain string literal");
});

test("a child can write a note, and it reaches the app without a script", async () => {
  // The Windows and macOS block pages have collected a reason since they were
  // written; this one did not, so every iOS ask reached the parent contextless
  // and the quote block on both parent surfaces was dead weight on the flagship
  // platform.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked?u=www.youtube.com/")).body);

  // A real label, not a placeholder standing in for one (SC 3.3.2).
  assert.match(page, /<label for="note"/, "the note field has a real label");
  assert.match(page, /id="note"/);
  // Bounded on the page as well as in the app: this is reflected input on an
  // unauthenticated screen and the deep link is editable by whoever holds the
  // device.
  assert.match(page, /maxlength="280"/);

  // The button's href is COMPLETE before any script runs. If the inline script
  // never executes, the ask still works — it just carries no note, which is
  // exactly the behaviour that shipped before the field existed.
  assert.match(page, /id="ask" *>|<a class="btn" href="ajar:\/\/request\?u=[^"]+" id="ask"/,
    "the ask link is server-rendered with a working href");
  assert.match(page, /ajar:\/\/request\?u=/);
});

test("the closed page has no note field to fill in", async () => {
  // Nothing to ask about means nothing to annotate. A field here would invite a
  // child to type an explanation into a form that cannot send it.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked")).body);

  assert.match(page, /This page is closed/);
  assert.doesNotMatch(page, /id="note"/);
});

test("the two accessibility claims the docs record as Done are actually shipped", async () => {
  // UX_PRINCIPLES §8 records both of these as Done and cites "the block screens"
  // for the second. Both extension copies honour them; this page — the only one
  // on the flagship platform — honoured neither, so the doc was describing two
  // thirds of the product. Asserted here so the claim and the code cannot drift
  // apart again silently.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const page = String((await get(r, "/blocked?u=www.youtube.com/")).body);

  // 44px targets, not the WCAG 2.5.8 floor of 24, on a control a child taps.
  assert.match(page, /summary\s*\{[^}]*min-height:\s*44px/,
    "the Details disclosure is a 44px target");
  assert.doesNotMatch(page, /min-height:\s*24px/);

  // `safe center`: at 200% zoom a plain `center` puts the heading and the ask
  // button off the top of the flex container with no way to scroll back.
  assert.match(page, /align-items:\s*safe center/);

  // A focus ring at all. The page defined none, so every control fell back to
  // the UA default in a palette designed around a two-tone ring.
  assert.match(page, /:focus-visible\s*\{/);
});
