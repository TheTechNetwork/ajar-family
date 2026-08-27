/**
 * YouTube canonical-object normalization — the single source of truth.
 *
 * The product treats YouTube resources as FIRST-CLASS POLICY TARGETS, not URL
 * strings. Every platform enforcement adapter (iOS NEFilterDataProvider, macOS
 * Safari Web Extension, Windows browser extension, NEURLFilter dataset builder)
 * MUST reduce an observed URL to the same canonical object produced here before
 * consulting policy, so that a parent who approves `YOUTUBE_VIDEO:dQw4w9WgXcQ`
 * approves the video no matter which URL form the child's browser used.
 *
 * Approving a single video must NOT implicitly approve the channel,
 * recommendations, related videos, search, comments, Shorts, or arbitrary
 * navigation. That guarantee lives in the POLICY ENGINE (evaluation order), not
 * here; this module only answers "what canonical object does this URL denote?".
 *
 * This file is intentionally dependency-free so it can be transpiled and reused
 * (or ported) on every platform.
 */

export type YouTubeObjectKind =
  | "video"
  | "channel"
  | "playlist"
  | "watch_with_playlist" // a video viewed in a playlist context
  | "search"
  | "shorts" // shorts is a video; kind kept for policy that treats Shorts specially
  | "other"; // youtube surface we recognize but can't reduce to an id (home, trending…)

export interface YouTubeObject {
  kind: YouTubeObjectKind;
  /** Canonical 11-char video id, when the URL denotes a specific video. */
  videoId?: string;
  /** Canonical channel id (UC…), handle (@name), or legacy /user//c/ name. */
  channelId?: string;
  channelHandle?: string;
  /** Canonical playlist id (PL…, UU…, LL…, FL…, RD…). */
  playlistId?: string;
  /** True when the host/path is a YouTube surface at all. */
  isYouTube: boolean;
  /** The host we matched, normalized (no leading www.). */
  host?: string;
}

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
 * policy targets — they are documented here so adapters never block them when a
 * video is approved. A default-deny YouTube policy that also blocks these will
 * show an approved video that spins forever. See ARCHITECTURE.md §YouTube.
 *
 * NOTE: googlevideo.com is the media CDN; its URLs are opaque, per-session, and
 * cannot be tied to a specific video id from the URL alone, so an adapter must
 * allow the whole host when ANY video is currently approved on the device, and
 * rely on the watch-page gate (which IS per-video) to control access. This is a
 * deliberate, documented limitation.
 */
export const YOUTUBE_PLAYBACK_SUPPORT_HOSTS: readonly string[] = [
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

function stripWww(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

function isValidVideoId(id: string | null | undefined): id is string {
  return !!id && VIDEO_ID_RE.test(id);
}

/**
 * Reduce a URL to its canonical YouTube object. Returns `{ isYouTube:false }`
 * for non-YouTube URLs. Never throws.
 */
export function normalizeYouTube(rawUrl: string): YouTubeObject {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: "other", isYouTube: false };
  }

  const host = stripWww(u.hostname);
  const notYt: YouTubeObject = { kind: "other", isYouTube: false, host };

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
 * Adapters and the backend use this as the lookup key against policy rules.
 */
export function youTubePolicyKey(o: YouTubeObject): string | null {
  if (o.videoId) return `YOUTUBE_VIDEO:${o.videoId}`;
  if (o.playlistId && o.kind === "playlist") return `YOUTUBE_PLAYLIST:${o.playlistId}`;
  if (o.channelId) return `YOUTUBE_CHANNEL:${o.channelId}`;
  if (o.channelHandle) return `YOUTUBE_CHANNEL_HANDLE:${o.channelHandle}`;
  return null;
}
