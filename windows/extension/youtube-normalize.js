/**
 * YouTube canonical-object normalization — JS port for the Windows MV3 extension.
 *
 * ⚠️ LOCKSTEP: This is a faithful, dependency-free port of
 * `shared/youtube/youtube-normalize.ts`. The TypeScript file is the SPEC and the
 * source of truth; this port MUST produce identical canonical objects and policy
 * keys for the same input. Any change to the shared file must be mirrored here
 * (enforced by review). Do not "improve" one side independently.
 *
 * The product treats YouTube resources as FIRST-CLASS POLICY TARGETS, not URL
 * strings. Every enforcement adapter (iOS NEFilterDataProvider, macOS Safari Web
 * Extension, this Windows extension, the NEURLFilter dataset builder) reduces an
 * observed URL to the same canonical object BEFORE consulting policy, so a parent
 * who approves `YOUTUBE_VIDEO:dQw4w9WgXcQ` approves the video no matter which URL
 * form the child's browser used.
 *
 * Approving a single video must NOT implicitly approve the channel,
 * recommendations, related videos, search, comments, Shorts, or arbitrary
 * navigation. That guarantee lives in the POLICY ENGINE (evaluation order), not
 * here; this module only answers "what canonical object does this URL denote?".
 */

/**
 * @typedef {("video"|"channel"|"playlist"|"watch_with_playlist"|"search"|"shorts"|"other")} YouTubeObjectKind
 */

/**
 * @typedef {Object} YouTubeObject
 * @property {YouTubeObjectKind} kind
 * @property {string} [videoId]      Canonical 11-char video id.
 * @property {string} [channelId]    Canonical channel id (UC…).
 * @property {string} [channelHandle] @handle or legacy user//c/ token.
 * @property {string} [playlistId]   Canonical playlist id (PL…, UU…, LL…, FL…, RD…).
 * @property {boolean} isYouTube     True when the host/path is a YouTube surface at all.
 * @property {string} [host]         The host we matched, normalized (no leading www.).
 */

/** Hosts that serve the YouTube application surface (watch pages, shorts, etc.). */
const YT_APP_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtubekids.com",
  "youtube-nocookie.com", // privacy-enhanced embeds
]);

/** Short-link host: the entire path is the video id. */
const YT_SHORT_HOSTS = new Set(["youtu.be"]);

/**
 * Resource hosts REQUIRED for an approved video to actually play. These are NOT
 * policy targets — they are documented here so the extension never blocks them
 * when a video is approved. A default-deny YouTube policy that also blocks these
 * will show an approved video that spins forever. See ARCHITECTURE.md §6.
 *
 * NOTE: googlevideo.com is the media CDN; its URLs are opaque, per-session, and
 * cannot be tied to a specific video id from the URL alone, so the adapter must
 * allow the whole host when ANY video is currently approved on the device, and
 * rely on the watch-page gate (which IS per-video) to control access. Deliberate,
 * documented limitation — kept identical to the shared TS.
 */
export const YOUTUBE_PLAYBACK_SUPPORT_HOSTS = [
  "www.youtube.com", // InnerTube /youtubei/v1/player API, base JS
  "youtubei.googleapis.com", // InnerTube API (mobile/native players)
  "i.ytimg.com", // thumbnails / storyboards
  "s.ytimg.com", // player javascript/css
  "yt3.ggpht.com", // avatars/thumbs
  "*.googlevideo.com", // MEDIA STREAMS (opaque; see note above)
  "jnn-pa.googleapis.com", // BotGuard/attestation used by the player
  "fonts.gstatic.com", // player glyphs
];

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID_RE = /^(?:PL|UU|LL|FL|RD|OL|EL)[A-Za-z0-9_-]{10,}$/;

function stripWww(host) {
  return host.replace(/^www\./i, "").toLowerCase();
}

function isValidVideoId(id) {
  return !!id && VIDEO_ID_RE.test(id);
}

/**
 * Reduce a URL to its canonical YouTube object. Returns `{ isYouTube:false }`
 * for non-YouTube URLs. Never throws.
 * @param {string} rawUrl
 * @returns {YouTubeObject}
 */
