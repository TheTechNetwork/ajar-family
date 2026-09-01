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
/// VERIFIED 2026-08-31, and it does stall flows — the switch below is now OFF.
///
/// On an iPhone 16 Pro Max (iOS 27.0) with `needRules()` enabled, pages loaded
/// partially or not at all and showed NO block page, which is the signature of a
/// flow that was neither allowed nor denied but simply never answered. The cause
/// is in `FilterControlProvider`: every `needRules()` flow is answered from ONE
/// SERIAL `DispatchQueue`, and each answer performs a synchronous CNAME walk with
/// a 0.4 s budget. A single page fans out to dozens of hosts, so the Nth flow
/// waits N × up-to-0.4 s while the system's own control-verdict timeout runs out
/// underneath it. Even a safety-floor page failed this way — not because the
/// floor was denied (it is allowed before the trust check, and was) but because
/// its SUBRESOURCES took the `needRules()` path.
///
/// Degraded behaviour with the switch off: the first sighting of a host is
/// decided with no CNAME chain, later flows to it are covered from the cache.
/// That is exactly what the browser extensions do, so it is a posture the
/// product already ships elsewhere rather than a new compromise.
///
/// Turning this back on needs the control provider fixed first — at minimum a
/// concurrent queue, and more likely resolving CNAMEs off the flow path entirely
/// rather than while a flow waits.
///
/// Docs: https://developer.apple.com/documentation/networkextension/nefilterdataprovider
final class FilterDataProvider: NEFilterDataProvider {

    /// Kill switch for the `needRules()` path described above. OFF: with it on,
    /// browsing stalls on device (measured 2026-08-31 — see the type doc).
    static let askControlProviderForUnknownHosts = false

    /// EXPERIMENT for A1/A2 (2026-08-31). Not a settled decision — see ADR-001.
    ///
    /// A socket flow carries a hostname and nothing else, so it can NEVER carry a
    /// YouTube video id. Applying `youTubeDefault: BLOCK` to it therefore blocks
    /// `www.youtube.com` at the connection level regardless of any per-video
    /// ALLOW rule: on device, the allowed video's page returned no block page
    /// (its BROWSER flow was correctly allowed by id) and then hung, because the
    /// page's own API calls were socket flows that got dropped.
    ///
    /// With this false, the YouTube default is enforced on the browser flow —
    /// where the video id actually is — and socket flows to YouTube hosts fall
    /// through to `webDefault`.
    ///
    /// THE COST, which is why this is a decision and not a fix: the YouTube
    /// NATIVE APP does not produce WebKit browser flows. It is socket-only, so it
    /// stops being default-denied and becomes unfiltered by this provider. Choose
    /// deliberately: "allow-one-video works in Safari" and "the YouTube app is
    /// default-denied" cannot both be true through this mechanism alone. Blocking
    /// the app itself is a separate control (ManagedSettings application policy).
    static let applyYouTubeDefaultToSocketFlows = false

    private let log = Logger(subsystem: "family.ajar.filter", category: "data")
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

    /// PER FLOW, NOT PER REQUEST — and that is the product's largest enforcement
    /// gap, measured on device 2026-09-01.
    ///
    /// An approved video's page opens a connection to www.youtube.com and this
    /// method allows it. Clicking another video from that page is a pushState
    /// route change plus an XHR to /youtubei/v1/player carried over THAT SAME
    /// connection — so no new flow is created, this method is never called
    /// again, and the second video's id (which lives in the request body) never
    /// reaches the filter at all. A fresh navigation in a new tab is still
    /// caught, because that is a main-frame load and does produce a browser
    /// flow.
    ///
    /// The browser extensions do not have this gap: they see a `requestType`,
    /// so a main-frame load can never be mistaken for player plumbing, and a
    /// content script catches the route change. Neither is available here.
    ///
    /// Closing it means returning `.filterDataVerdict(...)` and implementing
    /// `handleOutboundData` to inspect each request on a connection — a
    /// different class of filter, with real performance cost and a dependency on
    /// YouTube's private InnerTube shape. Not a patch; see docs/UX_PLAN.md.
    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        // WebKit browser flow → full URL available.
        if let browser = flow as? NEFilterBrowserFlow, let url = browser.url {
            return verdict(forURL: url.absoluteString, host: url.host ?? "", remediable: true)
        }
        // Socket flow → hostname only. Enforce host-level DOMAIN/CATEGORY rules.
        if let socket = flow as? NEFilterSocketFlow, let host = socket.remoteHostname, !host.isEmpty {
            return verdict(forURL: "https://\(host)/", host: host, remediable: false)
        }

