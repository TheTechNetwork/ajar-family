import Foundation

/// App-Group-backed signed policy snapshot cache + the shared evaluator.
///
/// The containing app WRITES the snapshot; the sandboxed extensions READ it (they
/// cannot reach the network). The evaluator reproduces `evaluate()` in
/// `shared/policy/policy-model.ts` — including the safety floor above every tier,
/// temporary approvals, and CATEGORY rules over both the inline map and the
/// downloaded Bloom filters.
///
/// # Trust
///
/// Everything in the App Group is attacker-writable within the trust model the
/// audit assumes ("any process with App-Group access"). So the snapshot is stored
/// as the RAW signed bytes the backend delivered, and its Ed25519 signature is
/// verified on **every read** (memoized by SHA-256 of the bytes, so the hot path
/// pays one hash). Verification failure does not fall back to "no policy" —
/// that would itself be a bypass, since deleting the snapshot would then unblock
/// everything. Instead:
///
/// | state                                   | posture                                  |
/// |-----------------------------------------|------------------------------------------|
/// | verified snapshot                       | evaluate normally                        |
/// | present but unverifiable / rolled back  | BLOCK everything except the safety floor |
/// | absent AND device was provisioned       | BLOCK everything except the safety floor |
/// | absent AND never provisioned            | ALLOW (unenrolled device stays usable)   |
///
/// The tamper posture is deliberately harsh: it is recoverable by the app
/// re-fetching a valid snapshot, and `tamperDetected` lets the UI say so.
///
/// # Known limits (honest)
///
/// * The provisioning marker and the version high-water mark live in the same
///   App Group they defend, so an attacker who can write there can also clear
///   them and return the device to "never provisioned". Raising that bar means
///   moving both into the Keychain (or a server round-trip on launch); it is NOT
///   done here. On a non-jailbroken iOS device the App Group is reachable only by
///   this app and its own extensions, which is what makes this posture useful at
///   all.
/// * `nowUTC()` is still `Date()`. ADR-009's monotonic/last-known-server-time
///   clock is NOT implemented, so a clock rollback can still extend a temporary
///   grant. Unchanged by this pass; called out so nobody assumes otherwise.
///
/// NOT COMPILED OR RUN.
public final class PolicyStore {

    public static let defaultAppGroup = "group.family.ajar.filter"
    public static let shared = PolicyStore(appGroup: defaultAppGroup)

    /// Pin the backend's Ed25519 signing key (base64 SPKI DER from
    /// `GET /v1/signing-key`) at BUILD time when you can — a key that is merely
    /// fetched into the App Group can be replaced by whoever can replace the
    /// snapshot. Empty here because the PoC has no fixed backend; the enrolled
    /// key below is the fallback, and it is write-once.
    public static let pinnedSigningKeySPKIB64 = ""

    /// DEBUG-only escape hatch for the local PoC harness (`seedDefaultDenyYouTube`),
    /// which has no backend and therefore no signature. Must be set explicitly by
    /// the app; it does not exist in release builds.
    #if DEBUG
    public static var allowUnsignedDevelopmentSnapshots = false
    #endif

    public enum SnapshotState {
        case verified(DevicePolicySnapshot)
        case untrusted(reason: String)
        case absent
    }

    public enum InstallError: Swift.Error, CustomStringConvertible {
        case verification(Swift.Error)
        case undecodable(Swift.Error)
        case rollback(offered: Int, highWater: Int)
        case wrongDevice(offered: String, expected: String)

        public var description: String {
            switch self {
            case let .verification(e): return "signature verification failed: \(e)"
            case let .undecodable(e): return "snapshot did not decode: \(e)"
            case let .rollback(o, h): return "snapshot version \(o) is older than the installed \(h) (replay)"
            case let .wrongDevice(o, e): return "snapshot is for device \(o), this device is \(e)"
            }
        }
    }

    private let defaults: UserDefaults?
    private let snapshotKey = "device_policy_snapshot_raw_v2"   // raw signed bytes
    private let legacyKey = "device_policy_snapshot_v1"         // pre-verification blob
    private let enrolledKeyKey = "policy_signing_key_spki_b64"
    private let highWaterKey = "policy_version_high_water"
    private let provisionedKey = "policy_device_provisioned"
    private let tamperKey = "policy_tamper_detected"
    #if DEBUG
    private let devUnsignedKey = "policy_dev_unsigned"
    #endif

    /// Where the category Bloom filters come from. Injectable so the self-test
    /// can run against a throwaway store.
    public lazy var categoryFilters: CategoryFilterStore = CategoryFilterStore.shared

    /// Only the containing app should write diagnostics back into the App Group:
    /// the NEFilterDataProvider sandbox forbids disk writes, so the extensions
    /// read-only. The app sets this to true at launch.
    public var recordsDiagnostics = false

