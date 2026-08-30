/**
 * youtube-normalize.js — JS port of `shared/youtube/youtube-normalize.ts`.
 *
 * The TypeScript file is the AUTHORITATIVE SPEC (ADR-007, ADR-008). This port
 * must produce identical canonical objects so the Safari extension keys policy
 * exactly the same way as the backend, the iOS Swift port, and the Windows
 * extension. Keep it in LOCKSTEP with the TS — treat any divergence as a bug.
 *
 * Approving one video must never widen to the channel / recommendations /
 * Shorts / search — that guarantee lives in the evaluation order (background.js
 * / policy-model.ts), not here. This only maps a URL to the object it denotes.
 *
 * Dependency-free ES module. Imported by background.js (a MV3 service worker
 * declared as type:"module" in manifest.json).
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
 * policy targets and must NEVER be blocked while a video is approved. In
 * particular `*.googlevideo.com` is the opaque, per-session media CDN — allow
 * the whole host while ANY video is currently approved on the device and rely
 * on the per-video watch-page gate. See ARCHITECTURE.md §6 and docs/MACOS_SAFARI_POC.md B7.
 *
 * Kept identical to YOUTUBE_PLAYBACK_SUPPORT_HOSTS in the TypeScript.
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
  return host.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
}

function isValidVideoId(id) {
  return !!id && VIDEO_ID_RE.test(id);
}

/**
 * Reduce a URL to its canonical YouTube object. Returns `{ isYouTube:false }`
 * for non-YouTube URLs. Never throws. Mirrors normalizeYouTube() in the TS.
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
 * Mirrors youTubePolicyKey() in the TS. Adapters and the backend use this as
 * the lookup key against policy rules.
 */
export function youTubePolicyKey(o) {
  if (o.videoId) return `YOUTUBE_VIDEO:${o.videoId}`;
  if (o.playlistId && o.kind === "playlist") return `YOUTUBE_PLAYLIST:${o.playlistId}`;
  if (o.channelId) return `YOUTUBE_CHANNEL:${o.channelId}`;
  if (o.channelHandle) return `YOUTUBE_CHANNEL_HANDLE:${o.channelHandle}`;
  return null;
}

/**
 * True if `host` is one of the playback-support hosts (supports a leading
 * "*." wildcard, matching the CDN entry `*.googlevideo.com`). Used by
 * background.js to keep an approved video's media/streaming reachable (B7).
 */
export function isPlaybackSupportHost(host) {
  if (!host) return false;
  const h = host.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
  return YOUTUBE_PLAYBACK_SUPPORT_HOSTS.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".googlevideo.com"
      return h === entry.slice(2) || h.endsWith(suffix);
    }
    return h === entry.replace(/\.$/, "").replace(/^www\./i, "");
  });
}