        // NOTHING TO EVALUATE — and this branch is not rare.
        //
        // It catches a browser flow whose `url` is nil AND a socket flow whose
        // `remoteHostname` is nil or empty, which happens routinely: a connection
        // opened to an address the system already resolved carries no hostname
        // for the extension to read. With `filterSockets = true` that can be a
        // lot of traffic, and every byte of it reaches the network having never
        // been compared against a single rule.
        //
        // It still returns .allow(), because the alternative is worse: with no
        // host there is no way to apply the SAFETY FLOOR either (Tier 0 matches
        // by hostname), so dropping here would deny a child a crisis line to
        // enforce a policy we could not even read. Fail-open is the deliberate
        // choice; the defect was that it was SILENT.
        //
        // So it is recorded now. Anyone debugging "the site works even though it
        // is blocked" was reading a flow log that omitted the one category of
        // flow most likely to explain it, which turns a visible gap into a
        // ghost hunt. `unpoliced` is deliberately not an action any rule can
        // produce, so it cannot be confused with a real ALLOW.
        let kind = flow is NEFilterBrowserFlow ? "browser-no-url" : "socket-no-host"
        log.info("flow UNPOLICED kind=\(kind, privacy: .public) — no URL and no hostname; allowed without evaluation")
        #if DEBUG
        FlowLog.record(kind: kind, url: "(no url or hostname)", action: "allow", reason: "unpoliced:unidentifiable")
        #endif
        return .allow()
    }

    /// Evaluate with whatever CNAME chain is cached, and decide whether it is
    /// worth asking the control provider to resolve one first.
    private func verdict(forURL urlString: String, host: String, remediable: Bool) -> NEFilterNewFlowVerdict {
        let cached = cnameCache.chain(for: host)          // nil == not looked up yet
        var decision = store.evaluate(urlString, resolvedHosts: cached ?? [])

        // THE PLAYBACK CHAIN, tied to the grant.
        //
        // `*.googlevideo.com`, `i.ytimg.com` and the rest carry an approved
        // video's bytes and are not YouTube hosts, so they fell through to
        // `webDefault: ALLOW` — reachable permanently, approved video or not.
        // The support-host list existed in YouTubeNormalize.swift and NOTHING
        // referenced it. So the media CDN for a default-denied service was
        // simply open, and the one thing the whole product is built to gate was
        // gated only at the watch page.
        //
        // Now: open while a video grant is live, shut otherwise. That is the
        // rule shared/youtube/youtube-normalize.ts writes down and the browser
        // extensions already implement.
        //
        // `pathIsKnown` is `remediable` — a browser flow has the full URL, a
        // socket flow has a hostname and nothing else. That distinction is
        // load-bearing on `www.youtube.com`: without a path we cannot tell
        // `/youtubei/v1/player` from `/watch?v=…`, so the page host does not
        // qualify for a socket flow and one approved video cannot open all of
        // YouTube through the carve-out meant to keep it shut.
        let path = remediable ? URLComponents(string: urlString)?.path : nil
        if YouTube.isPlaybackSupport(host: host, path: path, pathIsKnown: remediable) {
            // Only ever overrides a DEFAULT. An explicit rule is a parent's
            // decision and outranks a carve-out — if someone has deliberately
            // blocked a support host, this must not quietly undo it. The safety
            // floor carries its own reason and is untouched either way.
            let fromDefault = decision.reason.hasPrefix("default:")
            if fromDefault, store.hasActiveVideoGrant() {
                decision = EvalResult(action: .allow, reason: "playback-support",
                                      matchedRuleId: nil, matchedKey: "PLAYBACK:\(Host.normalize(host))")
            } else if fromDefault, decision.action == .allow, decision.reason == "default:web",
                      YouTube.isExclusiveMediaHost(host) {
                // No grant, and the ONLY thing letting this through was the web
                // default. Shut it: this is YouTube's plumbing, and the family
                // asked for YouTube to be opt-in.
                //
                // `isExclusiveMediaHost`, NOT `isPlaybackSupport`. The support
                // list is a NEVER-BLOCK list — what must stay reachable while a
                // video is approved — and this branch read it as its own
                // inverse. `fonts.gstatic.com` is on it, so with no video
                // approved (the normal state, most of every day) Google Fonts
                // was blocked on EVERY site the child visited, with a browser
                // flow getting the "Ask to open it" page for a font file and a
                // parent-facing reason naming YouTube plumbing on a site that
                // has nothing to do with YouTube. Approving any video made the
                // whole web's fonts come back, which is not a clue anyone
                // unwinds. Blocking is narrow; reachability stays generous.
                decision = EvalResult(action: .block, reason: "playback-support:no-grant",
                                      matchedRuleId: nil, matchedKey: "PLAYBACK:\(Host.normalize(host))")
            }
        }

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

        // See `applyYouTubeDefaultToSocketFlows`. Only the DEFAULT is bypassed:
        // an explicit BLOCK rule carries a different reason and still drops, so
        // "block this video" and "block youtube.com" both keep working.
        if !remediable,
           !Self.applyYouTubeDefaultToSocketFlows,
           decision.action == .block,
           decision.reason == "default:youtube" {
            return .allow()
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
