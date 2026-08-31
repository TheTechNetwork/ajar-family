import Foundation

/// Parent-side client for the Ajar backend.
///
/// Mirrors backend/openapi.json exactly — the shapes here were generated from it
/// rather than guessed, because a client that invents a field silently sends
/// nothing and the parent sees an approval that never arrives.
enum ParentAPIError: LocalizedError {
    case http(Int, String)
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Signed out."
        // The server distinguishes a deliberate refusal from a bug: a
        // DomainError carries a message written to be read, anything else is a
        // generic 500. Show the message when there is one.
        case .http(let code, let message):
            return message.isEmpty ? "Server error (\(code))." : message
        }
    }
}

// MARK: - Wire types

struct TokenResponse: Codable {
    let userId: String
    let expiresIn: Int
    let accessToken: String
    let refreshToken: String
}

enum PolicyTargetType: String, Codable {
    case url = "URL", urlPattern = "URL_PATTERN", domain = "DOMAIN"
    case youtubeVideo = "YOUTUBE_VIDEO", youtubeChannel = "YOUTUBE_CHANNEL"
    case youtubePlaylist = "YOUTUBE_PLAYLIST", category = "CATEGORY", application = "APPLICATION"
}

enum ApprovalScope: String, Codable, CaseIterable {
    case thisRequest = "THIS_REQUEST", thisURL = "THIS_URL", thisVideo = "THIS_VIDEO"
    case thisChannel = "THIS_CHANNEL", thisDomain = "THIS_DOMAIN"
    case thisDevice = "THIS_DEVICE", thisChild = "THIS_CHILD", wholeFamily = "WHOLE_FAMILY"

    /// The scopes that can actually MATCH a given target.
    ///
    /// This is not cosmetic. Offering a scope the target cannot produce is how
    /// the backend once minted an unmatchable rule: the parent saw "Unlocked"
    /// and the child stayed blocked. Keep in step with `applicableScopes` in
    /// backend/src/domain/services.ts.
    static func applicable(to target: PolicyTargetType) -> [ApprovalScope] {
        switch target {
        case .youtubeVideo:    return [.thisVideo, .thisChannel]
        case .youtubeChannel:  return [.thisChannel]
        case .youtubePlaylist: return [.thisRequest]
        case .url, .urlPattern: return [.thisURL, .thisDomain]
        case .domain:          return [.thisDomain]
        case .category, .application: return [.thisRequest]
        }
    }

    var label: String {
        switch self {
        case .thisRequest: return "Just this"
        case .thisURL:     return "This page"
        case .thisVideo:   return "This video only"
        case .thisChannel: return "This whole channel"
        case .thisDomain:  return "This whole site"
        case .thisDevice:  return "This device"
        case .thisChild:   return "This child"
        case .wholeFamily: return "Everyone"
        }
    }
}

/// `oneOf` in the schema; encoded as a tagged object.
enum ApprovalDuration: Equatable {
    case minutes(Int)
    case untilEndOfDay
    case once
    case always

    var label: String {
        switch self {
        case .minutes(let m) where m % 60 == 0: return "\(m / 60)h"
        case .minutes(let m): return "\(m) min"
        case .untilEndOfDay: return "Today"
        case .once: return "Once"
        case .always: return "Always"
        }
    }

    var json: [String: Any] {
        switch self {
        case .minutes(let m):  return ["kind": "MINUTES", "minutes": m]
        case .untilEndOfDay:   return ["kind": "UNTIL_END_OF_DAY"]
        case .once:            return ["kind": "ONCE"]
        case .always:          return ["kind": "ALWAYS"]
        }
    }

    static let choices: [ApprovalDuration] =
        [.once, .minutes(30), .minutes(120), .untilEndOfDay, .always]
}

struct AccessRequest: Codable, Identifiable, Equatable {
    let id: String
    let familyId: String
    let childId: String
    let deviceId: String
    let targetType: PolicyTargetType
    let targetValue: String
    let title: String?
    let url: String?
    let reason: String?
    let status: String
    let createdAt: String
}

struct Child: Codable, Identifiable, Equatable {
    let id: String
    let displayName: String
    let timezone: String
}

// MARK: - Client

actor ParentAPI {
    static let shared = ParentAPI()

    /// Same origin the filter app talks to (docs/DEPLOYMENT.md). The block page
    /// lives on blocked.ajar.family; the API is deliberately NOT served there.
    private let base = URL(string: "https://api.ajar.family")!
    private var tokens: TokenResponse?

    var isSignedIn: Bool { tokens != nil }

    // MARK: Auth

    func signIn(email: String, password: String) async throws -> String {
        let t: TokenResponse = try await send("/v1/auth/login", method: "POST",
                                              body: ["email": email, "password": password], authed: false)
        tokens = t
        TokenStore.save(t)
        return t.userId
    }

    func restore() { tokens = TokenStore.load() }

    func signOut() async {
        // Best effort: revoke server-side, but always clear locally. A failed
        // network call must not leave a signed-in-looking app.
        _ = try? await sendNoContent("/v1/auth/logout", method: "POST", body: [:])
        tokens = nil
        TokenStore.clear()
    }

    // MARK: The core loop

    func children(familyId: String) async throws -> [Child] {
        try await send("/v1/families/\(familyId)/children", method: "GET", body: nil)
    }

    func pendingRequests(familyId: String) async throws -> [AccessRequest] {
        let all: [AccessRequest] = try await send(
            "/v1/families/\(familyId)/requests", method: "GET", body: nil)
        return all.filter { $0.status == "PENDING" }
    }

    /// Long-poll: returns when the pending feed changes, or empty on timeout.
    /// The timeout is not an error — it is how a long poll ends when nothing
    /// happened, and the caller simply asks again.
    func waitForRequests(familyId: String, timeoutSeconds: Int = 25) async throws -> [AccessRequest] {
        try await send("/v1/families/\(familyId)/requests/wait?timeout=\(timeoutSeconds)",
                       method: "GET", body: nil, timeout: TimeInterval(timeoutSeconds + 10))
    }

    func decide(familyId: String, requestId: String, allow: Bool,
                scope: ApprovalScope, duration: ApprovalDuration) async throws {
        _ = try await sendNoContent(
            "/v1/families/\(familyId)/requests/\(requestId)/decide", method: "POST",
            body: ["decision": allow ? "ALLOW" : "BLOCK",
                   "scope": scope.rawValue,
                   "duration": duration.json])
    }

    // MARK: Transport

    private func request(_ path: String, method: String, body: [String: Any]?,
                         authed: Bool, timeout: TimeInterval) throws -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path))
        // appendingPathComponent percent-escapes the query, so build it by hand
        // when there is one.
        if path.contains("?") { r = URLRequest(url: URL(string: base.absoluteString + path)!) }
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        if authed {
            guard let t = tokens else { throw ParentAPIError.notSignedIn }
            r.setValue("Bearer \(t.accessToken)", forHTTPHeaderField: "authorization")
        }
        if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
        return r
    }

    private func perform(_ r: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ParentAPIError.http(code, message ?? "")
        }
        return data
    }

    private func send<T: Decodable>(_ path: String, method: String, body: [String: Any]?,
                                    authed: Bool = true, timeout: TimeInterval = 30) async throws -> T {
        let data = try await perform(try request(path, method: method, body: body, authed: authed, timeout: timeout))
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    private func sendNoContent(_ path: String, method: String, body: [String: Any]?,
                               timeout: TimeInterval = 30) async throws -> Data {
        try await perform(try request(path, method: method, body: body, authed: true, timeout: timeout))
    }
}
