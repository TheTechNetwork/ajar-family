import Foundation

/// App-Group cache for the signed category Bloom-filter asset
/// (`GET /v1/categories/filters` → `{ set, signature }` | `{ upToDate: true }`).
///
/// The containing app fetches it (extensions have no network); this store
/// verifies the Ed25519 signature over the canonical JSON of `set` — the mirror
/// of the backend's `signCanonical` / the extensions' `verifyCanonicalSignature`
/// — and persists the CANONICAL bytes plus the signature so the sandboxed
/// providers can re-verify what they read. Verification failure ⇒ the asset is
/// not installed and the previously installed one is left alone; a cached asset
/// that stops verifying is dropped (its categories then simply do not match,
/// which under-blocks rather than over-blocks — see the README risk table).
///
/// NOT COMPILED OR RUN.
public final class CategoryFilterStore {

    public static let shared = CategoryFilterStore(appGroup: PolicyStore.defaultAppGroup)

    private let defaults: UserDefaults?
    private let setKey = "category_filter_set_canonical_v1"   // canonical JSON of `set`
    private let sigKey = "category_filter_signature_v1"

    private let lock = NSLock()
    private var cachedFilters: CategoryFilters?
    private var cachedDigest: Data?

    public init(appGroup: String) {
        self.defaults = UserDefaults(suiteName: appGroup)
    }

    /// Install a `/v1/categories/filters` response body. Returns false (and
    /// changes nothing) when the response is `{ upToDate: true }` or fails
    /// verification. `publicKeyB64` is the pinned/enrolled backend signing key.
    @discardableResult
    public func install(responseBody: Data, publicKeyB64: String) throws -> Bool {
        let root = try CanonicalJSON.parse(responseBody)
        guard case let .object(fields) = root else { throw CanonicalJSON.Error.notAnObject }
        if case .bool(true)? = fields["upToDate"] { return false }
        guard let setValue = fields["set"] else { throw CanonicalJSON.Error.notAnObject }
        guard case let .string(signature)? = fields["signature"], !signature.isEmpty else {
            throw SnapshotVerifier.VerifyError.missingSignature
        }
        // Canonicalization is idempotent, so the canonical bytes we persist are
        // the same bytes the signature covers and can be re-verified verbatim.
        let canonical = Data(try CanonicalJSON.emit(setValue).utf8)
        try SnapshotVerifier.verifyCanonical(rawObject: canonical,
                                             signatureB64: signature,
                                             publicKeyB64: publicKeyB64)
        // Only accept an asset we can actually query.
        let decoded = try JSONDecoder().decode(CategoryFilterSet.self, from: canonical)
        guard CategoryFilters(set: decoded) != nil else { throw CanonicalJSON.Error.notAnObject }

        lock.lock()
        defaults?.set(canonical, forKey: setKey)
        defaults?.set(signature, forKey: sigKey)
        cachedDigest = nil; cachedFilters = nil
        lock.unlock()
        return true
    }

    /// The version to send as `?since=` on the next fetch. -1 when nothing cached.
    public func installedVersion(publicKeyB64: String?) -> Int {
        current(publicKeyB64: publicKeyB64)?.version ?? -1
    }

    /// Prepared, signature-verified filters, or nil. Re-verifies whenever the
    /// stored bytes change (cheap SHA-256 compare on the hot path); an asset that
    /// no longer verifies is treated as absent.
    public func current(publicKeyB64: String?) -> CategoryFilters? {
        guard let publicKeyB64, !publicKeyB64.isEmpty,
              let raw = defaults?.data(forKey: setKey),
              let signature = defaults?.string(forKey: sigKey) else { return nil }
        let digest = Digest.sha256(raw)

        lock.lock()
        if cachedDigest == digest, let f = cachedFilters { lock.unlock(); return f }
        lock.unlock()

        guard (try? SnapshotVerifier.verifyCanonical(rawObject: raw,
                                                     signatureB64: signature,
                                                     publicKeyB64: publicKeyB64)) != nil,
              let decoded = try? JSONDecoder().decode(CategoryFilterSet.self, from: raw),
              let filters = CategoryFilters(set: decoded) else { return nil }

        lock.lock()
        cachedDigest = digest; cachedFilters = filters
        lock.unlock()
        return filters
    }

    public func clear() {
        lock.lock()
        defaults?.removeObject(forKey: setKey)
        defaults?.removeObject(forKey: sigKey)
        cachedDigest = nil; cachedFilters = nil
        lock.unlock()
    }
}
