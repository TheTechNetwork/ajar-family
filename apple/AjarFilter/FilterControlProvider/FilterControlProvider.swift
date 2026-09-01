import NetworkExtension
import os.log

/// PoC A control provider. Owns the remediation map (the Request-Access block
/// page shown in Safari when the data provider returns `.remediateVerdict`), the
/// fast-update path (`notifyRulesChanged()`), and — new in this pass — the CNAME
/// resolution the data provider is not allowed to do.
///
/// The remediation URL points at a page the app can intercept to reconstruct the
/// blocked canonical id and open the Request-Access flow. Test A3/A4.
final class FilterControlProvider: NEFilterControlProvider {

    /// Total budget for resolving a chain while a flow waits. The system does not
    /// wait forever for a control verdict, and a slow DNS server must not stall
    /// browsing, so the walk is cut off and whatever was learned is used.
    static let cnameBudget: TimeInterval = 0.4

    /// Where the Request-Access block page lives.
    ///
    /// Read from the App Group so a development build can point at a local
    /// Worker, with the production host as the fallback. `remediationMap` is
    /// built once in `startFilter`, so changing this takes effect when the
    /// filter is next started — not mid-session.
    static var blockPageBase: String {
        let configured = UserDefaults(suiteName: PolicyStore.defaultAppGroup)?
            .string(forKey: "block_page_base")
        if let configured, !configured.isEmpty { return configured }
        return "https://blocked.ajar.family/blocked"
    }

    private let log = Logger(subsystem: "family.ajar.filter", category: "control")
    private let store = PolicyStore.shared
    private let cache = CnameChainCache.shared
    private let queue = DispatchQueue(label: "com.ajar.control.cname", qos: .userInitiated)

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        #if DEBUG
        // Same per-process gate as FilterDataProvider.startFilter — see the long
        // comment there. This provider evaluates policy too (the needRules()
        // path), so without this it would also fail closed on every flow it was
        // handed, for a reason that has nothing to do with the flow.
        PolicyStore.allowUnsignedDevelopmentSnapshots = true
        #endif
        // Register the remediation entries referenced by the data provider's
        // `.remediateVerdict(remediationURLMapKey:remediationButtonTextMapKey:)`.
        // SDK: remediationMap is [String: [String: NSObject]] — values must be
        // NSObject, so the strings are bridged explicitly (see DECISIONS ADR-001).
        // The remediation URL must use the http/https scheme (NEFilterProvider.h);
        // NE_FLOW_URL is substituted by the system with the blocked flow URL.
        remediationMap = [
            NEFilterProviderRemediationMapRemediationURLs: [
                // The block page. Query params carry the blocked flow URL so the
                // app can normalize it to a canonical YouTube id (test A3).
                //
                // This host MUST stay reachable or Request Access is a dead
                // button: it is fetched by Safari while a filter is actively
                // blocking, so it has to survive the policy that caused the
                // block. `webDefault: ALLOW` covers it today; if a family is
                // ever moved to default-deny web, this host needs an explicit
                // allow or the child cannot ask for anything.
                //
                // It was `parentfilter.example` — a reserved placeholder domain
                // that does not resolve — so the page rendered, the button
                // appeared, and tapping it went nowhere. That is why A3 was only
                // ever recorded as a partial pass.
                //
                // WHAT THE SYSTEM ACTUALLY SUBSTITUTES, and why the page has to
                // be forgiving about it. NE_FLOW_URL is replaced with the flow's
                // URL when there IS one — a WebKit browser flow — and with the
                // HOST when there is not, which is every socket flow. A real
                // block therefore produced `?u=www.youtube.com/`, with no
                // scheme, and the page's `^https?://` guard rejected it: the
                // child got "No address came through" and no button. The server
                // now adds the scheme rather than dropping the target
                // (`normalizeBlockedTarget` in backend/src/http/api.ts) — it
                // cannot be fixed here, because the substitution is the
                // system's, not ours.
                //
                // The substitution is also NOT percent-encoded, so a flow URL
                // carrying its own query arrives with live `&`s: `?u=…/watch?v=X
                // &t=30` parses as `u=…/watch?v=X` plus a stray `t=30`. The `v`
                // survives — it is before the first `&` — so the canonical video
                // id, which is the only part an approval is keyed on, is intact.
                // Extra params are lost. Left as-is deliberately: recovering
                // them would mean guessing which stray params belonged to `u`.
                "requestAccess": "\(Self.blockPageBase)?u=\(NEFilterProviderRemediationURLFlowURL)" as NSString
            ],
            NEFilterProviderRemediationMapRemediationButtonTexts: [
                "requestAccessButton": "Request Access" as NSString
            ],
        ]
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    /// Called when the data provider returns `NEFilterNewFlowVerdict.needRules()`.
    ///
    /// Unlike the data provider, the control provider IS permitted network
    /// access, so this is where the CNAME chain gets resolved. The chain is
    /// written to the App-Group cache (so every later flow to the same host is
    /// decided in the data path with no round trip) and the flow is answered
    /// with the full evaluation.
    ///
    /// LIMITATION: `NEFilterControlVerdict` has no "remediate" case, so a flow
    /// blocked *here* is dropped rather than shown the Request-Access page. It
    /// carries `withUpdateRules: true`, so the data provider re-evaluates the
    /// next flow to that host from cache and can remediate it properly. Whether
    /// that reads acceptably in Safari is test A3 and is UNVERIFIED.
    override func handleNewFlow(_ flow: NEFilterFlow,
                                completionHandler: @escaping (NEFilterControlVerdict) -> Void) {
        let urlString: String
        let host: String
        if let browser = flow as? NEFilterBrowserFlow, let url = browser.url {
            urlString = url.absoluteString
            host = url.host ?? ""
        } else if let socket = flow as? NEFilterSocketFlow, let h = socket.remoteHostname, !h.isEmpty {
            urlString = "https://\(h)/"
            host = h
        } else {
            completionHandler(.allow(withUpdateRules: false))
            return
        }

        queue.async { [weak self] in
            guard let self else { completionHandler(.allow(withUpdateRules: false)); return }
            let chain = CnameResolver.shared.resolve(
                host, deadline: Date().addingTimeInterval(Self.cnameBudget))
            // Cache even an empty chain: a negative result stops us paying for a
            // round trip on every flow to a host that has no CNAME.
            self.cache.store(host: host, chain: chain)

            let decision = self.store.evaluate(urlString, resolvedHosts: chain)
            if decision.isReportable {
                self.log.info("""
                    control decided action=\(decision.action.rawValue, privacy: .public) \
                    reason=\(decision.reason, privacy: .public) \
                    chain=\(chain.count, privacy: .public)
                    """)
            }
            completionHandler(decision.action == .block
                              ? .drop(withUpdateRules: true)
                              : .allow(withUpdateRules: true))
        }
    }

    /// The app calls into the extension (via a shared App-Group flag + a
    /// `NEFilterManager` reload) after writing a new policy snapshot; the control
    /// provider then tells the system rules changed so the new allow/deny applies
    /// within seconds (test A4).
    func rulesDidChange() {
        log.info("rules changed → notifyRulesChanged()")
        notifyRulesChanged()
    }

    override func handle(_ report: NEFilterReport) {
        // Deliberately empty. Anything added here must respect the safety floor:
        // a flow decided by `reason == "safety-floor"` is never reported, so any
        // reporting added later must consult `EvalResult.isReportable` rather
        // than reporting every verdict it sees.
    }
}
