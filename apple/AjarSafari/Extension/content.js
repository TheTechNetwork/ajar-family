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
    lastUrl = url;
    try {
      // Ask the background worker to evaluate. It redirects the tab to
      // blocked.html if the new route is blocked; we don't need the reply, but
      // as a belt-and-suspenders stop we blank the media element meanwhile.
      browser.runtime.sendMessage({ type: "EVALUATE_URL", url }).then((res) => {
        if (res && res.blocked) hardStopPlayback();
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

  // --- Patch history.pushState / replaceState to catch SPA navigations ---
  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function (...args) {
    const ret = origPush.apply(this, args);
    // URL is applied synchronously; read it after the call.
    queueMicrotask(() => notify(location.href));
    return ret;
  };

  history.replaceState = function (...args) {
    const ret = origReplace.apply(this, args);
    queueMicrotask(() => notify(location.href));
    return ret;
  };

  // Back/forward and hash changes.
  window.addEventListener("popstate", () => notify(location.href));
  window.addEventListener("hashchange", () => notify(location.href));

  // YouTube fires this custom event on internal SPA navigations; use it as an
  // extra signal in case a future router bypasses history.* directly.
  window.addEventListener("yt-navigate-finish", () => notify(location.href));

  // Evaluate the initial load too (the full-navigation path also covers this,
  // but this makes content-script-only testing deterministic).
  notify(location.href);
})();
