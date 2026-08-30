import Foundation
import CryptoKit

/// Ed25519 verification of everything the backend signs (ADR-010), using
/// CryptoKit. The device holds only the PUBLIC key and fails CLOSED: a snapshot
/// or filter asset whose signature does not verify is rejected outright, never
/// "used anyway with a warning".
///
/// Two things it must get exactly right, both handled here:
///
/// 1. **The bytes.** `backend/src/domain/signing.ts` signs
///    `canonicalJSON({...snapshot, signature: undefined})` — the canonical JSON
///    of the snapshot MINUS its own signature field. See `CanonicalJSON.swift`.
///    Crucially this operates on the RAW delivered bytes; re-encoding a decoded
///    Swift model would change date formatting and drop unknown fields.
///
/// 2. **The key encoding.** The backend publishes the key as base64 of the SPKI
///    DER (`GET /v1/signing-key` → `{ publicKeyB64, alg: "Ed25519" }`), because
///    that is what WebCrypto's `importKey("spki", …)` wants. CryptoKit's
///    `Curve25519.Signing.PublicKey(rawRepresentation:)` wants the bare 32-byte
///    key. For Ed25519 the SPKI DER is a fixed 44-byte structure:
///
///        30 2a                          SEQUENCE (42 bytes)
///          30 05                        SEQUENCE (5 bytes)  — AlgorithmIdentifier
///            06 03 2b 65 70             OID 1.3.101.112 (id-Ed25519)
///          03 21 00                     BIT STRING (33 bytes), 0 unused bits
///            <32 raw key bytes>
///
///    so the raw key is simply the trailing 32 bytes. The 12-byte prefix is
///    verified rather than blindly skipped, so a key for the wrong algorithm (or
///    a truncated one) is rejected instead of being reinterpreted as an Ed25519
///    key. A bare 32-byte raw key is also accepted, since some tooling emits it.
///
/// NOT COMPILED OR RUN. `PolicySelfTest` verifies a real signature produced by
/// the backend's own code path, which exercises this file, `CanonicalJSON`, and
/// the SPKI unwrap together.
public enum SnapshotVerifier {

    public enum VerifyError: Swift.Error, CustomStringConvertible {
        case noTrustedKey
        case malformedPublicKey
        case missingSignature
        case malformedSignature
        case canonicalizationFailed(String)
        case signatureMismatch

        public var description: String {
            switch self {
            case .noTrustedKey: return "no trusted signing key is provisioned on this device"
            case .malformedPublicKey: return "signing key is not a valid Ed25519 SPKI DER / raw key"
            case .missingSignature: return "payload carries no signature"
            case .malformedSignature: return "signature is not 64 bytes of base64"
            case let .canonicalizationFailed(m): return "canonicalization failed: \(m)"
            case .signatureMismatch: return "Ed25519 signature does not verify"
            }
        }
    }

    /// The 12-byte DER prefix that precedes the 32 raw bytes of an Ed25519 SPKI.
    static let ed25519SPKIPrefix: [UInt8] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]

    /// SPKI DER (or already-raw) base64 → CryptoKit public key.
    public static func publicKey(fromBase64 keyB64: String) throws -> Curve25519.Signing.PublicKey {
        guard let der = Data(base64Encoded: keyB64, options: [.ignoreUnknownCharacters]) else {
            throw VerifyError.malformedPublicKey
        }
        let bytes = [UInt8](der)
        let raw: [UInt8]
        if bytes.count == 44 {
            guard Array(bytes.prefix(12)) == ed25519SPKIPrefix else { throw VerifyError.malformedPublicKey }
            raw = Array(bytes.suffix(32))
        } else if bytes.count == 32 {
            raw = bytes                      // already the raw representation
        } else {
            throw VerifyError.malformedPublicKey
        }
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: Data(raw)) else {
            throw VerifyError.malformedPublicKey
        }
        return key
    }

    /// Verify `signatureB64` over the canonical JSON of `object` — the mirror of
    /// the backend's `verifyCanonical`. Used for the category filter asset, whose
    /// signature covers the `set` object as delivered.
    public static func verifyCanonical(
        rawObject: Data,
        signatureB64: String,
        publicKeyB64: String
    ) throws {
        let key = try publicKey(fromBase64: publicKeyB64)
        let message: Data
        do { message = try CanonicalJSON.canonicalize(rawObject) }
        catch { throw VerifyError.canonicalizationFailed(String(describing: error)) }
        try verify(message: message, signatureB64: signatureB64, key: key)
    }

    /// Verify a `DevicePolicySnapshot` as delivered. `rawSnapshot` must be the
    /// bytes received from the backend (or read back from the cache), NOT a
    /// re-encoding of a decoded model.
    public static func verifySnapshot(rawSnapshot: Data, publicKeyB64: String) throws {
        let key = try publicKey(fromBase64: publicKeyB64)
        let signature: String
        let message: Data
        do {
            guard let s = try CanonicalJSON.topLevelString(rawSnapshot, key: "signature"), !s.isEmpty else {
                throw VerifyError.missingSignature
            }
            signature = s
            message = try CanonicalJSON.canonicalizeObject(rawSnapshot, removingTopLevelKey: "signature")
        } catch let e as VerifyError {
            throw e
        } catch {
            throw VerifyError.canonicalizationFailed(String(describing: error))
        }
        try verify(message: message, signatureB64: signature, key: key)
    }

    private static func verify(message: Data, signatureB64: String, key: Curve25519.Signing.PublicKey) throws {
        guard !signatureB64.isEmpty else { throw VerifyError.missingSignature }
        guard let sig = Data(base64Encoded: signatureB64, options: [.ignoreUnknownCharacters]),
              sig.count == 64 else { throw VerifyError.malformedSignature }
        // CryptoKit's isValidSignature is constant-time and returns Bool; there is
        // no error path to swallow, so a false here is a hard rejection.
        guard key.isValidSignature(sig, for: message) else { throw VerifyError.signatureMismatch }
    }
}
