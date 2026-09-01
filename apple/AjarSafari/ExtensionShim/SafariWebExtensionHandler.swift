import SafariServices
import os.log

/// The native half of the Safari Web Extension.
///
/// Safari requires an `NSExtensionRequestHandling` principal class even when the
/// extension is pure JavaScript — without it the extension will not load, which
/// is one reason the resources under `Extension/` were never installable.
///
/// It is deliberately almost empty. Every policy decision happens in
/// `Extension/background.js`, evaluating the cached signed snapshot LOCALLY
/// (docs/DECISIONS.md ADR-018: the decisions happen on device). Moving any of
/// that here would mean a message round trip per request, on the hot path of
/// every navigation, to reach the same answer.
///
/// `browser.runtime.sendNativeMessage` is the channel this would serve if the
/// extension ever needed to reach the child agent — the macOS design has the
/// agent as the policy source (`BACKEND_MODE == false` in background.js). That
/// path is not built yet, so this responds rather than pretending: a caller gets
/// an explicit "not available" instead of silence to wait on.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let log = Logger(subsystem: "family.ajar.safari", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        // The message is informational today. Logged at debug so a developer can
        // see the channel is alive, and NEVER with the payload interpolated
        // publicly — a native message can carry a URL the child visited, and
        // this product does not put browsing in the system log
        // (ARCHITECTURE.md privacy posture).
        log.debug("native message received")

        let response = NSExtensionItem()
        response.userInfo = [
            SFExtensionMessageKey: [
                "ok": false,
                // Named so a JS caller can branch on it rather than parsing prose.
                "error": "native-host-not-implemented",
                "detail": "Ajar for Safari decides in the extension; there is no native policy host yet.",
            ],
        ]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
