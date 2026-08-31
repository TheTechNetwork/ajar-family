import Foundation
import FamilyControls
import NetworkExtension
import ManagedSettings

/// App-side controller for PoC A: request `.child` authorization, install/enable
/// the content filter, and drive the local test policy, including a short
/// temporary approval (test A5) and a CATEGORY rule (the general-filtering path).
///
/// This is a PoC harness, not production. In the real product the snapshot is
/// fetched SIGNED from the backend and installed with
/// `PolicyStore.install(rawSnapshot:)`, which verifies the Ed25519 signature and
/// refuses anything that does not check out. The local seeding helpers below go
/// through the DEBUG-only unsigned path and do not exist in a release build.
@MainActor
final class FilterController: ObservableObject {

    @Published var authorizationStatus: AuthorizationStatus = .notDetermined
    @Published var filterEnabled = false
    @Published var lastError: String?
    @Published var selfTestFailures: [PolicySelfTest.Failure] = []
    @Published var selfTestRan = false

    #if DEBUG
    /// Flows the data provider recorded, newest first — the A1/A2 evidence.
    /// See `Shared/FlowLog.swift` for why this is not read from the system log.
    @Published var flowRows: [String] = []
    func refreshFlowLog() { flowRows = FlowLog.all() }
    func clearFlowLog() { FlowLog.clear(); flowRows = [] }
    #endif

    private let store = PolicyStore.shared
    private let familyId = "poc-family"
    private let childId = "poc-child"
    private let deviceId = "poc-device"

    // Canonical ids used by the PoC (see docs/APPLE_CONTENT_FILTER_POC.md).
    static let allowedVideo = "dQw4w9WgXcQ"
    static let blockedVideo = "9bZkp7q19f0"

    init() {
        // The containing app is the only process the sandbox lets write
        // diagnostics back into the App Group.
        store.recordsDiagnostics = true
        store.purgeLegacy()
    }

    /// RUN THIS FIRST on a real Mac/device. Everything in `Shared/` was written
    /// without a compiler; these vectors are the acceptance gate for canonical
    /// JSON parity, Bloom parity, and Ed25519 verification. See `SelfTest.swift`.
    func runSelfTest() {
        selfTestFailures = PolicySelfTest.runAll()
        selfTestRan = true
        for f in selfTestFailures { print("SELF-TEST FAIL [\(f.name)] \(f.detail)") }
    }

