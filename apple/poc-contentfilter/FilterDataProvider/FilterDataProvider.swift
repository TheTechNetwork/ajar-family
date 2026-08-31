import NetworkExtension
import os.log

/// PoC A data-path provider. For each new flow it reduces the URL to a canonical
/// object, evaluates it against the App-Group *signed* policy snapshot using the
/// SHARED evaluation order, and returns allow / drop / remediate.
///
/// KEY EMPIRICAL POINT (PoC A / test A2): `flow.url` is populated only for WebKit
/// (Safari) browser flows — that is what gives us the full path+query needed to
/// tell one YouTube video from another. Socket flows expose hostname only.
///
/// ## CNAME resolution does NOT happen here
///
/// The data provider's sandbox forbids network access, and DNS is network
/// access — resolving from the filter that filters DNS is also a re-entrancy
/// hazard. So this provider only READS the shared CNAME chain cache. On a miss,
/// where the chain could still change the answer, it returns
/// `NEFilterNewFlowVerdict.needRules()`, which is the documented way to hand the
/// flow to the CONTROL provider — the extension Apple does permit to do network
/// work. See `FilterControlProvider.handleNewFlow`.
///
/// UNVERIFIED: `needRules()` round-tripping to the control provider has not been
/// exercised on a device (nothing here has been compiled). If it proves to stall
/// flows, set `askControlProviderForUnknownHosts = false` below: the filter then
/// degrades to "first sighting of a host uses no CNAME chain, later flows are
/// covered", which is the behavior the browser extensions have.
///
/// Docs: https://developer.apple.com/documentation/networkextension/nefilterdataprovider
final class FilterDataProvider: NEFilterDataProvider {

    /// Kill switch for the `needRules()` path described above.
    static let askControlProviderForUnknownHosts = true

    private let log = Logger(subsystem: "family.ajar.child", category: "data")
    private let store = PolicyStore.shared
    private let cnameCache = CnameChainCache.shared

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        #if DEBUG
        // THE EXTENSION IS A SEPARATE PROCESS FROM THE APP.
        //
        // `PolicyStore.allowUnsignedDevelopmentSnapshots` is a static — that is,
        // per-process — flag. The app sets it when the PoC harness seeds a local
        // unsigned policy, but nothing set it here, so this provider used to take
        // the signed path, find no enrolled signing key, and return
        // `.untrusted("no trusted signing key")`. `evaluate()` fails CLOSED on
        // untrusted, so EVERY flow was blocked with `snapshot-untrusted:...` and
        // the seeded rules were never consulted at all.
        //
        // The symptom was badly misleading: the blocked video was blocked and the
        // ALLOWED video was blocked too, which reads like "the filter cannot see
        // the video id" — i.e. a false negative for experiment A2 — when in fact
        // the URL was fine and the policy was simply never trusted. Only the
        // safety floor still worked, because Tier 0 runs before the state check.
        //
        // The persisted half of the gate (`policy_dev_unsigned` in the App Group)
        // is written ONLY by the app's DEBUG seeding path, so honouring it here
        // does not widen what a release build will trust: this whole block is
        // compiled out of Release.
        PolicyStore.allowUnsignedDevelopmentSnapshots = true
        #endif
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        // WebKit browser flow → full URL available.
        if let browser = flow as? NEFilterBrowserFlow, let url = browser.url {
            return verdict(forURL: url.absoluteString, host: url.host ?? "", remediable: true)
        }
        // Socket flow → hostname only. Enforce host-level DOMAIN/CATEGORY rules.
        if let socket = flow as? NEFilterSocketFlow, let host = socket.remoteHostname, !host.isEmpty {
            return verdict(forURL: "https://\(host)/", host: host, remediable: false)
        }
        return .allow()
    }

    /// Evaluate with whatever CNAME chain is cached, and decide whether it is
    /// worth asking the control provider to resolve one first.
    private func verdict(forURL urlString: String, host: String, remediable: Bool) -> NEFilterNewFlowVerdict {
        let cached = cnameCache.chain(for: host)          // nil == not looked up yet
        let decision = store.evaluate(urlString, resolvedHosts: cached ?? [])

        // Only log when the decision is reportable: a safety-floor hit must never
        // be recorded (shared/safety/safety-floor.ts — "a floor that is
        // surveilled is not a floor"), and `.public` on a URL puts it in the
        // system log where the parent-facing report pipeline could pick it up.
        if decision.isReportable {
            log.info("""
                flow decided action=\(decision.action.rawValue, privacy: .public) \
                reason=\(decision.reason, privacy: .public) \
                url=\(urlString, privacy: .private)
                """)
        }

        #if DEBUG
        // PoC instrument for A1-A3 (Shared/FlowLog.swift). The unified log
        // redacts the URL by design, so the experiments read it from the App
        // Group instead. Same `isReportable` gate as the log above, so a
        // safety-floor hit is not recorded here either.
        //
        // Recorded BEFORE the needRules() branch below, so a flow handed to the
        // control provider appears with the verdict the DATA provider reached on
        // the cached chain — which is the number A2 is asking about.
        if decision.isReportable {
            FlowLog.record(kind: remediable ? "browser" : "socket",
                           url: urlString,
                           action: decision.action.rawValue,
                           reason: decision.reason)
        }
        #endif

        // A CNAME chain can only ever turn an ALLOW into a BLOCK (it adds hosts
        // to match against), so a decision that is already BLOCK needs no
        // resolution — and neither does a safety-floor ALLOW, which no chain may
        // override.
        if Self.askControlProviderForUnknownHosts,
           cached == nil,
           decision.action == .allow,
           decision.reason != "safety-floor",
           !host.isEmpty {
            return .needRules()
        }

        switch decision.action {
        case .allow:
            return .allow()
        case .block:
            guard remediable else { return .drop() }
            // Render the Request-Access remediation page in the WebKit view. The
            // keys map to entries the control provider registered in
            // `remediationMap`; the flow URL is passed through so the app can
            // reconstruct the blocked canonical id when the child taps the link.
            return .remediateVerdict(withRemediationURLMapKey: "requestAccess",
                                     remediationButtonTextMapKey: "requestAccessButton")
        }
    }
}