    private let lock = NSLock()
    private var memoDigest: Data?
    private var memoState: SnapshotState?

    public init(appGroup: String) {
        self.defaults = UserDefaults(suiteName: appGroup)
        // A snapshot written by the pre-verification build was never
        // signature-checked, so it is not trusted bytes. It is simply never read
        // (the key changed); the containing app clears it via `purgeLegacy()`.
    }

    /// App-only: drop the pre-verification cache written by older builds.
    public func purgeLegacy() { defaults?.removeObject(forKey: legacyKey) }

    // MARK: - Trusted key

    /// The key snapshots are verified against: the build-time pin if present,
    /// else the enrolled key. Enrollment is WRITE-ONCE — a second, different key
    /// is rejected, so a later attacker cannot swap in their own signer without
    /// also clearing the App Group (which trips the provisioned/tamper path).
    public var trustedSigningKeyB64: String? {
        if !Self.pinnedSigningKeySPKIB64.isEmpty { return Self.pinnedSigningKeySPKIB64 }
        let k = defaults?.string(forKey: enrolledKeyKey)
        return (k?.isEmpty == false) ? k : nil
    }

    @discardableResult
    public func enrollSigningKey(_ spkiB64: String) -> Bool {
        // With a build-time pin, enrollment is a no-op that merely confirms the
        // backend is offering the key we already trust.
        if !Self.pinnedSigningKeySPKIB64.isEmpty { return spkiB64 == Self.pinnedSigningKeySPKIB64 }
        guard (try? SnapshotVerifier.publicKey(fromBase64: spkiB64)) != nil else { return false }
        if let existing = defaults?.string(forKey: enrolledKeyKey), !existing.isEmpty {
            return existing == spkiB64   // write-once
        }
        defaults?.set(spkiB64, forKey: enrolledKeyKey)
        return true
    }

    // MARK: - Install / read

    /// Install a snapshot exactly as the backend delivered it. Fails CLOSED:
    /// nothing is written unless the signature verifies, the payload decodes, the
    /// snapshot is for this device, and its version is not a rollback.
    public func install(rawSnapshot: Data, expectedDeviceId: String? = nil) throws {
        guard let key = trustedSigningKeyB64 else {
            throw InstallError.verification(SnapshotVerifier.VerifyError.noTrustedKey)
        }
        do { try SnapshotVerifier.verifySnapshot(rawSnapshot: rawSnapshot, publicKeyB64: key) }
        catch { throw InstallError.verification(error) }

        let snap: DevicePolicySnapshot
        do { snap = try Self.decoder().decode(DevicePolicySnapshot.self, from: rawSnapshot) }
        catch { throw InstallError.undecodable(error) }

        if let expectedDeviceId, snap.deviceId != expectedDeviceId {
            throw InstallError.wrongDevice(offered: snap.deviceId, expected: expectedDeviceId)
        }
        // Anti-replay: a validly-signed OLD snapshot must not be able to restore
        // an expired grant or undo a new block.
        let highWater = defaults?.integer(forKey: highWaterKey) ?? 0
        if snap.version < highWater { throw InstallError.rollback(offered: snap.version, highWater: highWater) }

        lock.lock()
        defaults?.set(rawSnapshot, forKey: snapshotKey)
        defaults?.set(max(highWater, snap.version), forKey: highWaterKey)
        defaults?.set(true, forKey: provisionedKey)
        defaults?.set(false, forKey: tamperKey)
        #if DEBUG
        defaults?.set(false, forKey: devUnsignedKey)
        #endif
        memoDigest = nil; memoState = nil
        lock.unlock()
    }

    #if DEBUG
    /// DEBUG-only: seed an unsigned snapshot for the on-device PoC harness.
    public func installUnsignedForDevelopment(_ snapshot: DevicePolicySnapshot) {
        guard let data = try? Self.encoder().encode(snapshot) else { return }
        lock.lock()
        defaults?.set(data, forKey: snapshotKey)
        defaults?.set(true, forKey: devUnsignedKey)
        defaults?.set(true, forKey: provisionedKey)
        defaults?.set(false, forKey: tamperKey)
        memoDigest = nil; memoState = nil
        lock.unlock()
    }
    #endif

    /// True once a snapshot has ever been installed on this device.
    public var isProvisioned: Bool { defaults?.bool(forKey: provisionedKey) ?? false }

    /// Set when a stored snapshot failed to verify — the app should surface
    /// "policy could not be verified, reconnect" and re-fetch.
    public var tamperDetected: Bool { defaults?.bool(forKey: tamperKey) ?? false }

