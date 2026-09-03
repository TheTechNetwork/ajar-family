/**
 * content.js — SPA route-change interceptor for the Safari Web Extension (PoC B).
 *
 * WHY THIS EXISTS: YouTube is a single-page app. Clicking a recommendation, a
 * Short, "next video", or a channel link changes the URL via
 * history.pushState / history.replaceState WITHOUT a network navigation, so
 * webNavigation.onBeforeNavigate and declarativeNetRequest in the background
 * worker never fire. Without this, a child could navigate from an approved
 * video straight into a blocked one and never be gated (docs/MACOS_SAFARI_POC.md B3).
 *
 * WHAT IT DOES: patch pushState/replaceState, listen for popstate, and on every
 * URL change ask the background worker to re-evaluate the new URL against the
 * shared policy model. The background worker owns the decision + the redirect to
 * blocked.html (so all gating logic stays in one place, in lockstep with
 * shared/policy). This script does NOT make policy decisions itself.
 *
 * Runs at document_start (see manifest) so the history patch is installed before
 * YouTube's own router. Never blocks Safari — it only reports route changes.
 */

(() => {
  let lastUrl = location.href;

  function notify(url) {
    if (url === lastUrl) return;
    const previous = lastUrl;
    lastUrl = url;
    try {
      // Ask the background worker to evaluate.
      //
      // TOP FRAME: it redirects the tab to blocked.html; stopping playback here
      // is a belt-and-braces cover for the window before the redirect lands.
      //
      // SUBFRAME: it deliberately does NOT redirect — throwing the child off an
      // allowed page because an embed on it is blocked is its own bug — so this
      // frame is what closes itself. Stop the media and empty the document, and
      // the surrounding page carries on.
      // `from` is the route they were ON — the referrer for an in-page change.
      // Captured before `lastUrl` is overwritten above; the background worker
      // reduces it to a host and never lets it decide anything.
      browser.runtime.sendMessage({ type: "EVALUATE_URL", url, from: previous }).then((res) => {
        if (!res || !res.blocked) return;
        hardStopPlayback();
        // `res.top` is the background worker's reading of sender.frameId, not
        // this frame's own claim about itself.
        if (res.top === false) closeThisFrame();
      });
    } catch (e) {
      // Background worker may be briefly unloaded (Safari); the next route
      // change (or the full-navigation path) will re-trigger evaluation.
      console.warn("[guard] could not reach background worker:", e);
    }
  }

  // Best-effort immediate stop so audio/video doesn't keep playing in the
  // window between the route change and the background redirect. This is a UX
  // nicety, not the enforcement mechanism (the redirect is).
  function hardStopPlayback() {
    for (const v of document.querySelectorAll("video, audio")) {
      try {
        v.pause();
        v.currentTime = 0;
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Blank a blocked SUBFRAME in place.
   *
   * No block page and no Request-Access here: the page around this frame is
   * allowed, an ask filed from an invisible ad frame is not something a parent
   * could make sense of, and a full block page rendered inside a 300x250 box is
   * not a thing a child can read or use. It goes quiet instead. If the child
   * wants the embedded thing, they open it, and that is a top-level navigation
   * with a block page and a button.
   */
  function closeThisFrame() {
    try {
      document.documentElement?.replaceChildren();
      // Stop whatever the frame was still fetching for itself.
      window.stop?.();
    } catch {
      /* ignore — a cross-origin or already-torn-down frame */
    }
  }

  // --- Catching in-page (SPA) route changes ---
  //
  // THE PATCH THAT USED TO BE HERE DID NOTHING. This file runs in an ISOLATED
  // world: it shares the DOM with the page but not the JavaScript globals, so
  // assigning `history.pushState` here replaced the function THIS script would
  // call and left the one the PAGE calls alone. Every site that routes with
  // pushState — Reddit, X, Instagram, TikTok, Google Search — was never
  // re-evaluated after its first load, so one approved page opened the whole
  // site. It appeared to work only on YouTube, and only because of the
  // vendor-specific `yt-navigate-finish` event below.
  //
  // Two mechanisms now, because neither is sufficient alone and neither is
  // verified on iOS Safari yet:
  //   1. `webNavigation.onHistoryStateUpdated` in background.js — privileged,
  //      needs no cooperation from the page, unstoppable by a page's CSP.
  //   2. page-hook.js, injected below into the PAGE's world, where the patch
  //      actually bites. Covers a browser that does not deliver that event.
  // A page CSP that forbids our script element defeats (2); a browser without
  // the event defeats (1). Both firing is harmless: the background worker's
  // decision is idempotent and a spent one-time grant is guarded by id.

  // Inject the page-world hook. `src` rather than inline text, so a page whose
  // CSP forbids inline script can still load it.
  try {
    const hook = document.createElement("script");
    hook.src = browser.runtime.getURL("page-hook.js");
    hook.async = false;
    (document.head || document.documentElement).appendChild(hook);
  } catch (e) {
    console.warn("[ajar] could not install the page-world route hook:", e);
  }

  // What page-hook.js announces, on a DOM event — which crosses the world
  // boundary that the function patch could not.
  document.addEventListener("ajar:route", (e) => {
    const url = typeof e.detail === "string" ? e.detail : location.href;
    notify(url);
  });

  // Back/forward and hash changes. These are real window events and DO reach an
  // isolated world, so they always worked and still do.
  window.addEventListener("popstate", () => notify(location.href));
  window.addEventListener("hashchange", () => notify(location.href));

  // YouTube fires this on internal SPA navigations. Kept as an extra signal for
  // that one site — but it is no longer the only thing holding this up, which is
  // what it silently was.
  window.addEventListener("yt-navigate-finish", () => notify(location.href));

  // Evaluate the initial load too, in SUBFRAMES.
  //
  // `webNavigation.onBeforeNavigate` returns early for `frameId !== 0`, so a
  // frame's first load is otherwise checked by nothing. The top frame is
  // already covered there and does not need a second, slower look.
  //
  // `lastUrl` starts at `location.href`, so calling notify() with it was a
  // guaranteed no-op — the line was dead on every page load, under a comment
  // saying it made testing deterministic.
  if (window.top !== window) {
    lastUrl = "";            // let the current URL through the dedupe once
    notify(location.href);
  }
})();
