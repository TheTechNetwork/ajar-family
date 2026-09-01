/**
 * Turning what a parent TYPED into a policy target.
 *
 * A separate file from app.js for one reason: app.js touches the DOM at module
 * scope, so it cannot be loaded by a test, and this is the piece with real
 * behaviour to get wrong. Loaded as a plain script before app.js (this console
 * uses classic scripts, not modules) with a CommonJS shim at the bottom so
 * Node can require it.
 */

/**
 * Work out what a parent typed, so they never have to pick a "target type".
 *
 * A parent pastes a link or types a site name. Asking them to first classify it
 * as a DOMAIN vs a URL vs a YOUTUBE_CHANNEL is asking them to learn the policy
 * model, and the policy model is our problem.
 *
 * Deliberately conservative: when a bare hostname is typed we make a DOMAIN
 * rule (the whole site), because that is what someone typing "tiktok.com"
 * means. A full URL with a path stays a URL — closing one page should not close
 * the site around it.
 */
function classifyRuleInput(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  // A YouTube link, in any of its forms, is a video/channel/playlist — not a
  // page on youtube.com. Reusing the same canonicalisation the devices use
  // would mean shipping the normalizer to this page; the shapes we can read off
  // a URL confidently are enough, and anything else falls through to URL.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let u = null;
  try { u = new URL(withScheme); } catch { u = null; }

  if (u && (u.protocol === "http:" || u.protocol === "https:")) {
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const seg = u.pathname.split("/").filter(Boolean);

    if (host === "youtu.be" && seg[0]) {
      return { target: "YOUTUBE_VIDEO", value: seg[0], label: "YouTube video" };
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      const list = u.searchParams.get("list");
      if (seg[0] === "watch" && v) return { target: "YOUTUBE_VIDEO", value: v, label: "YouTube video" };
      if (seg[0] === "shorts" && seg[1]) return { target: "YOUTUBE_VIDEO", value: seg[1], label: "YouTube video" };
      if (seg[0] === "playlist" && list) return { target: "YOUTUBE_PLAYLIST", value: list, label: "YouTube playlist" };
      if (seg[0]?.startsWith("@")) return { target: "YOUTUBE_CHANNEL", value: seg[0], label: "YouTube channel" };
      if ((seg[0] === "channel" || seg[0] === "c" || seg[0] === "user") && seg[1]) {
        return { target: "YOUTUBE_CHANNEL", value: seg[0] === "channel" ? seg[1] : `${seg[0]}/${seg[1]}`,
                 label: "YouTube channel" };
      }
    }

    // A path (or a query) means they meant that page. Bare host means the site.
    const hasPath = seg.length > 0 || !!u.search;
    if (hasPath && /^[a-z]+:\/\//i.test(text)) {
      return { target: "URL", value: u.toString(), label: "this page" };
    }
    if (!hasPath && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
      return { target: "DOMAIN", value: host, label: "the whole site" };
    }
    if (hasPath) return { target: "URL", value: u.toString(), label: "this page" };
  }
  return null;
}

// Node (the test) sees `module`; a browser does not. Deliberately not a
// bundler-ism — this file is served to the browser exactly as it is written.
if (typeof module !== "undefined" && module.exports) module.exports = { classifyRuleInput };
