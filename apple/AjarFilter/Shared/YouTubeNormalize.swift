import Foundation

/// Swift mirror of `shared/youtube/youtube-normalize.ts`. The TypeScript file is
/// the authoritative spec; this must produce identical canonical objects so the
/// iOS content filter keys policy the same way as the backend and other adapters.
///
/// Approving one video must never widen to channel/recommendations/Shorts/search
/// — that guarantee is in the policy evaluation order, not here. This only maps a
/// URL to the canonical object it denotes.

public enum YouTubeKind: String {
    case video, channel, playlist, watchWithPlaylist, search, shorts, other
}

public struct YouTubeObject {
    public var kind: YouTubeKind
    public var videoId: String?
    public var channelId: String?
    public var channelHandle: String?
    public var playlistId: String?
    public var isYouTube: Bool
    public var host: String?
}

public enum YouTube {

    /// Hosts serving the YouTube application surface.
    static let appHosts: Set<String> = [
        "youtube.com", "m.youtube.com", "music.youtube.com",
        "gaming.youtube.com", "youtubekids.com", "youtube-nocookie.com",
    ]
    static let shortHosts: Set<String> = ["youtu.be"]

    /// Hosts required for an APPROVED video to actually play. Never block these
    /// while a video is approved. `*.googlevideo.com` is the opaque media CDN;
    /// allow the host while any video is approved and gate access at the watch
    /// page (which is per-video). See ARCHITECTURE.md §YouTube.
    public static let playbackSupportHosts: [String] = [
        "www.youtube.com", "youtubei.googleapis.com", "i.ytimg.com",
        "s.ytimg.com", "yt3.ggpht.com", "*.googlevideo.com",
        "jnn-pa.googleapis.com", "fonts.gstatic.com",
    ]

    /// Paths on `www.youtube.com` that are genuinely player plumbing.
    ///
    /// That host serves the InnerTube API *and* every watch page, search page
    /// and Short. Treating the whole host as playback support would mean that
    /// while ANY video is approved, every other video and all of YouTube search
    /// is allowed — the product's headline guarantee, silently void. The Windows
    /// extension carries this same list and the same warning.
    static let playerPathPrefixes: [String] = [
        "/youtubei/",       // InnerTube player API
        "/s/player/",       // base player JS/CSS
        "/api/timedtext",   // captions
        "/videoplayback",   // media (also served from googlevideo)
        "/generate_204", "/error_204",  // beacons
    ]

    /// Does this host serve playback plumbing? Handles the one wildcard entry.
    static func isPlaybackSupportHost(_ rawHost: String) -> Bool {
        let host = Host.normalize(rawHost)
        for entry in playbackSupportHosts {
            if entry.hasPrefix("*.") {
                let suffix = String(entry.dropFirst(2))
                if host == suffix || host.hasSuffix(".\(suffix)") { return true }
            } else if host == Host.normalize(entry) {
                return true
            }
        }
        return false
    }

    /// Is this request the PLUMBING an already-approved video needs, rather than
    /// a page?
    ///
    /// `pathIsKnown` is false for a socket flow, where the provider has a
    /// hostname and nothing else. On the page host that is decisive: without a
    /// path we cannot tell `/youtubei/v1/player` from `/watch?v=…`, so the host
    /// must NOT qualify — otherwise one approved video opens all of YouTube
    /// through the very carve-out meant to keep it shut. The other hosts serve
    /// only plumbing, so a hostname alone is enough for them.
    public static func isPlaybackSupport(host: String, path: String?, pathIsKnown: Bool) -> Bool {
        guard isPlaybackSupportHost(host) else { return false }
        let bare = Host.normalize(host)
        let isPageHost = bare == "youtube.com" || bare == "www.youtube.com"
        guard isPageHost else { return true }
        guard pathIsKnown, let path else { return false }
        return playerPathPrefixes.contains { path.hasPrefix($0) }
    }