    /// The verified snapshot, or why there isn't one.
    public func state() -> SnapshotState {
        guard let raw = defaults?.data(forKey: snapshotKey) else {
            return isProvisioned ? .untrusted(reason: "snapshot missing after provisioning") : .absent
        }
        let digest = Digest.sha256(raw)
        lock.lock()
        if memoDigest == digest, let s = memoState { lock.unlock(); return s }
        lock.unlock()

        let computed = evaluateState(raw: raw)
        lock.lock(); memoDigest = digest; memoState = computed; lock.unlock()
        if case .untrusted = computed, recordsDiagnostics { defaults?.set(true, forKey: tamperKey) }
        return computed
    }

    private func evaluateState(raw: Data) -> SnapshotState {
        #if DEBUG
        if Self.allowUnsignedDevelopmentSnapshots, defaults?.bool(forKey: devUnsignedKey) == true {
            if let s = try? Self.decoder().decode(DevicePolicySnapshot.self, from: raw) {
                return .verified(s)
            }
            return .untrusted(reason: "development snapshot did not decode")
        }
        #endif
        guard let key = trustedSigningKeyB64 else { return .untrusted(reason: "no trusted signing key") }
        do { try SnapshotVerifier.verifySnapshot(rawSnapshot: raw, publicKeyB64: key) }
        catch { return .untrusted(reason: String(describing: error)) }
        guard let snap = try? Self.decoder().decode(DevicePolicySnapshot.self, from: raw) else {
            return .untrusted(reason: "verified bytes did not decode")
        }
        let highWater = defaults?.integer(forKey: highWaterKey) ?? 0
        if snap.version < highWater {
            return .untrusted(reason: "version \(snap.version) rolled back below \(highWater)")
        }
        return .verified(snap)
    }

    /// Convenience for callers that only want the policy when it is trustworthy.
    public func current() -> DevicePolicySnapshot? {
        if case let .verified(s) = state() { return s }
        return nil
    }

    // MARK: - Trusted clock (ADR-009 — NOT yet hardened, see the type doc)

    public func nowUTC() -> Date { Date() }

    // MARK: - Evaluation (mirror of shared/policy evaluate())

    /// `resolvedHosts` are the canonical names the request host CNAMEs to,
    /// supplied by the network layer. DOMAIN and CATEGORY rules — and the safety
    /// floor — are evaluated against the request host AND every resolved name, so
    /// CNAME cloaking cannot bypass a block (or hide a crisis line).
    /// Is a YouTube video approved on this device RIGHT NOW?
    ///
    /// The gate for the playback chain. `*.googlevideo.com` and the other
    /// support hosts serve an approved video's bytes, and their URLs are opaque
    /// — nothing in them says which video — so the chain can only ever be tied
    /// to the GRANT, not to the video. Which is still infinitely better than
    /// what it was tied to before: nothing at all. Those hosts are not YouTube
    /// hosts, so they fell through to `webDefault: ALLOW` and were reachable
    /// permanently, approved video or not.
    ///
    /// Standing ALLOW rules count as well as live grants: a parent who said
    /// "for good" to a video has approved it, and the chain has to serve it.
    public func hasActiveVideoGrant(now: Date = Date()) -> Bool {
        guard let snap = current() else { return false }
        let live = snap.temporaryRules.contains {
            $0.action == .allow && $0.target == .ytVideo
                && now >= $0.startsAt && now < $0.expiresAt
        }
        if live { return true }
        return snap.rules.contains { $0.action == .allow && $0.target == .ytVideo }
    }

