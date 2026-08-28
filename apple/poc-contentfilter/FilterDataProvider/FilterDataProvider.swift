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
        // WebKit browser flow → full URL available. Fold the URL host's CNAME chain.
        if let browser = flow as? NEFilterBrowserFlow, let url = browser.url {
            let host = url.host ?? ""
            if !host.isEmpty { CnameResolver.shared.prime(host) }
            return verdict(forURL: url.absoluteString, resolvedHosts: CnameResolver.shared.chain(for: host))
        }
        // Socket flow → hostname only. Enforce host-level DOMAIN/CATEGORY rules,
        // resolving the CNAME chain so a cloaked alias can't bypass a domain block.
        if let socket = flow as? NEFilterSocketFlow, let host = socket.remoteHostname, !host.isEmpty {
            CnameResolver.shared.prime(host)
            let resolved = CnameResolver.shared.chain(for: host)
            let decision = store.evaluate("https://\(host)/", resolvedHosts: resolved)
            log.debug("socket flow host=\(host, privacy: .public) action=\(decision.action.rawValue, privacy: .public)")
            return decision.action == .block ? .drop() : .allow()
        }
        return .allow()
    }

    private func verdict(forURL urlString: String, resolvedHosts: [String]) -> NEFilterNewFlowVerdict {
        let decision = store.evaluate(urlString, resolvedHosts: resolvedHosts)
        log.info("url=\(urlString, privacy: .public) action=\(decision.action.rawValue, privacy: .public) reason=\(decision.reason, privacy: .public)")

        switch decision.action {
        case .allow:
            return .allow()
        case .block:
            // Render the Request-Access remediation page in the WebKit view.
            // The keys map to entries the control provider registered in
            // `remediationMap`; the flow URL is passed through so the app can
            // reconstruct the blocked canonical id when the child taps the link.
            return .remediateVerdict(withRemediationURLMapKey: "requestAccess",
                                     remediationButtonTextMapKey: "requestAccessButton")
        }
    }
}
