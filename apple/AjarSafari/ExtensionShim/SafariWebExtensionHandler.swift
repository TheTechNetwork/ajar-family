import Foundation
import SafariServices
import os.log

/// The native half of the Safari Web Extension — and, on iOS, the extension's
/// ONLY route to device policy.
///
/// Safari requires an `NSExtensionRequestHandling` principal class even when the
/// extension is pure JavaScript; without it the extension will not load, which
/// is one reason the resources under `Extension/` were never installable.
///
/// WHY IT IS NO LONGER EMPTY. It used to answer every message with
/// `native-host-not-implemented`, which was honest about itself and wrong about
/// the product: on iOS there is no separate child agent to be the policy source,
/// and the extension's other path (`backend-client.js`, enrolled through the
/// options page) would make a parent enroll the SAME device twice — once for the
/// content filter, once again for Safari — and hold two device identities for
/// one child. So the extension installed, held no policy, and every decision it
/// made was the no-policy fallback. An extension that cannot see policy cannot
/// filter, so "packaged and installable" was not the same as "working".
///
/// WHAT IT DOES NOW. `AjarFilter`'s containing app already enrolls this device
/// and writes the signed `DevicePolicySnapshot` into the App Group that its
/// extensions read (`PolicyStore`). This handler reads the same bytes and hands
/// them to the JavaScript, which re-verifies the Ed25519 signature itself before
/// trusting a single field of it (`policy-verify.js`). One enrollment, one
/// device identity, one snapshot, two enforcement surfaces.
///
/// It stays a READ. It never writes policy, never decides anything, and never
/// carries a URL: the decision happens in `background.js` against the cached
/// snapshot, locally, on the device (docs/DECISIONS.md ADR-018). Moving the
/// decision here would put a message round trip on the hot path of every
/// navigation to arrive at the same answer.
///
/// TRUST BOUNDARY. Anything with App-Group access can write these bytes — the
/// boundary `PolicyStore` already documents. That is why the signature is
/// checked on the JavaScript side too: this handler passes bytes along, it does
/// not vouch for them.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    /// The App Group `AjarFilter`'s containing app writes device policy into
    /// (`PolicyStore.defaultAppGroup`). A literal rather than an import: this
    /// target does not link AjarFilter's `Shared/` sources, and one duplicated
    /// string is cheaper than a cross-project dependency. `apple/check-app-group.mjs`
    /// fails CI if the two copies ever diverge — the divergence would be silent
    /// otherwise, and would look exactly like "the parent hasn't enrolled yet".
    static let appGroup = "group.family.ajar.filter"

    // Key names owned by PolicyStore (snapshot/key/provisioned) and
    // BackendClient (device id). Same file, same guard.
    private static let snapshotKey = "device_policy_snapshot_raw_v2"
    private static let signingKeyKey = "policy_signing_key_spki_b64"
    private static let provisionedKey = "policy_device_provisioned"
    private static let deviceIdKey = "backend_device_id"

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
        default:
            payload = [
                "ok": false,
                // Named so a JS caller can branch on it rather than parse prose.
                "error": "unknown-message-type",
                "detail": "Ajar for Safari serves GET_POLICY; decisions are made in the extension.",
            ]
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// This device's policy as the JavaScript needs it.
    ///
    /// `snapshotJSON` is the snapshot EXACTLY as the backend delivered and signed
    /// it — passed as text, not re-encoded, because re-encoding through
    /// `JSONSerialization` could reorder or renumber a field and invalidate a
    /// signature the receiver is about to check.
    static func policyPayload() -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return [
                "ok": false,
                "error": "app-group-unavailable",
                "detail": "This build is not in \(appGroup); check the extension's entitlements.",
            ]
        }

        var out: [String: Any] = [
            "ok": true,
            // "Has this device ever been enrolled?" — the difference between
            // "not set up yet" (allow, nothing is claimed to be filtered) and
            // "set up, and policy is missing" (block; see background.js).
            "provisioned": defaults.bool(forKey: provisionedKey),
        ]
        if let raw = defaults.data(forKey: snapshotKey),
           let json = String(data: raw, encoding: .utf8) {
            out["snapshotJSON"] = json
        }
        if let key = defaults.string(forKey: signingKeyKey), !key.isEmpty {
            out["signingKeyB64"] = key
        }
        if let deviceId = defaults.string(forKey: deviceIdKey), !deviceId.isEmpty {
            out["deviceId"] = deviceId
        }
        return out
    }
}