export function normalizeYouTube(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: "other", isYouTube: false };
  }

  const host = stripWww(u.hostname);
  const notYt = { kind: "other", isYouTube: false, host };

  // youtu.be/<id>
  if (YT_SHORT_HOSTS.has(host)) {
    const seg = u.pathname.split("/").filter(Boolean);
    const id = seg[0];
    if (isValidVideoId(id)) {
      const listId = u.searchParams.get("list") ?? undefined;
      return {
        kind: listId ? "watch_with_playlist" : "video",
        videoId: id,
        playlistId: listId && PLAYLIST_ID_RE.test(listId) ? listId : undefined,
        isYouTube: true,
        host,
      };
    }
    return { ...notYt, isYouTube: true };
  }

  if (!YT_APP_HOSTS.has(host)) return notYt;

  const path = u.pathname.replace(/\/+$/, ""); // trim trailing slashes
  const seg = path.split("/").filter(Boolean);
  const p0 = seg[0]?.toLowerCase();

  // /watch?v=<id>[&list=<pl>]
  if (p0 === "watch") {
    const id = u.searchParams.get("v");
    const listId = u.searchParams.get("list") ?? undefined;
    if (isValidVideoId(id)) {
      return {
        kind: listId ? "watch_with_playlist" : "video",
        videoId: id,
        playlistId: listId && PLAYLIST_ID_RE.test(listId) ? listId : undefined,
        isYouTube: true,
        host,
      };
    }
    return { ...notYt, isYouTube: true };
  }

  // /shorts/<id>
  if (p0 === "shorts" && isValidVideoId(seg[1])) {
    return { kind: "shorts", videoId: seg[1], isYouTube: true, host };
  }

  // /embed/<id>  and /v/<id>  (nocookie host lands here too)
  if ((p0 === "embed" || p0 === "v") && isValidVideoId(seg[1])) {
    return { kind: "video", videoId: seg[1], isYouTube: true, host };
  }
  // /embed/videoseries?list=<pl>
  if (p0 === "embed" && seg[1]?.toLowerCase() === "videoseries") {
    const listId = u.searchParams.get("list") ?? undefined;
    if (listId && PLAYLIST_ID_RE.test(listId))
      return { kind: "playlist", playlistId: listId, isYouTube: true, host };
  }

  // /live/<id>  (premieres / livestream permalinks)
  if (p0 === "live" && isValidVideoId(seg[1])) {
    return { kind: "video", videoId: seg[1], isYouTube: true, host };
  }

  // /playlist?list=<pl>
  if (p0 === "playlist") {
    const listId = u.searchParams.get("list") ?? undefined;
    if (listId && PLAYLIST_ID_RE.test(listId))
      return { kind: "playlist", playlistId: listId, isYouTube: true, host };
    return { ...notYt, isYouTube: true };
  }

  // /channel/<UC…>
  if (p0 === "channel" && seg[1] && CHANNEL_ID_RE.test(seg[1])) {
    return { kind: "channel", channelId: seg[1], isYouTube: true, host };
  }

  // /@handle  (modern channel handle)
  if (p0 && p0.startsWith("@")) {
    return { kind: "channel", channelHandle: seg[0], isYouTube: true, host };
  }

  // /user/<name>, /c/<name>  (legacy channel forms — resolve to channelId
  // server-side via the Data API; carried as a handle-like token meanwhile)
  if ((p0 === "user" || p0 === "c") && seg[1]) {
    return { kind: "channel", channelHandle: `${p0}/${seg[1]}`, isYouTube: true, host };
  }

  // /results?search_query=…
  if (p0 === "results") {
    return { kind: "search", isYouTube: true, host };
  }

  // Recognized YouTube surface we can't reduce to a specific object
  return { kind: "other", isYouTube: true, host };
}

/**
 * Stable policy key for a canonical object, e.g. "YOUTUBE_VIDEO:dQw4w9WgXcQ".
 * Kept identical to `youTubePolicyKey` in the shared TS.
 * @param {YouTubeObject} o
 * @returns {string|null}
 */
export function youTubePolicyKey(o) {
  if (o.videoId) return `YOUTUBE_VIDEO:${o.videoId}`;
  if (o.playlistId && o.kind === "playlist") return `YOUTUBE_PLAYLIST:${o.playlistId}`;
  if (o.channelId) return `YOUTUBE_CHANNEL:${o.channelId}`;
  if (o.channelHandle) return `YOUTUBE_CHANNEL_HANDLE:${o.channelHandle}`;
  return null;
}

/**
 * Returns true if `host` is (or is a subdomain of, for the wildcard entry) one of
 * the playback-support hosts. Used so the extension never blocks the resources an
 * approved video needs to stream.
 * @param {string} host
 * @returns {boolean}
 */
export function isPlaybackSupportHost(host) {
  const h = stripWww(host);
  for (const entry of YOUTUBE_PLAYBACK_SUPPORT_HOSTS) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (h === base || h.endsWith(`.${base}`)) return true;
    } else if (h === stripWww(entry)) {
      return true;
    }
  }
  return false;
}