    static func isVideoId(_ s: String?) -> Bool {
        guard let s else { return false }
        return s.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    }
    static func isChannelId(_ s: String) -> Bool {
        s.range(of: "^UC[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
    }
    static func isPlaylistId(_ s: String) -> Bool {
        s.range(of: "^(?:PL|UU|LL|FL|RD|OL|EL)[A-Za-z0-9_-]{10,}$", options: .regularExpression) != nil
    }
    /// The TS `stripWww` is `host.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase()`
    /// — it strips the trailing ROOT DOT as well. The previous Swift version did
    /// not, so `https://youtube.com./watch?v=…` was not recognized as YouTube at
    /// all and fell through to the web default. Delegates to `Host.normalize`,
    /// which is that exact expression.
    static func stripWww(_ host: String) -> String { Host.normalize(host) }

    public static func normalize(_ raw: String) -> YouTubeObject {
        guard let u = URLComponents(string: raw), let hostRaw = u.host else {
            return YouTubeObject(kind: .other, videoId: nil, channelId: nil,
                                 channelHandle: nil, playlistId: nil, isYouTube: false, host: nil)
        }
        let host = stripWww(hostRaw)
        func q(_ name: String) -> String? { u.queryItems?.first(where: { $0.name == name })?.value }
        let notYt = YouTubeObject(kind: .other, videoId: nil, channelId: nil,
                                  channelHandle: nil, playlistId: nil, isYouTube: false, host: host)

        // youtu.be/<id>
        if shortHosts.contains(host) {
            let seg = u.path.split(separator: "/").map(String.init)
            if let id = seg.first, isVideoId(id) {
                let list = q("list")
                return YouTubeObject(kind: list != nil ? .watchWithPlaylist : .video,
                                     videoId: id, channelId: nil, channelHandle: nil,
                                     playlistId: (list.map(isPlaylistId) == true) ? list : nil,
                                     isYouTube: true, host: host)
            }
            var o = notYt; o.isYouTube = true; return o
        }

        guard appHosts.contains(host) else { return notYt }

        let path = u.path.hasSuffix("/") ? String(u.path.dropLast()) : u.path
        let seg = path.split(separator: "/").map(String.init)
        let p0 = seg.first?.lowercased()

        switch p0 {
        case "watch":
            if let id = q("v"), isVideoId(id) {
                let list = q("list")
                return YouTubeObject(kind: list != nil ? .watchWithPlaylist : .video,
                                     videoId: id, channelId: nil, channelHandle: nil,
                                     playlistId: (list.map(isPlaylistId) == true) ? list : nil,
                                     isYouTube: true, host: host)
            }
        case "shorts" where isVideoId(seg[safe: 1]):
            return YouTubeObject(kind: .shorts, videoId: seg[1], channelId: nil, channelHandle: nil,
                                 playlistId: nil, isYouTube: true, host: host)
        case "embed", "v":
            if isVideoId(seg[safe: 1]) {
                return YouTubeObject(kind: .video, videoId: seg[1], channelId: nil, channelHandle: nil,
                                     playlistId: nil, isYouTube: true, host: host)
            }
            if p0 == "embed", seg[safe: 1]?.lowercased() == "videoseries", let list = q("list"), isPlaylistId(list) {
                return YouTubeObject(kind: .playlist, videoId: nil, channelId: nil, channelHandle: nil,
                                     playlistId: list, isYouTube: true, host: host)
            }
        case "live" where isVideoId(seg[safe: 1]):
            return YouTubeObject(kind: .video, videoId: seg[1], channelId: nil, channelHandle: nil,
                                 playlistId: nil, isYouTube: true, host: host)
        case "playlist":
            if let list = q("list"), isPlaylistId(list) {
                return YouTubeObject(kind: .playlist, videoId: nil, channelId: nil, channelHandle: nil,
                                     playlistId: list, isYouTube: true, host: host)
            }
        case "channel" where seg[safe: 1].map(isChannelId) == true:
            return YouTubeObject(kind: .channel, videoId: nil, channelId: seg[1], channelHandle: nil,
                                 playlistId: nil, isYouTube: true, host: host)
        case let p? where p.hasPrefix("@"):
            return YouTubeObject(kind: .channel, videoId: nil, channelId: nil, channelHandle: seg[0],
                                 playlistId: nil, isYouTube: true, host: host)
        case "user", "c":
            if let name = seg[safe: 1] {
                return YouTubeObject(kind: .channel, videoId: nil, channelId: nil,
                                     channelHandle: "\(p0!)/\(name)", playlistId: nil, isYouTube: true, host: host)
            }
        case "results":
            return YouTubeObject(kind: .search, videoId: nil, channelId: nil, channelHandle: nil,
                                 playlistId: nil, isYouTube: true, host: host)
        default:
            break
        }
        var o = notYt; o.isYouTube = true; return o
    }

    /// Stable policy key, e.g. "YOUTUBE_VIDEO:dQw4w9WgXcQ".
    public static func policyKey(_ o: YouTubeObject) -> String? {
        if let v = o.videoId { return "YOUTUBE_VIDEO:\(v)" }
        if let pl = o.playlistId, o.kind == .playlist { return "YOUTUBE_PLAYLIST:\(pl)" }
        if let c = o.channelId { return "YOUTUBE_CHANNEL:\(c)" }
        if let h = o.channelHandle { return "YOUTUBE_CHANNEL_HANDLE:\(h)" }
        return nil
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
