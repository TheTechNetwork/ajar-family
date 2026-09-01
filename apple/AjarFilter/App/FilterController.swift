import Foundation
import os
import FamilyControls
import NetworkExtension
import ManagedSettings

/// App-side controller for Ajar Filter: request `.child` authorization,
/// install/enable the content filter, enrol against the backend, and track the
/// state of an access request. It backs both the product screens
/// (`ContentView`) and the PoC levers (`DebugHarnessView`).
///
/// The seeding helpers below are still a PoC harness. On the real path the
/// snapshot is fetched SIGNED from the backend and installed with
/// `PolicyStore.install(rawSnapshot:)`, which verifies the Ed25519 signature and
/// refuses anything that does not check out. The seeding helpers go through the
/// DEBUG-only unsigned path and do not exist in a release build.
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
    /// Returns whether authorization was actually granted, so a caller does not
    /// charge on into `enableFilter()` after a refusal — which failed a second
    /// time for an unrelated-looking reason and overwrote the first message with
    /// the less useful one.
    @discardableResult
    func requestChildAuthorization() async -> Bool {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .child)
            authorizationStatus = AuthorizationCenter.shared.authorizationStatus
            return authorizationStatus == .approved
        } catch {
            fail("This device would not let Ajar turn on. Ask a parent to try again.", error)
            return false
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
                // What the CHILD sees in Settings next to the filter. It said
                // "ParentFilter PoC" — the pre-rename name, and the word PoC on
                // a shipped device.
                mgr.localizedDescription = "Ajar"
            }
            mgr.isEnabled = true
            try await mgr.saveToPreferences()
            filterEnabled = mgr.isEnabled
        } catch {
            fail("Ajar could not start filtering. Try turning it on again.", error)
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

    /// What the child is shown after tapping "Ask to unlock" on the block page.
    /// A string status could not drive a screen; this can.
    enum RequestState: Equatable {
        case idle
        case sending
        case waiting(since: Date)
        case answered
        case failed(String)
    }
    @Published var requestState: RequestState = .idle
    /// A human label for the thing being asked about — never the raw URL, which
    /// reads as a system fault rather than a request (UX_PRINCIPLES §4).
    @Published var requestTarget: String = ""
    private static let uiLog = Logger(subsystem: "family.ajar.filter", category: "ui")

    /// Show a human sentence, log the machine detail.
    ///
    /// `lastError` and `backendStatus` are rendered by the PRODUCT screens, not
    /// only by the debug harness, and they carried raw diagnostics into a
    /// shipped build: "Enroll failed: The operation couldn\u{2019}t be completed.
    /// (AjarFilter.BackendError error 3.)" on the setup screen a child is
    /// looking at, and "Enrolled as dev_a1b2 (child chd_c3d4)" on success. That
    /// is what makes an app read as an unfinished internal tool. The detail is
    /// still wanted — it goes to the unified log, which is where someone
    /// debugging is actually looking.
    private func fail(_ message: String, _ underlying: Error? = nil) {
        if let underlying { Self.uiLog.error("\(message, privacy: .public): \(String(describing: underlying), privacy: .public)") }
        else { Self.uiLog.error("\(message, privacy: .public)") }
        lastError = message
    }

    /// The URL that label stands for, so the app can OFFER TO OPEN IT.
    ///
    /// It used to be computed, used for the label, and dropped. The child was
    /// then told "try example.com again" by a screen with no way to get there:
    /// the page is in Safari, the child is in this app, and nothing here could
    /// take them back. Shown to nobody — it is a destination, not copy.
    @Published var requestURL: URL?

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
    /// True while a redeem is in flight. The setup code is SINGLE USE, so a
    /// second tap on a slow network spends it: the first request succeeds, the
    /// second is refused, and the child is left looking at an error for a device
    /// that actually enrolled. The button reads this rather than relying on the
    /// child not tapping twice.
    @Published var enrolling = false

    func enroll(code: String, displayName: String) async {
        if enrolling { return }
        enrolling = true
        defer { enrolling = false }
        do {
            // Same normalisation both extension options pages already do
            // (`.toUpperCase().replace(/[^A-Z0-9]/g, "")`): the server matches the
            // code exactly, and a parent reading one aloud produces lowercase,
            // spaces and hyphens.
            let normalized = code.uppercased().filter { $0.isLetter || $0.isNumber }
            let device = try await backend.enroll(code: normalized, displayName: displayName)
            isEnrolled = true
            // Not the ids. A child reads this screen, and "dev_a1b2 (child
            // chd_c3d4)" tells them nothing and looks like a fault.
            _ = device
            backendStatus = "This device is set up."
            await syncPolicy()
        } catch {
            backendStatus = nil
            fail("That setup code did not work. Check it with a parent — codes are used once and they expire.", error)
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
            fail("Could not reach Ajar just now. It keeps using the rules it already has.", error)
        }
    }

    /// Long-poll for a parent's decision. This is the A4 fast path: the backend
    /// parks the request until something is decided, so an approval lands on the
    /// child's device in seconds without polling in a loop.
    /// Returns whether a new snapshot actually arrived. The caller needs this:
    /// a timeout and an approval are completely different things to tell a child,
    /// and this used to return Void so the call site could not tell them apart.
    @discardableResult
    func waitForPolicyChange() async -> Bool {
        do {
            let changed = try await backend.waitForPolicyChange()
            if changed {
                backendStatus = "Policy changed → v\(store.current()?.version ?? -1)."
                reloadExtensionRules()
            } else {
                backendStatus = "No change before the timeout."
            }
            return changed
        } catch {
            lastError = "Policy wait failed: \(error.localizedDescription)"
            return false
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
        // The best human label available WITHOUT fetching metadata, which a
        // content filter has no business doing: the host, or "a video on
        // YouTube" when the id is all we have. The designs mocked a real title
        // ("How Volcanoes Erupt"); nothing on the device knows it, and inventing
        // one would be worse than naming the site honestly.
        let host = URL(string: blocked)?.host?.replacingOccurrences(of: "www.", with: "")
        requestTarget = yt.videoId != nil ? "a video on YouTube" : (host ?? "this page")
        requestURL = URL(string: blocked)
        requestState = .sending
        do {
            try await backend.createRequest(targetType: targetType, targetValue: targetValue, url: blocked)
            backendStatus = "Request sent — waiting for a parent."
            requestState = .waiting(since: Date())
            // Park on the long poll so an approval applies without the child
            // having to reopen the app.
            // The long poll returns on ANY policy change, which is not the same
            // as "this request was approved" — a rule for a different child, or
            // a category update, wakes it too. The backend does not yet report
            // the decision back to the device, so claiming "You're in" here would
            // be a yes the parent may never have given. Until it does, say only
            // what is known: something changed, try the page again.
            //
            // And a TIMEOUT is not a change at all. This used to set .answered
            // unconditionally, so a request no parent ever saw showed the child a
            // green tick and "try it again" after 25 seconds — the one lie this
            // screen must not tell. Nothing happened, so stay waiting.
            if await waitForPolicyChange() {
                requestState = .answered
            }
        } catch {
            fail("That request did not send. Try again in a moment.", error)
            requestState = .failed("That request did not send. Try again in a moment.")
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
