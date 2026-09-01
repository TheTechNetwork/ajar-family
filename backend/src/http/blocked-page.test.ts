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
import { normalizeBlockedTarget, buildRouter } from "./api.js";
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
    headers: {}, params: {}, json: async () => ({}) as never,
  };
  return router.handle(req);
}

test("the page a child actually gets has the ask button on it", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);

  const res = await get(r, "/blocked?u=www.youtube.com/");
  assert.equal(res.status, 200);
  const page = String(res.body);

  assert.match(page, /You can ask to unlock this page/);
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
