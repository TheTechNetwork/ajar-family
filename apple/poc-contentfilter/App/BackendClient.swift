import Foundation
import CryptoKit

/// The child device's client for the Ajar backend.
///
/// Until now the iOS app had **no networking at all** — it could only seed a
/// local unsigned policy through the DEBUG harness, which is why every runtime
/// result so far was measured against a policy nobody signed. This is the piece
/// that makes the real path work: enrol, pull SIGNED snapshots, file access
/// requests, and pick up a parent's decision within seconds.
///
/// ## Only the app talks to the backend
///
/// Neither extension does. The data provider's sandbox forbids network access
/// outright, and the control provider is permitted it but must not spend a
/// flow's latency on an HTTP round trip. The app fetches, `PolicyStore.install`
/// verifies the Ed25519 signature and writes the App Group, and the extensions
/// read what is already there. That is also why nothing here is in `Shared/`.
///
/// ## The bytes are not re-encoded
///
/// `GET /v1/devices/{id}/policy` returns the snapshot object as the entire
/// response body (`ok(body)` in the Worker's router adds no envelope), so the
/// raw response `Data` is handed to `PolicyStore.install(rawSnapshot:)`
/// untouched. Decoding and re-encoding it here would risk changing the bytes
/// the signature was computed over.
final class BackendClient {

    // MARK: - Configuration

    /// Where the backend lives. Stored in the App Group so it survives a
    /// relaunch and can be pointed at a local Worker during development.
    /// Defaults to the same origin as the block page. The Worker's custom domain
    /// takes every path, not just `/blocked`, so one hostname serves both — which
    /// means a child device talks to a single origin and a fresh install needs no
    /// typing before it can enrol. Overridable for local Worker development.
    static let defaultBaseURL = URL(string: "https://blocked.ajar.family")!

    static var baseURL: URL? {
        get {
            guard let s = defaults?.string(forKey: baseURLKey) else { return defaultBaseURL }
            return s.isEmpty ? nil : URL(string: s)
        }
        set { defaults?.set(newValue?.absoluteString, forKey: baseURLKey) }
    }