    public func evaluate(_ urlString: String, appId: String? = nil, resolvedHosts: [String] = []) -> EvalResult {
        let yt = YouTube.normalize(urlString)
        let requestHost = URLComponents(string: urlString)?.host ?? ""

        // Request host + CNAME chain, normalized, de-duplicated, order preserved
        // (the TS uses `new Set([...])`, which is insertion-ordered).
        var hosts: [String] = []
        var seen = Set<String>()
        for h in ([requestHost] + resolvedHosts).map(Host.normalize) where !h.isEmpty {
            if seen.insert(h).inserted { hosts.append(h) }
        }

        // ── Tier 0: the SAFETY FLOOR. Above device rules, above temporary blocks,
        // above default-deny, above the "policy is untrusted" posture below — a
        // child must never have to ask a parent for a crisis line, and must never
        // be locked out of one by a tampered cache either.
        for h in hosts where SafetyFloor.matches(h) {
            return EvalResult(action: .allow, reason: "safety-floor", matchedKey: "SAFETY:\(h)")
        }

        let snap: DevicePolicySnapshot
        switch state() {
        case let .verified(s):
            snap = s
        case let .untrusted(reason):
            // FAIL CLOSED. Falling back to "no policy → allow" would make deleting
            // or corrupting the snapshot a complete bypass.
            return EvalResult(action: .block, reason: "snapshot-untrusted:\(reason)")
        case .absent:
            // Never provisioned: an unenrolled device stays usable.
            return EvalResult(action: .allow, reason: "no-snapshot")
        }

        let now = nowUTC()

        // Categories for the host chain: the snapshot's inline map UNION the
        // device's cached Bloom filters, exactly as the TS evaluator does.
        let filters = categoryFilters.current(publicKeyB64: trustedSigningKeyB64)
        var hostCats = Set<String>()
        for h in hosts {
            hostCats.formUnion(Host.categories(in: snap.categories, for: h))
            if let filters { hostCats.formUnion(filters.categories(for: h)) }
        }

        func matches(target: PolicyTargetType, value: String) -> String? {
            switch target {
            case .url:
                return URLNormalize.normalizeExact(urlString) == URLNormalize.normalizeExact(value)
                    ? "URL:\(value)" : nil
            case .urlPattern:
                return URLNormalize.matchesPattern(url: urlString, pattern: value)
                    ? "URL_PATTERN:\(value)" : nil
            case .ytVideo:
                return (yt.videoId != nil && yt.videoId == value) ? "YOUTUBE_VIDEO:\(value)" : nil
            case .ytPlaylist:
                // Mirrors the TS exactly: `yt.playlistId && yt.playlistId === r.value`.
                // No `kind == .playlist` guard — a video watched IN a playlist
                // (kind == .watchWithPlaylist) still matches a playlist rule, it
                // is just reached after the YOUTUBE_VIDEO tier.
                return (yt.playlistId != nil && yt.playlistId == value) ? "YOUTUBE_PLAYLIST:\(value)" : nil
            case .ytChannel:
                return (yt.channelId == value || yt.channelHandle == value) ? "YOUTUBE_CHANNEL:\(value)" : nil
            case .domain:
                let v = Host.normalize(value)
                return hosts.contains(where: { $0 == v || $0.hasSuffix(".\(v)") }) ? "DOMAIN:\(value)" : nil
            case .application:
                return (appId != nil && appId == value) ? "APPLICATION:\(value)" : nil
            case .category:
                // Precomputed over the host + its CNAME chain, from the inline map
                // and the Bloom filters. THIS is what "block all social media" is.
                return hostCats.contains(value) ? "CATEGORY:\(value)" : nil
            }
        }

        func scopeOK(_ s: RuleScope) -> Bool {
            if let d = s.deviceId, d != snap.deviceId { return false }
            if let c = s.childId, c != snap.childId { return false }
            return true
        }
        func specificity(_ s: RuleScope) -> Int { s.deviceId != nil ? 3 : (s.childId != nil ? 2 : 1) }
        func ordered<T>(_ items: [T], _ scope: (T) -> RuleScope, _ priority: (T) -> Int?) -> [T] {
            items.enumerated().sorted { a, b in
                let pa = priority(a.element) ?? 0, pb = priority(b.element) ?? 0
                if pa != pb { return pa > pb }
                let sa = specificity(scope(a.element)), sb = specificity(scope(b.element))
                if sa != sb { return sa > sb }
                return a.offset < b.offset   // stable, like Array.prototype.sort
            }.map { $0.element }
        }

        // ── Tier 3: active temporary approvals, before standing rules.
        let activeTemps = snap.temporaryRules.filter {
            scopeOK($0.scope) && now >= $0.startsAt && now < $0.expiresAt
        }
        for t in ordered(activeTemps, { $0.scope }, { $0.priority }) {
            if let k = matches(target: t.target, value: t.value) {
                return EvalResult(action: t.action,
                                  reason: "temporary:\((t.grantKind ?? .timed).rawValue)",
                                  matchedRuleId: t.id, matchedKey: k)
            }
        }

        // ── Tiers 4–8: standing rules, by target tier then priority/scope.
        let tierOrder: [PolicyTargetType] = [
            .url, .ytVideo, .ytPlaylist, .ytChannel, .urlPattern, .domain, .application, .category,
        ]
        let applicable = snap.rules.filter { scopeOK($0.scope) }
        for tier in tierOrder {
            for r in ordered(applicable.filter { $0.target == tier }, { $0.scope }, { $0.priority }) {
                if let k = matches(target: r.target, value: r.value) {
                    return EvalResult(action: r.action, reason: "rule:\(tier.rawValue)",
                                      matchedRuleId: r.id, matchedKey: k)
                }
            }
        }

        // ── Tier 9: defaults. YouTube carries its own, so a family can run
        // default-deny YouTube while the rest of the web is default-allow.
        if yt.isYouTube { return EvalResult(action: snap.defaults.youTubeDefault, reason: "default:youtube") }
        return EvalResult(action: snap.defaults.webDefault, reason: "default:web")
    }

    // MARK: - Coders

    static func decoder() -> JSONDecoder {
        let d = JSONDecoder(); d.dateDecodingStrategy = PolicyDates.decoding; return d
    }
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder(); e.dateEncodingStrategy = PolicyDates.encoding; return e
    }
}
