/**
 * page-hook.js — runs in the PAGE's JavaScript world, not the extension's.
 *
 * WHY THIS FILE EXISTS. content.js patched `history.pushState` and
 * `history.replaceState` and believed that caught in-page navigation. It did
 * not. A content script runs in an ISOLATED world: it shares the DOM but not the
 * JavaScript globals, so assigning `history.pushState` there replaces the
 * function the CONTENT SCRIPT would call and leaves the one the PAGE calls
 * untouched. The patch had no effect on any site.
 *
 * What still fired were `popstate`, `hashchange` — real window events, which do
 * reach the isolated world — and `yt-navigate-finish`, a YouTube-proprietary
 * event. So in-page gating worked on YouTube, by accident, through a
 * vendor-specific hook, and nowhere else. Reddit, X, Instagram, TikTok and
 * Google Search all route with `pushState` and were never re-evaluated: one
 * approved page opened the whole site. That is the product's central claim
 * failing on every site but the one it was debugged against.
 *
 * This file is injected by content.js as a <script src> pointing at a
 * web-accessible resource, so it executes in the page's world where the patch
 * bites. It makes NO policy decision and reads no state: it observes a route
 * change and announces it on a DOM event, which crosses the world boundary.
 *
 * It is the SECOND of two mechanisms. The first is
 * `webNavigation.onHistoryStateUpdated` in background.js, which is privileged,
 * needs no page cooperation and cannot be stopped by a page's CSP. This one
 * covers the case where that event is unavailable — a page CSP that forbids our
 * script element defeats this file, and a browser that does not deliver the
 * event defeats that one, so neither is trusted alone.
 */

(() => {
  const EVENT = "ajar:route";

  function announce() {
    // Read the URL after the call, synchronously: history.pushState applies it
    // before returning.
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: location.href }));
    } catch {
      /* a torn-down document */
    }
  }

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    if (typeof original !== "function") continue;
    history[name] = function (...args) {
      const result = original.apply(this, args);
      announce();
      return result;
    };
  }

  // The element only had to run; leaving it in the DOM would show up in the
  // page's own inspection of itself for no benefit.
  document.currentScript?.remove();
})();
