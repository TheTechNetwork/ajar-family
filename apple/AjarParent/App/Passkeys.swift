import AuthenticationServices
import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Passkey sign-in for the parent app.
///
/// WHY THIS FILE EXISTS. Sign-in is password-then-passkey: `/v1/auth/login`
/// hands back an `mfa` token instead of a session as soon as an account has a
/// passkey enrolled, and signup enrols one as step two of five. Without a
/// passkey implementation here the app could not sign in at all — the phone,
/// which is the whole premise of "approve in seconds", was the one surface the
/// second factor switched off.
///
/// WHAT THE PLATFORM NEEDS. `ASAuthorizationPlatformPublicKeyCredentialProvider`
/// will only produce an assertion for a relying-party identifier the app is
/// entitled to, which means BOTH of:
///   * `com.apple.developer.associated-domains` containing
///     `webcredentials:ajar.family` (AjarParent.entitlements), and
///   * an apple-app-site-association served from `https://ajar.family` naming
///     this app (backend/src/http/api.ts, APPLE_APP_IDS).
/// Miss either and every attempt fails with a domain-association error that
/// says nothing about which half is missing — hence `humanMessage` below.
///
/// WHAT IS DELIBERATELY NOT MODELLED. The options blob from the server is
/// parsed for the four fields the platform needs and no more. A struct
/// mirroring the whole of WebAuthn would drop any field a newer server adds,
/// silently, on the auth path.
enum Passkeys {

    enum Failure: LocalizedError {
        case cancelled
        case unsupported
        case malformedOptions
        case platform(String)

        var errorDescription: String? {
            switch self {
            case .cancelled:
                return "Sign-in was cancelled."
            case .unsupported:
                return "This device can't use passkeys. Sign in at ajar.family instead."
            case .malformedOptions:
                return "Ajar sent a sign-in challenge this app couldn't read. Update Ajar and try again."
            case .platform(let why):
                return why
            }
        }
    }

    /// Run the assertion ceremony and return the credential JSON the backend
    /// expects, ready to post to `/v1/auth/passkeys/login`.
    ///
    /// Shaped to match `@simplewebauthn/server`'s `verifyAuthenticationResponse`
    /// exactly — every binary field base64url, `type` literally `"public-key"`.
    /// Getting one of those wrong produces a *verification* failure server-side,
    /// which is indistinguishable from a wrong passkey.
    static func signIn(optionsJSON: Data) async throws -> [String: Any] {
        guard let options = try? JSONSerialization.jsonObject(with: optionsJSON) as? [String: Any],
              let rpId = options["rpId"] as? String,
              let challengeB64 = options["challenge"] as? String,
              let challenge = Data(base64URLEncoded: challengeB64)
        else { throw Failure.malformedOptions }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)

        // Narrow the prompt to the passkeys this account actually has. Without
        // it the platform offers every passkey saved for the domain, and the
        // server refuses the wrong one with "that passkey was not recognised" —
        // a security answer to what is really a picker problem.
        if let allow = options["allowCredentials"] as? [[String: Any]] {
            request.allowedCredentials = allow.compactMap { entry in
                guard let id = entry["id"] as? String, let raw = Data(base64URLEncoded: id) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: raw)
            }
        }
        // Mirror the server's `userVerification: "preferred"`. Demanding
        // `.required` here while the server only prefers it would refuse
        // hardware that is otherwise fine.
        switch options["userVerification"] as? String {
        case "required": request.userVerificationPreference = .required
        case "discouraged": request.userVerificationPreference = .discouraged
        default: request.userVerificationPreference = .preferred
        }

        let assertion = try await Ceremony.run(request)

        // `rawAuthenticatorData` and `signature` are declared implicitly
        // unwrapped by AuthenticationServices, so they are checked rather than
        // trusted: a nil here would be a crash on the sign-in path.
        guard let authenticatorData = assertion.rawAuthenticatorData,
              let signature = assertion.signature
        else { throw Failure.malformedOptions }

        var response: [String: Any] = [
            "clientDataJSON": assertion.rawClientDataJSON.base64URLEncodedString(),
            "authenticatorData": authenticatorData.base64URLEncodedString(),
            "signature": signature.base64URLEncodedString(),
        ]
        // Present for a discoverable credential, absent otherwise. Sending
        // `null` and omitting the key are not the same to the verifier.
        if let userID = assertion.userID { response["userHandle"] = userID.base64URLEncodedString() }

        let id = assertion.credentialID.base64URLEncodedString()
        return [
            "id": id,
            "rawId": id,
            "type": "public-key",
            "response": response,
            "clientExtensionResults": [String: Any](),
        ]
    }
}

