import NetworkExtension
import os.log

/// PoC A data-path provider. For each new flow it reduces the URL to a canonical
/// object, evaluates it against the App-Group signed policy snapshot using the
/// SHARED evaluation order, and returns allow / drop / remediate.
///
/// KEY EMPIRICAL POINT (PoC A / test A2): `flow.url` is populated only for WebKit
/// (Safari) browser flows — that is what gives us the full path+query needed to
/// tell one YouTube video from another. Socket flows expose hostname only. We log
/// both so the human PoC operator can record exactly what is visible.
///
/// Docs: https://developer.apple.com/documentation/networkextension/nefilterdataprovider
final class FilterDataProvider: NEFilterDataProvider {

    private let log = Logger(subsystem: "com.example.parentfilterpoc", category: "data")
    private let store = PolicyStore.shared

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        // Only interested in WebKit browser flows for the PoC (full URL); sockets
        // could be added to enforce googlevideo/host-level rules.
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        // WebKit browser flow → full URL available.
        if let browser = flow as? NEFilterBrowserFlow, let url = browser.url {
            return verdict(forURL: url.absoluteString, isWebKit: true)
        }
        // Socket flow → hostname only. Allow by default in the PoC (host-level
        // enforcement is a later concern); log for A2 comparison.
        if let socket = flow as? NEFilterSocketFlow {
            log.debug("socket flow host=\(socket.remoteHostname ?? "nil", privacy: .public)")
            return .allow()
        }
        return .allow()
    }

    private func verdict(forURL urlString: String, isWebKit: Bool) -> NEFilterNewFlowVerdict {
        let decision = store.evaluate(urlString)
        log.info("url=\(urlString, privacy: .public) action=\(decision.action.rawValue, privacy: .public) reason=\(decision.reason, privacy: .public)")

        switch decision.action {
        case .allow:
            return .allow()
        case .block:
            // Render the Request-Access remediation page in the WebKit view.
            // The keys map to entries the control provider registered in
            // `remediationMap`; the flow URL is passed through so the app can
            // reconstruct the blocked canonical id when the child taps the link.
            return .remediateVerdict(remediationURLMapKey: "requestAccess",
                                     remediationButtonTextMapKey: "requestAccessButton")
        }
    }
}