    private static let baseURLKey = "backend_base_url"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: PolicyStore.defaultAppGroup) }

    private let session: URLSession

    init(session: URLSession = .shared) { self.session = session }

    // MARK: - Errors

    enum BackendError: LocalizedError {
        case noBaseURL
        case notEnrolled
        case http(status: Int, body: String)
        case malformedResponse(String)

        var errorDescription: String? {
            switch self {
            case .noBaseURL:      return "No backend URL configured."
            case .notEnrolled:    return "This device is not enrolled yet."
            case let .http(s, b): return "Backend returned HTTP \(s): \(b)"
            case let .malformedResponse(d): return "Malformed response: \(d)"
            }
        }
    }

    // MARK: - Wire types
    //
    // Deliberately minimal: only the fields this client uses are decoded, so a
    // backend that adds a field does not break an installed app.

    struct EnrolledDevice: Decodable {
        let id: String
        let familyId: String
        let childId: String
    }

    private struct EnrollResponse: Decodable {
        let device: EnrolledDevice
        let deviceToken: String
        let signingPublicKeyB64: String?
    }

    private struct SigningKeyResponse: Decodable { let publicKeyB64: String }

    /// A policy poll either carries a snapshot or says nothing changed. The
    /// `upToDate` flag is the discriminator the backend sends.
    private struct UpToDateProbe: Decodable { let upToDate: Bool? }

    // MARK: - Enrollment

    /// Redeem a parent-issued enrollment code. Stores the device token, records
    /// the identity, and enrolls the backend's signing key so later snapshots
    /// can be verified.
    ///
    /// Enrolling the signing key here matters: `PolicyStore.enrollSigningKey` is
    /// WRITE-ONCE, so the key that arrives with a successful enrollment becomes
    /// the only signer this device will ever trust. A later attacker cannot swap
    /// in their own without also clearing the App Group.
    @discardableResult
    func enroll(code: String, displayName: String) async throws -> EnrolledDevice {
        guard let base = Self.baseURL else { throw BackendError.noBaseURL }

        // Stored by the backend against the device record. Unused for
        // verification today, but generating a real key now means enrolled
        // devices already carry one when it starts being checked.
        let devicePublicKey = DeviceIdentity.publicKeyB64()

        var req = URLRequest(url: base.appendingPathComponent("v1/enroll/redeem"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "devicePublicKey": devicePublicKey,
            "displayName": displayName,
        ])

        let data = try await send(req, authenticated: false)
        let decoded: EnrollResponse
        do { decoded = try JSONDecoder().decode(EnrollResponse.self, from: data) }
        catch { throw BackendError.malformedResponse(String(describing: error)) }

        DeviceCredentials.save(token: decoded.deviceToken, deviceId: decoded.device.id)

        // Prefer the key handed back by enrollment; fall back to the public
        // endpoint if this backend build does not include it in the response.
        // Not `??`: its right-hand side is a non-async autoclosure, so the
        // fallback fetch cannot be awaited inside one.
        var key = decoded.signingPublicKeyB64
        if key == nil || key?.isEmpty == true { key = try? await fetchSigningKey() }
        if let key, !key.isEmpty, !PolicyStore.shared.enrollSigningKey(key) {
            // Not fatal: an already-enrolled matching key returns true, so this
            // only fires for a genuinely DIFFERENT key — which is exactly the
            // swap the write-once rule exists to refuse.
            throw BackendError.malformedResponse(
                "the backend offered a signing key that differs from the one this device already trusts")
        }
        return decoded.device
    }

    /// The signing key on its own, for a device that needs to (re)learn it.
    func fetchSigningKey() async throws -> String {
        guard let base = Self.baseURL else { throw BackendError.noBaseURL }
        let data = try await send(URLRequest(url: base.appendingPathComponent("v1/signing-key")),
                                  authenticated: false)
        guard let k = try? JSONDecoder().decode(SigningKeyResponse.self, from: data) else {
            throw BackendError.malformedResponse("signing-key")
        }
        return k.publicKeyB64
    }

    var isEnrolled: Bool { DeviceCredentials.load() != nil }

    func signOut() { DeviceCredentials.clear() }

    // MARK: - Policy

    /// Pull the current policy and install it. Returns true if a NEW snapshot
    /// was installed, false if the device was already current.
    ///
    /// `since` uses the version already held, so a device that is up to date
    /// transfers almost nothing and still registers a heartbeat with the
    /// backend — which is what tells a parent the device is alive.
    @discardableResult
    func syncPolicy() async throws -> Bool {
        let (_, deviceId) = try credentials()
        guard let base = Self.baseURL else { throw BackendError.noBaseURL }

        var comps = URLComponents(
            url: base.appendingPathComponent("v1/devices/\(deviceId)/policy"),
            resolvingAgainstBaseURL: false)!
        let held = PolicyStore.shared.current()?.version
        if let held { comps.queryItems = [URLQueryItem(name: "since", value: String(held))] }

        let data = try await send(URLRequest(url: comps.url!), authenticated: true)
        return try install(policyResponse: data, deviceId: deviceId)
    }

    /// Long-poll for the next policy change (test A4's fast path). Returns true
    /// if a new snapshot was installed before the timeout.
    ///
    /// The backend parks the request until a parent decides something or the
    /// timeout expires, so a decision reaches the child in seconds without
    /// polling in a tight loop. The client timeout is deliberately longer than
    /// the server's park so the server, not URLSession, decides when to answer.
    @discardableResult
    func waitForPolicyChange(timeoutMs: Int = 25_000) async throws -> Bool {
        let (_, deviceId) = try credentials()
        guard let base = Self.baseURL else { throw BackendError.noBaseURL }

        var comps = URLComponents(
            url: base.appendingPathComponent("v1/devices/\(deviceId)/policy/wait"),
            resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "timeout", value: String(timeoutMs))]
        if let held = PolicyStore.shared.current()?.version {
            items.append(URLQueryItem(name: "since", value: String(held)))
        }
        comps.queryItems = items

        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = Double(timeoutMs) / 1000 + 10
        let data = try await send(req, authenticated: true)
        return try install(policyResponse: data, deviceId: deviceId)
    }

    /// Shared by both policy paths. A body carrying `upToDate` is a no-change
    /// answer; anything else is a snapshot and goes to the verifier as-is.
    private func install(policyResponse data: Data, deviceId: String) throws -> Bool {
        if let probe = try? JSONDecoder().decode(UpToDateProbe.self, from: data), probe.upToDate == true {
            return false
        }
        try PolicyStore.shared.install(rawSnapshot: data, expectedDeviceId: deviceId)
        return true
    }

    // MARK: - Access requests

    /// File a request for something that was blocked (the Request-Access flow).
    ///
    /// `targetValue` is the CANONICAL id, not the raw URL: the parent console
    /// and the policy engine both key on canonical ids, so a request for
    /// `youtube.com/watch?v=X&t=90` and one for `youtu.be/X` must arrive as the
    /// same thing or a parent gets asked twice for one video. `url` carries the
    /// original for display.
    func createRequest(targetType: String,
                       targetValue: String,
                       url: String?,
                       title: String? = nil,
                       reason: String? = nil) async throws {
        _ = try credentials()
        guard let base = Self.baseURL else { throw BackendError.noBaseURL }

        var body: [String: Any] = ["targetType": targetType, "targetValue": targetValue]
        if let url { body["url"] = url }
        if let title { body["title"] = title }
        if let reason { body["reason"] = reason }

        var req = URLRequest(url: base.appendingPathComponent("v1/requests"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await send(req, authenticated: true)
    }

    // MARK: - Transport

    private func credentials() throws -> (token: String, deviceId: String) {
        guard let c = DeviceCredentials.load() else { throw BackendError.notEnrolled }
        return c
    }

    private func send(_ request: URLRequest, authenticated: Bool) async throws -> Data {
        var req = request
        if authenticated {
            let (token, _) = try credentials()
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.malformedResponse("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            // Truncated: an error body is for a human reading a PoC screen, and
            // an unbounded one should not end up in a SwiftUI Text.
            let body = String(data: data.prefix(400), encoding: .utf8) ?? ""
            throw BackendError.http(status: http.statusCode, body: body)
        }
        return data
    }
}

// MARK: - Device credentials

/// The device bearer token, in the Keychain rather than the App Group.
///
/// `UserDefaults` would have been fewer lines, but this token authenticates
/// every policy sync and every access request for 30 days — it is a credential,
/// and the App Group is readable by both extensions that have no business
/// holding it. The Keychain item is app-only (no access group) because only the
/// containing app talks to the backend.
enum DeviceCredentials {

    private static let service = "family.ajar.child.deviceToken"
    private static let account = "device"
    private static let deviceIdKey = "backend_device_id"

    static func save(token: String, deviceId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        // The child's device is locked far more often than a parent's phone, and
        // policy sync happens in the foreground, so first-unlock is the right
        // trade. ThisDeviceOnly keeps the token out of an iCloud backup.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
        UserDefaults(suiteName: PolicyStore.defaultAppGroup)?.set(deviceId, forKey: deviceIdKey)
    }

    static func load() -> (token: String, deviceId: String)? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              let deviceId = UserDefaults(suiteName: PolicyStore.defaultAppGroup)?
                  .string(forKey: deviceIdKey),
              !token.isEmpty, !deviceId.isEmpty
        else { return nil }
        return (token, deviceId)
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
        UserDefaults(suiteName: PolicyStore.defaultAppGroup)?.removeObject(forKey: deviceIdKey)
    }
}

/// The device's own Ed25519 identity, generated once and kept in the Keychain.
/// Sent at enrollment as `devicePublicKey`. The backend stores it and does not
/// yet verify against it; generating it now means enrolled devices already have
/// one when it starts mattering, instead of needing a migration.
enum DeviceIdentity {

    private static let service = "family.ajar.child.deviceIdentity"
    private static let account = "ed25519"

    static func publicKeyB64() -> String {
        let key: Curve25519.Signing.PrivateKey
        if let existing = loadPrivateKey() {
            key = existing
        } else {
            key = Curve25519.Signing.PrivateKey()
            savePrivateKey(key)
        }
        return key.publicKey.rawRepresentation.base64EncodedString()
    }

    private static func loadPrivateKey() -> Curve25519.Signing.PrivateKey? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    private static func savePrivateKey(_ key: Curve25519.Signing.PrivateKey) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = key.rawRepresentation
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
