import Foundation
import FamilyControls
import NetworkExtension
import ManagedSettings

/// App-side controller for PoC A: request `.child` authorization, install/enable
/// the content filter, and drive the local test policy (default-deny YouTube +
/// allow one canonical video), including a short temporary approval (test A5).
///
/// This is a PoC harness, not production. It writes the policy snapshot into the
/// App Group; the extensions read it. In the real product the snapshot is
/// fetched signed from the backend.
@MainActor
final class FilterController: ObservableObject {

    @Published var authorizationStatus: AuthorizationStatus = .notDetermined
    @Published var filterEnabled = false
    @Published var lastError: String?

    private let store = PolicyStore.shared
    private let familyId = "poc-family"
    private let childId = "poc-child"
    private let deviceId = "poc-device"

    // Canonical ids used by the PoC (see docs/APPLE_CONTENT_FILTER_POC.md).
    static let allowedVideo = "dQw4w9WgXcQ"
    static let blockedVideo = "9bZkp7q19f0"

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

    /// Seed the local test policy: default-deny YouTube, allow one video.
    func seedDefaultDenyYouTube() {
        let scope = RuleScope(type: .child, familyId: familyId, childId: childId, deviceId: nil)
        let snap = DevicePolicySnapshot(
            version: 1, familyId: familyId, childId: childId, deviceId: deviceId,
            defaults: DefaultPolicy(webDefault: .allow, youTubeDefault: .block),
            rules: [
                PolicyRule(id: "allow-one", target: .ytVideo, value: Self.allowedVideo,
                           action: .allow, scope: scope, priority: 0)
            ],
            temporaryRules: [],
            issuedAt: Date(), signature: "UNSIGNED-POC")
        store.save(snap)
        reloadExtensionRules()
    }

    /// Test A4/A5: grant a short temporary approval for the otherwise-blocked
    /// video, with a server-style signed UTC expiry.
    func grantTemporary(videoId: String, seconds: TimeInterval) {
        guard var snap = store.current() else { return }
        let scope = RuleScope(type: .child, familyId: familyId, childId: childId, deviceId: nil)
        let now = Date()
        snap.temporaryRules.append(TemporaryRule(
            id: UUID().uuidString, target: .ytVideo, value: videoId, action: .allow,
            scope: scope, priority: 100, startsAt: now, expiresAt: now.addingTimeInterval(seconds),
            requestId: "poc-req", approvedBy: "poc-parent"))
        snap.version += 1
        store.save(snap)
        reloadExtensionRules()
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
