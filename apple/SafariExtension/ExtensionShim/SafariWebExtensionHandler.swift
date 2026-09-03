import Foundation
import SafariServices
import os.log

/// The native half of the Safari Web Extension — and the extension's only route
/// to device policy.
///
/// Safari requires an `NSExtensionRequestHandling` principal class even when the
/// extension is pure JavaScript; without it the extension will not load, which
/// is one reason the resources under `Extension/` were never installable.
///
/// WHY IT IS NOT EMPTY. It used to answer every message with
/// `native-host-not-implemented`, which was honest about itself and wrong about
/// the product: there is no separate child agent on iOS to be the policy source,
/// and the extension's other path (`backend-client.js`, enrolled through the
/// options page) would make a parent enrol the SAME device twice and hold two
/// device identities for one child. So the extension installed, held no policy,
/// and every decision it made was the no-policy fallback.
///
/// WHAT IT DOES. The containing app already enrols this device and writes the
/// signed `DevicePolicySnapshot` into the shared App Group; this reads it back
/// through `PolicyStore` — the same type the content filter reads — and hands
/// the bytes to the JavaScript, which re-verifies the Ed25519 signature itself
/// before trusting a field of it (`policy-verify.js`). One enrolment, one device
/// identity, one snapshot, two enforcement surfaces.
///
/// IT NEVER DECIDES, and it carries no URL: the decision happens in
/// `background.js` against the cached snapshot, locally, on the device
/// (docs/DECISIONS.md ADR-018). Moving the decision here would put a message
/// round trip on the hot path of every navigation to arrive at the same answer.
///
/// IT WRITES TWO THINGS, both of which only ever tighten or queue.
///
/// 1. That a "just once" grant has been SPENT. That state has to be shared with
///    the content filter or "just once" means once per surface — watch it in
///    Safari, then watch it again through a top-level navigation the filter
///    sees, because neither knows what the other spent. It is a set of opaque
///    grant ids, it only ever grows within a policy version, and spending
///    something twice is a no-op, so the write cannot loosen anything.
/// 2. That a child ASKED for something. The extension has no device identity and
///    must not get one, so it queues into the App Group and the containing app —
///    already enrolled, already syncing — posts it. Nothing here grants
///    anything; a request is a question, and the answer arrives as a signed
///    snapshot like every other policy change.
///
/// TRUST BOUNDARY. Anything with App-Group access can write those bytes — the
/// boundary `PolicyStore` already documents. That is why the signature is
/// checked on the JavaScript side too: this handler passes bytes along, it does
/// not vouch for them.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let log = Logger(subsystem: "family.ajar.safari", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        let type = message?["type"] as? String ?? ""

        // Logged at debug, WITHOUT the message body: a native message from this
        // extension can name a URL the child visited, and this product does not
        // put browsing in the system log (ARCHITECTURE.md privacy posture).
        log.debug("native message: \(type, privacy: .public)")

        let payload: [String: Any]
        switch type {
        case "GET_POLICY":
            payload = Self.policyPayload()
        case "SPEND_GRANT":
            payload = Self.spendGrant(message?["grantId"] as? String)
        case "REQUEST_ACCESS":
            payload = Self.requestAccess(message)
        default:
            payload = [
                "ok": false,
                // Named so a JS caller can branch on it rather than parse prose.
                "error": "unknown-message-type",
                "detail": "Ajar for Safari serves GET_POLICY, SPEND_GRANT and REQUEST_ACCESS; "
                    + "decisions are made in the extension.",
            ]
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Record that a one-time grant has been used, in the store the content
    /// filter reads.
    ///
    /// Only ever adds; `PolicyStore.spendGrant` prunes ids the policy no longer
    /// carries and returns whether this call is what spent it, so the containing
    /// app can report each one to the backend exactly once.
    static func spendGrant(_ grantId: String?) -> [String: Any] {
        guard let grantId, !grantId.isEmpty else {
            return ["ok": false, "error": "missing-grant-id"]
        }
        let firstTime = PolicyStore.shared.spendGrant(grantId)
        return ["ok": true, "spent": firstTime]
    }

    /// Queue "ask a parent" for the containing app to post.
    ///
    /// WHY IT DOES NOT POST FROM HERE. The extension has no device identity and
    /// must not get one: enrolling it separately would hand one child two device
    /// identities for one phone — precisely what the options-page path does, and
    /// why that path is a dev fallback. The app is enrolled, holds the token and
    /// already syncs, so this writes to the App Group and the app sends it. A
    /// blocked child on a train also keeps their question that way, instead of
    /// losing it to a failed request.
    ///
    /// Until this existed the block page's Ask button fell through to the
    /// backend path, which needs an enrolment the extension does not have — so
    /// on iOS the one screen where the product must work returned an error.
    ///
    /// `targetValue` must be the CANONICAL id, not the raw URL: the console and
    /// the policy engine both key on canonical ids, so `watch?v=X&t=90` and
    /// `youtu.be/X` have to arrive as one question. `background.js` canonicalises
    /// before it gets here; `url` carries the original for a parent to read.
    static func requestAccess(_ message: [String: Any]?) -> [String: Any] {
        guard let targetType = message?["targetType"] as? String,
              let targetValue = message?["targetValue"] as? String,
              !targetType.isEmpty, !targetValue.isEmpty else {
            return ["ok": false, "error": "missing-target"]
        }
        let queued = PolicyStore.shared.enqueueAccessRequest(
            targetType: targetType,
            targetValue: targetValue,
            url: message?["url"] as? String,
            title: message?["title"] as? String,
            reason: message?["reason"] as? String
        )
        // A full queue is reported rather than swallowed: the block page has to
        // be able to say "we could not ask" instead of telling a child their
        // parent was asked when nobody was.
        return queued ? ["ok": true] : ["ok": false, "error": "queue-full"]
    }

    /// This device's policy as the JavaScript needs it.
    ///
    /// Read through `PolicyStore`, which is compiled into this target, so the
    /// App Group name and the storage keys have exactly one definition. An
    /// earlier version duplicated them as string literals here — a second copy
    /// that could drift silently, read nothing, and look precisely like a device
    /// nobody had ever enrolled, which is the one state that allows everything.
    ///
    /// `snapshotJSON` is the snapshot EXACTLY as the backend delivered and
    /// signed it. Passed as text, never re-encoded: round-tripping it through a
    /// Swift model and back could reorder a key or renumber a value and
    /// invalidate the signature the receiver is about to check.
    static func policyPayload() -> [String: Any] {
        let store = PolicyStore.shared
        var out: [String: Any] = [
            // "Has this device ever been enrolled?" — the difference between
            // "not set up yet" (allow; we claim to filter nothing) and "set up,
            // and policy is missing" (block). See background.js decide().
            "ok": true,
            "provisioned": store.isProvisioned,
            // Surfaced so the extension can tell a parent WHY it is blocking
            // everything, rather than leaving them with a browser that has
            // silently stopped working.
            "tamperDetected": store.tamperDetected,
        ]
        if let raw = store.rawSnapshotForSharing(),
           let json = String(data: raw, encoding: .utf8) {
            out["snapshotJSON"] = json
        }
        if let key = store.trustedSigningKeyB64, !key.isEmpty {
            out["signingKeyB64"] = key
        }
        return out
    }
}
