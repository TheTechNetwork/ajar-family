import Foundation
import NetworkExtension

/// App-side controller for PoC D. Drives `NEURLFilterManager` (the app-side
/// control singleton for the NEURLFilter Bloom+PIR blocklist), and provides a
/// participation-API probe (`NEURLFilter.verdict(for:)`) so the human tester can
/// check a URL's verdict from the harness itself.
///
/// NEURLFilter is BLOCKLIST-ONLY and is NOT the per-video-approval engine
/// (that is PoC A). See docs/APPLE_URL_FILTER_POC.md and ARCHITECTURE.md §3.1.
///
/// This environment (Linux, no Xcode/Apple SDK, no iOS 26 device) cannot compile
/// or run this. Open in Xcode 26; run on iOS/iPadOS 26 hardware.
@MainActor
final class URLFilterController: ObservableObject {

    @Published var isEnabled = false
    @Published var statusText = "unknown"
    @Published var lastVerdict = "—"
    @Published var lastError: String?

    // --- Configuration constants for the PoC (edit to match your setup) ------

    /// Bundle id of the app extension that implements `NEURLFilterControlProvider`.
    /// Must match the extension target's bundle id.
    private let controlProviderBundleID = "com.example.URLFilterPoC.URLFilterControlProviderExtension"

    /// Your vendor-hosted PIR server (OHTTP gateway front). For DEVELOPMENT-signed
    /// builds the OHTTP relay is skipped, so a directly reachable dev endpoint is
    /// fine (ARCHITECTURE.md §3.1: "development-signed builds skip the relay").
    private let pirServerURL = URL(string: "https://pir.parentfilter.example")!

    /// Privacy Pass issuer used to mint tokens for PIR requests (Apple
    /// pir-service-example). Dev endpoint for the PoC.
    private let pirPrivacyPassIssuerURL = URL(string: "https://issuer.parentfilter.example")!

    /// A pre-provisioned Privacy Pass / authentication token for the dev PIR
    /// server. In production this is obtained through the Privacy Pass flow.
    private let pirAuthenticationToken = "DEV-POC-TOKEN"

    // -------------------------------------------------------------------------

    /// Configure the NEURLFilter manager with the PIR server + control provider,
    /// set fail-closed, enable it, and persist. Mirrors ARCHITECTURE.md §3.1.
    func configureAndEnable() async {
        let mgr = NEURLFilterManager.shared
        do {
            try await mgr.loadFromPreferences()

            // Point the manager at our PIR stack and the bundled control provider
            // that supplies the Bloom prefilter.
            mgr.setConfiguration(
                pirServerURL: pirServerURL,
                pirPrivacyPassIssuerURL: pirPrivacyPassIssuerURL,
                pirAuthenticationToken: pirAuthenticationToken,
                controlProviderBundleIdentifier: controlProviderBundleID
            )

            // Parental-control posture: fail CLOSED so a Bloom-hit cache-miss that
            // cannot reach the PIR server denies rather than allows. Default is
            // false (fail-open). (ARCHITECTURE.md §3.1, DECISIONS ADR-002.)
            mgr.shouldFailClosed = true

            // Bloom prefilter refresh cadence. Default 86400s; floor 2700s (45min).
            // There is NO push/force-reload for the prefilter — this is the ≥45min
            // propagation floor the PoC measures. // TODO(verify on device): exact
            // property name/behavior of prefilterFetchInterval.
            mgr.prefilterFetchInterval = 2700

            mgr.isEnabled = true
            try await mgr.saveToPreferences()

            isEnabled = mgr.isEnabled
            statusText = mgr.isEnabled ? "enabled" : "disabled"
        } catch {
            lastError = "configure/enable failed: \(error.localizedDescription)"
        }
    }

    /// Refresh status from the manager.
    func refreshStatus() async {
        let mgr = NEURLFilterManager.shared
        do {
            try await mgr.loadFromPreferences()
            isEnabled = mgr.isEnabled
            statusText = mgr.isEnabled ? "enabled" : "disabled"
        } catch {
            lastError = "load failed: \(error.localizedDescription)"
        }
    }

    /// Disable the filter (teardown between experiments).
    func disableFilter() async {
        let mgr = NEURLFilterManager.shared
        do {
            try await mgr.loadFromPreferences()
            mgr.isEnabled = false
            try await mgr.saveToPreferences()
            isEnabled = mgr.isEnabled
            statusText = "disabled"
        } catch {
            lastError = "disable failed: \(error.localizedDescription)"
        }
    }

    /// Test a URL through the NEURLFilter participation API. WebKit/URLSession
    /// traffic is filtered automatically; `verdict(for:)` is the explicit probe an
    /// app can call (the same entry point a non-WebKit browser would have to call
    /// voluntarily — see "Key unresolved" re Chromium/Firefox participation).
    func testVerdict(for urlString: String) async {
        guard let url = URL(string: urlString) else {
            lastVerdict = "invalid URL"
            return
        }
        // NEURLFilter.verdict(for:) is async and returns .allow / .deny / .unknown.
        let verdict = await NEURLFilter.verdict(for: url)
        switch verdict {
        case .allow:   lastVerdict = "allow"
        case .deny:    lastVerdict = "deny (blocklisted)"
        case .unknown: lastVerdict = "unknown"
        @unknown default:
            lastVerdict = "unhandled verdict" // TODO(verify on device): case set
        }
    }

    /// Drop the cached PIR verdicts so the next Bloom-hit re-queries the server.
    /// This is the FASTER-than-Bloom path (the app must run to call it; there is
    /// no server→device trigger). Pairs with refreshPIRParameters().
    func resetPIRCache() {
        NEURLFilterManager.shared.resetPIRCache()
        // refreshPIRParameters() re-fetches PIR crypto params after a server-side
        // database/param change.
        NEURLFilterManager.shared.refreshPIRParameters()
    }
}
