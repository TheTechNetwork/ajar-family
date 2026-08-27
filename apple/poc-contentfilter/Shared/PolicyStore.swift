import Foundation

/// App-Group-backed signed policy snapshot cache + the shared evaluator. The
/// containing app WRITES the snapshot (after verifying the backend signature);
/// the sandboxed extensions READ it (they cannot reach the network). The
/// evaluator reproduces the ordering in `shared/policy/policy-model.ts`.
///
/// Temporary approvals are enforced against the server-signed UTC `expiresAt`
/// using a monotonic clock delta so a device clock/timezone change can't extend a
/// grant (ADR-009). `nowUTC()` below is the hook where that hardening lives.
public final class PolicyStore {

    public static let shared = PolicyStore(appGroup: "group.com.example.parentfilterpoc")

    private let defaults: UserDefaults?
    private let key = "device_policy_snapshot_v1"

    public init(appGroup: String) {
        self.defaults = UserDefaults(suiteName: appGroup)
    }

    // MARK: snapshot load/save

    public func save(_ snapshot: DevicePolicySnapshot) {
        guard let data = try? JSONEncoder.iso().encode(snapshot) else { return }
        defaults?.set(data, forKey: key)
    }

    public func current() -> DevicePolicySnapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        // NOTE: production must verify `signature` (Ed25519) here and FAIL CLOSED
        // on mismatch. The PoC records this as a TODO to keep the harness runnable
        // before the backend keypair exists.
        return try? JSONDecoder.iso().decode(DevicePolicySnapshot.self, from: data)
    }

    // MARK: trusted clock (ADR-009)

    /// Returns a best-effort trusted "now". PoC uses Date(); production derives
    /// last-known-server-time + monotonic delta and flags rollback.
    public func nowUTC() -> Date { Date() }

    // MARK: evaluation (mirror of shared/policy evaluate())

    public func evaluate(_ urlString: String, appId: String? = nil) -> EvalResult {
        guard let snap = current() else {
            // No policy yet: fail OPEN for ordinary web (usable device), but the
            // product default for a provisioned device is the snapshot's defaults.
            return EvalResult(action: .allow, reason: "no-snapshot", matchedKey: nil)
        }

        let yt = YouTube.normalize(urlString)
        let host = URLComponents(string: urlString)?.host.map(YouTube.stripWww)
        let now = nowUTC()

        func matches(target: PolicyTargetType, value: String) -> String? {
            switch target {
            case .url:
                return normalizeExact(urlString) == normalizeExact(value) ? "URL:\(value)" : nil
            case .urlPattern:
                if value.hasSuffix("*") { return urlString.hasPrefix(String(value.dropLast())) ? "URL_PATTERN:\(value)" : nil }
                return normalizeExact(urlString) == normalizeExact(value) ? "URL_PATTERN:\(value)" : nil
            case .ytVideo:   return (yt.videoId == value) ? "YOUTUBE_VIDEO:\(value)" : nil
            case .ytPlaylist:return (yt.playlistId == value && yt.kind == .playlist) ? "YOUTUBE_PLAYLIST:\(value)" : nil
            case .ytChannel: return (yt.channelId == value || yt.channelHandle == value) ? "YOUTUBE_CHANNEL:\(value)" : nil
            case .domain:    return (host == value || (host?.hasSuffix(".\(value)") ?? false)) ? "DOMAIN:\(value)" : nil
            case .application: return (appId == value) ? "APPLICATION:\(value)" : nil
            case .category:  return nil   // injected out-of-band by the category service
            }
        }
        func scopeOK(_ s: RuleScope) -> Bool {
            if let d = s.deviceId, d != snap.deviceId { return false }
            if let c = s.childId, c != snap.childId { return false }
            return true
        }
        func specificity(_ s: RuleScope) -> Int { s.deviceId != nil ? 3 : (s.childId != nil ? 2 : 1) }

        // Tier 3: active temporary approvals first.
        let temps = snap.temporaryRules
            .filter { scopeOK($0.scope) && now >= $0.startsAt && now < $0.expiresAt }
            .sorted { ($0.priority ?? 0, specificity($0.scope)) > ($1.priority ?? 0, specificity($1.scope)) }
        for t in temps {
            if let k = matches(target: t.target, value: t.value) {
                return EvalResult(action: t.action, reason: "temporary", matchedKey: k)
            }
        }

        // Standing rules by tier.
        let order: [PolicyTargetType] = [.url, .ytVideo, .ytPlaylist, .ytChannel, .urlPattern, .domain, .application, .category]
        for tier in order {
            let inTier = snap.rules.filter { $0.target == tier && scopeOK($0.scope) }
                .sorted { ($0.priority ?? 0, specificity($0.scope)) > ($1.priority ?? 0, specificity($1.scope)) }
            for r in inTier {
                if let k = matches(target: r.target, value: r.value) {
                    return EvalResult(action: r.action, reason: "rule:\(tier.rawValue)", matchedKey: k)
                }
            }
        }

        if yt.isYouTube { return EvalResult(action: snap.defaults.youTubeDefault, reason: "default:youtube", matchedKey: nil) }
        return EvalResult(action: snap.defaults.webDefault, reason: "default:web", matchedKey: nil)
    }

    private func normalizeExact(_ raw: String) -> String {
        guard var c = URLComponents(string: raw) else { return raw }
        c.host = c.host.map(YouTube.stripWww)
        c.fragment = nil
        c.queryItems = c.queryItems?.sorted { $0.name < $1.name }
        var s = c.string ?? raw
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

private extension JSONEncoder { static func iso() -> JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e } }
private extension JSONDecoder { static func iso() -> JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d } }