// MARK: - Bridging one delegate callback into async/await

/// `ASAuthorizationController` predates async/await and reports through a
/// delegate, so this holds itself alive for exactly one ceremony.
///
/// The strong self-reference is the point: `ASAuthorizationController` does NOT
/// retain its delegate, and an earlier shape that let this deallocate produced
/// a sign-in that hung forever with the system sheet already dismissed.
private final class Ceremony: NSObject, ASAuthorizationControllerDelegate,
                              ASAuthorizationControllerPresentationContextProviding {

    private var continuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?
    private var keepAlive: Ceremony?

    static func run(_ request: ASAuthorizationRequest) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        let ceremony = Ceremony()
        return try await withCheckedThrowingContinuation { continuation in
            ceremony.continuation = continuation
            ceremony.keepAlive = ceremony
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = ceremony
            controller.presentationContextProvider = ceremony
            controller.performRequests()
        }
    }

    /// Resume at most once. A double resume is a crash, not an error, and the
    /// delegate contract does not promise exactly one callback.
    private func finish(_ result: Result<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        self.keepAlive = nil
        continuation.resume(with: result)
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let assertion = authorization.credential
            as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            finish(.failure(Passkeys.Failure.platform(
                "That wasn't a passkey Ajar can use. Sign in at ajar.family instead.")))
            return
        }
        finish(.success(assertion))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish(.failure(Passkeys.humanMessage(for: error)))
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        #if os(iOS)
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        return scene?.keyWindow ?? ASPresentationAnchor()
        #else
        return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
        #endif
    }
}

extension Passkeys {
    /// Turn `ASAuthorizationError` into something a parent can act on.
    ///
    /// The default `localizedDescription` for the common failures is either
    /// empty or a sentence about "the operation" — which is how a missing
    /// associated-domains file reads as a generic bug. Every branch here names
    /// a next step, because there is always one: the browser still works.
    static func humanMessage(for error: Error) -> Failure {
        guard let e = error as? ASAuthorizationError else {
            return .platform("Couldn't finish signing in. \(error.localizedDescription)")
        }
        switch e.code {
        case .canceled:
            return .cancelled
        case .notInteractive:
            return .platform("Unlock this device and try signing in again.")
        case .failed, .invalidResponse, .notHandled, .unknown:
            // Overwhelmingly the domain association: the entitlement, the
            // apple-app-site-association file, or APPLE_APP_IDS. None of those
            // are things a parent can fix, so the message points at the surface
            // that works rather than describing the fault.
            return .platform("Couldn't use your passkey on this device. Sign in at ajar.family instead — your password and passkey both work there.")
        @unknown default:
            return .platform("Couldn't finish signing in. Sign in at ajar.family instead.")
        }
    }
}

// MARK: - base64url

/// WebAuthn is base64URL throughout; Foundation only speaks standard base64.
/// Written out rather than pulled in because this app has no dependencies, and
/// because a subtly wrong decoder here fails as "wrong passkey".
extension Data {
    init?(base64URLEncoded s: String) {
        var b64 = s.replacingOccurrences(of: "-", with: "+")
                   .replacingOccurrences(of: "_", with: "/")
        // Restore the padding base64url strips; without it Foundation returns
        // nil for any input whose length is not a multiple of four.
        let remainder = b64.count % 4
        if remainder > 0 { b64 += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: b64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
