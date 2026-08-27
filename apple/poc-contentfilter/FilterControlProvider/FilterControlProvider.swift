import NetworkExtension
import os.log

/// PoC A control provider. Owns the remediation map (the Request-Access block
/// page shown in Safari when the data provider returns `.remediateVerdict`) and
/// the fast-update path (`notifyRulesChanged()`).
///
/// The remediation URL points at a page the app can intercept to reconstruct the
/// blocked canonical id and open the Request-Access flow. Test A3/A4.
final class FilterControlProvider: NEFilterControlProvider {

    private let log = Logger(subsystem: "com.example.parentfilterpoc", category: "control")

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        // Register the remediation entries referenced by the data provider's
        // `.remediateVerdict(remediationURLMapKey:remediationButtonTextMapKey:)`.
        remediationMap = [
            NEFilterProviderRemediationMapRemediationURLs: [
                // The block page. Query params carry the blocked flow URL so the
                // app can normalize it to a canonical YouTube id (test A3).
                "requestAccess": "https://parentfilter.example/blocked?u=\(NEFilterProviderRemediationURLFlowURL)"
            ],
            NEFilterProviderRemediationMapRemediationButtonTexts: [
                "requestAccessButton": "Request Access"
            ],
        ]
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    /// The app calls into the extension (via a shared App-Group flag + a
    /// `NEFilterManager` reload) after writing a new policy snapshot; the control
    /// provider then tells the system rules changed so the new allow/deny applies
    /// within seconds (test A4).
    func rulesDidChange() {
        log.info("rules changed → notifyRulesChanged()")
        notifyRulesChanged()
    }

    override func handleReport(_ report: NEFilterReport) {
        // Optional: observe verdicts for the PoC propagation measurement.
    }
}