    /// Request FamilyControls `.child` authorization. On an unsupervised device
    /// this unlocks the content filter (TN3134); a parent must approve on-device.
    func requestChildAuthorization() async {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .child)
            authorizationStatus = AuthorizationCenter.shared.authorizationStatus
        } catch {
            lastError = "Authorization failed: \(error.localizedDescription)"
        }
    }

    /// Configure and enable the NEFilter content filter (browser + socket flows).
    func enableFilter() async {
        let mgr = NEFilterManager.shared()
        do {
            try await mgr.loadFromPreferences()
            if mgr.providerConfiguration == nil {
                let cfg = NEFilterProviderConfiguration()
                cfg.filterBrowsers = true   // WebKit flow URLs (full URL) — the point
                cfg.filterSockets = true
                mgr.providerConfiguration = cfg
                mgr.localizedDescription = "ParentFilter PoC"
            }
            mgr.isEnabled = true
            try await mgr.saveToPreferences()
            filterEnabled = mgr.isEnabled
        } catch {
            lastError = "Enable filter failed: \(error.localizedDescription)"
        }
    }

    // MARK: - The production path

    /// Install a snapshot exactly as the backend delivered it. Fails CLOSED: a
    /// bad signature, a snapshot for another device, or a version rollback all
    /// leave the previously installed policy untouched.
    func installSignedSnapshot(_ raw: Data) {
        do {
            try store.install(rawSnapshot: raw, expectedDeviceId: deviceId)
            reloadExtensionRules()
        } catch {
            lastError = "Snapshot rejected: \(error)"
        }
    }

    /// Enroll the backend's Ed25519 public key (base64 SPKI DER from
    /// `GET /v1/signing-key`). WRITE-ONCE: a later, different key is refused, so
    /// an attacker cannot swap in their own signer. Prefer pinning the key at
    /// build time in `PolicyStore.pinnedSigningKeySPKIB64`.
    func enrollSigningKey(_ spkiB64: String) {
        if !store.enrollSigningKey(spkiB64) {
            lastError = "Signing key refused (already enrolled with a different key, or malformed)."
        }
    }

    /// Install the signed `GET /v1/categories/filters` body. Verified against the
    /// same key; a bad signature leaves the cached filters alone.
    func installCategoryFilters(_ responseBody: Data) {
        guard let key = store.trustedSigningKeyB64 else {
            lastError = "No trusted signing key; enroll one first."
            return
        }
        do {
            _ = try CategoryFilterStore.shared.install(responseBody: responseBody, publicKeyB64: key)
            reloadExtensionRules()
        } catch {
            lastError = "Category filter asset rejected: \(error)"
        }
    }

    var tamperDetected: Bool { store.tamperDetected }

    // MARK: - Local PoC seeding (DEBUG only, unsigned)

    #if DEBUG
    /// Seed the local test policy: default-deny YouTube, allow one video, and a
    /// CATEGORY BLOCK on "social" with an inline map — the rule type that was
    /// previously a no-op on this platform.
    func seedDefaultDenyYouTube() {
        PolicyStore.allowUnsignedDevelopmentSnapshots = true
        let scope = RuleScope(type: .child, familyId: familyId, childId: childId)
        let snap = DevicePolicySnapshot(
            version: 1, familyId: familyId, childId: childId, deviceId: deviceId,
            defaults: DefaultPolicy(webDefault: .allow, youTubeDefault: .block),
            rules: [
                PolicyRule(id: "allow-one", target: .ytVideo, value: Self.allowedVideo,
                           action: .allow, scope: scope, priority: 0),
                PolicyRule(id: "block-social", target: .category, value: "social",
                           action: .block, scope: scope, priority: 0),
            ],
            temporaryRules: [],
            categories: ["social": ["facebook.com", "instagram.com", "tiktok.com",
                                    "x.com", "reddit.com", "snapchat.com"]],
            issuedAt: Date(), signature: "UNSIGNED-POC")
        store.installUnsignedForDevelopment(snap)
        reloadExtensionRules()
    }

    /// Test A4/A5: grant a short temporary approval for the otherwise-blocked
    /// video, with a server-style UTC expiry.
    func grantTemporary(videoId: String, seconds: TimeInterval) {
        guard var snap = store.current() else { return }
        let scope = RuleScope(type: .child, familyId: familyId, childId: childId)
        let now = Date()
        snap.temporaryRules.append(TemporaryRule(
            id: UUID().uuidString, target: .ytVideo, value: videoId, action: .allow,
            scope: scope, priority: 100, startsAt: now, expiresAt: now.addingTimeInterval(seconds),
            requestId: "poc-req", approvedBy: "poc-parent", grantKind: .timed))
        snap.version += 1
        store.installUnsignedForDevelopment(snap)
        reloadExtensionRules()
    }
    #endif

    // MARK: - Backend (the real path, not the DEBUG seeding above)

    private let backend = BackendClient()

    @Published var isEnrolled = BackendClient().isEnrolled
    @Published var backendStatus: String?
    /// Set when a Request-Access deep link arrives, so the UI can show what was
    /// asked for rather than silently posting.
    @Published var lastRequest: String?

    var baseURLString: String { BackendClient.baseURL?.absoluteString ?? "" }
    var policyVersion: Int? { store.current()?.version }

    func setBaseURL(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        BackendClient.baseURL = trimmed.isEmpty ? nil : URL(string: trimmed)
        backendStatus = trimmed.isEmpty ? "Backend URL cleared." : "Backend URL set."
    }

    /// Redeem a parent-issued enrollment code. On success the device holds a
    /// token AND the backend's signing key, which is what lets it move off the
    /// DEBUG unsigned path onto verified snapshots.
    func enroll(code: String, displayName: String) async {
        do {
            let device = try await backend.enroll(
                code: code.trimmingCharacters(in: .whitespacesAndNewlines), displayName: displayName)
            isEnrolled = true
            backendStatus = "Enrolled as \(device.id) (child \(device.childId))."
            await syncPolicy()
        } catch {
            backendStatus = nil
            lastError = "Enroll failed: \(error.localizedDescription)"
        }
    }

    /// Pull and install the signed policy. This is the path that replaces the
    /// DEBUG seeding: `PolicyStore.install` verifies the Ed25519 signature and
    /// refuses anything that does not check out, so a snapshot that arrives
    /// here and installs is one the extensions will also trust.
    func syncPolicy() async {
        do {
            let changed = try await backend.syncPolicy()
            backendStatus = changed
                ? "Installed policy v\(store.current()?.version ?? -1)."
                : "Already up to date (v\(store.current()?.version ?? -1))."
            reloadExtensionRules()
        } catch {
            lastError = "Policy sync failed: \(error.localizedDescription)"
        }
    }

    /// Long-poll for a parent's decision. This is the A4 fast path: the backend
    /// parks the request until something is decided, so an approval lands on the
    /// child's device in seconds without polling in a loop.
    func waitForPolicyChange() async {
        do {
            let changed = try await backend.waitForPolicyChange()
            if changed {
                backendStatus = "Policy changed → v\(store.current()?.version ?? -1)."
                reloadExtensionRules()
            } else {
                backendStatus = "No change before the timeout."
            }
        } catch {
            lastError = "Policy wait failed: \(error.localizedDescription)"
        }
    }

    /// Handle `ajar://request?u=<blocked url>` from the block page.
    ///
    /// The canonical id is computed HERE rather than by the page, so the app's
    /// normalization stays the single definition of "this video": a request for
    /// `watch?v=X&t=90` and one for `youtu.be/X` must reach the parent as one
    /// item, not two.
    func handleIncoming(url: URL) async {
        guard url.scheme == "ajar", url.host == "request" else { return }
        guard let blocked = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "u" })?.value, !blocked.isEmpty else {
            lastError = "That link carried no address to request."
            return
        }

        let yt = YouTube.normalize(blocked)
        let targetType: String, targetValue: String
        if let videoId = yt.videoId {
            targetType = "YOUTUBE_VIDEO"; targetValue = videoId
        } else {
            // The exact URL, not the domain: approving a blocked page should not
            // silently open the whole site.
            targetType = "URL"; targetValue = blocked
        }

        lastRequest = "\(targetType) \(targetValue)"
        do {
            try await backend.createRequest(targetType: targetType, targetValue: targetValue, url: blocked)
            backendStatus = "Request sent — waiting for a parent."
            // Park on the long poll so an approval applies without the child
            // having to reopen the app.
            await waitForPolicyChange()
        } catch {
            lastError = "Request failed: \(error.localizedDescription)"
        }
    }

    func signOutDevice() {
        backend.signOut()
        isEnrolled = false
        backendStatus = "Device credentials cleared."
    }

    /// Ping the control provider so it calls notifyRulesChanged() (seconds-level
    /// propagation). Reloading the manager triggers the control provider start.
    private func reloadExtensionRules() {
        Task {
            let mgr = NEFilterManager.shared()
            try? await mgr.loadFromPreferences()
            // Toggling a benign save nudges the providers to re-read the snapshot;
            // the control provider's rulesDidChange()/notifyRulesChanged() is the
            // real fast path in production.
            try? await mgr.saveToPreferences()
        }
    }
}
