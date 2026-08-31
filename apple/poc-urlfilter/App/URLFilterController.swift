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
/// Verified to COMPILE against the Xcode 27 iPhoneOS SDK (deployment target
/// iOS 26.0). Running it still needs iOS/iPadOS 26 hardware. SDK corrections
/// applied vs. the original scaffold are recorded in ADR-013.
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
            // SDK: setConfiguration(...) is `throws` (ADR-013).
            try mgr.setConfiguration(
                pirServerURL: pirServerURL,
                pirPrivacyPassIssuerURL: pirPrivacyPassIssuerURL,
                pirAuthenticationToken: pirAuthenticationToken,
                controlProviderBundleIdentifier: controlProviderBundleID
            )

            // Parental-control posture: fail CLOSED so a Bloom-hit cache-miss that
            // cannot reach the PIR server denies rather than allows. Default is
            // false (fail-open). (ARCHITECTURE.md §3.1, DECISIONS ADR-002.)
            mgr.shouldFailClosed = true

            // Bloom prefilter refresh cadence. There is NO push/force-reload for
            // the prefilter — this is the ≥45min propagation floor the PoC
            // measures. The property name is confirmed present in the SDK
            // (`var prefilterFetchInterval: TimeInterval`); the DEFAULT and the
            // enforced FLOOR are still unverified — measure on device.
            mgr.prefilterFetchInterval = 2700

            // How the system reduces an observed URL to the dataset key it looks
            // up. This is the ARCHITECTURE.md §13 item-9 unknown, and the SDK
            // answers it — but only on iOS 27 (ADR-013).
            //
            // On **iOS 26 there is NO parsing control at all**: `ParsingConfiguration`,
            // `urlParsingConfiguration` and `setURLParsingRegularExpression` are all
            // marked `@available(iOS 27.0, macOS 27.0, *)`. So on iOS 26 the dataset
            // key shape is fixed by the system, with hierarchy enumeration on — which
            // is exactly the "blocking a sub-URL takes out the whole domain" behaviour
            // ADR-002 describes.
            //
            // On iOS 27 query parameters CAN be included by name and hierarchy
            // enumeration CAN be switched off, so a key of the form
            // `youtube.com/watch?v=<id>` becomes expressible and blocking one video
            // need not enumerate up to the whole domain.
            //
            // Either way this does NOT give NEURLFilter an allow verdict or a
            // default-deny, so it still cannot express "deny all of YouTube except
            // this one video" — ADR-002 stands, and PoC A remains the engine.
            if #available(iOS 27.0, macOS 27.0, *) {
                mgr.urlParsingConfiguration = NEURLFilterManager.ParsingConfiguration(
                    excludeScheme: true,
                    domain: .init(stripWWW: true, enumerateHierarchy: false),
                    path: .init(enumerateHierarchy: false),
                    query: .init(excluded: false, parameters: ["v"]),
                    excludeFragment: true,
                    caseSensitive: false
                )
            }

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
    ///
    /// SDK: both are `async throws`, not synchronous (ADR-013).
    func resetPIRCache() async {
        do {
            try await NEURLFilterManager.shared.resetPIRCache()
            // Re-fetch PIR crypto params after a server-side database/param change.
            try await NEURLFilterManager.shared.refreshPIRParameters()
        } catch {
            lastError = "PIR reset failed: \(error.localizedDescription)"
        }
    }

    /// Report the manager's own lifecycle status (`.stopped/.starting/.running/…`)
    /// and the last disconnect error — both are `async` getters in the SDK.
    func refreshDetailedStatus() async {
        let mgr = NEURLFilterManager.shared
        let st = await mgr.status
        let err = await mgr.lastDisconnectError
        statusText = "\(st)" + (err.map { " (last error: \($0))" } ?? "")
    }
}
