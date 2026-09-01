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

    /// The label on the primary button — a full sentence about what will happen,
    /// not a chip to decode. "Unlock this video" reads as a decision; "video"
    /// next to a duration pill reads as a form to fill in.
    var actionLabel: String {
        switch self {
        case .thisRequest: return "Unlock just this"
        case .thisURL:     return "Unlock this page"
        case .thisVideo:   return "Unlock this video"
        case .thisChannel: return "Unlock this channel"
        case .thisDomain:  return "Unlock this site"
        case .thisDevice:  return "Unlock on this device"
        case .thisChild:   return "Unlock for this child"
        case .wholeFamily: return "Unlock for everyone"
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
///
/// Hashable is declared HERE rather than in an extension elsewhere: Swift only
/// synthesises `hash(into:)` when the conformance is stated in the same file as
/// the type, and `.minutes(Int)` carries an associated value. An
/// `extension ApprovalDuration: Hashable {}` in another file compiles to
/// "extension outside of file declaring enum ... prevents automatic synthesis".
enum ApprovalDuration: Hashable {
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

/// The long-poll feed's envelope. The endpoint returns an OBJECT with a
/// `requests` key, not a bare array — see `waitForRequests`.
struct PendingRequests: Codable {
    let requests: [AccessRequest]
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

/// One family this parent belongs to, as `/v1/me` reports it.
///
/// `family` is optional because the endpoint returns the membership row joined
/// to the family, and the join can come back null. Falling back to the id would
/// put a uuid in front of a parent, so `label` says "Your family" instead — a
/// generic word beats an identifier nobody recognises.
struct Membership: Codable, Identifiable, Equatable {
    let familyId: String
    let role: String
    let family: Family?

    var id: String { familyId }
    var label: String { family?.name ?? "Your family" }
}

struct Family: Codable, Equatable {
    let id: String
    let name: String
}

/// The signed-in parent. Only the fields this app acts on are decoded.
struct Me: Codable {
    let userId: String
    let email: String?
    let displayName: String?
    let families: [Membership]
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
        adopt(t)
        return t.userId
    }

    /// One place that owns "these are our tokens now" — sign-in and refresh must
    /// not drift on whether the Keychain copy gets updated.
    private func adopt(_ t: TokenResponse) {
        tokens = t
        TokenStore.save(t)
    }

    /// Drop the session locally, without the server round-trip `signOut()` makes.
    /// Used when a refresh is refused: the network call would just fail too.
    private func forgetLocally() {
        tokens = nil
        TokenStore.clear()
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

    /// Who is signed in, and which families they can act in.
    ///
    /// This is what replaced asking a parent to TYPE a family id. The id is a
    /// server-generated uuid that appears nowhere a parent can read, so the text
    /// box it used to sit in was unanswerable: signing in led to a field that
    /// could not be filled.
    func me() async throws -> Me {
        try await send("/v1/me", method: "GET", body: nil)
    }

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
    /// The long-poll feed. Three things here are load-bearing and were all wrong:
    ///
    ///   - The endpoint returns `{ "requests": [...] }`, NOT a bare array
    ///     (openapi.json marks `requests` required). Decoding straight to
    ///     `[AccessRequest]` threw on every single call, and the caller's
    ///     backoff swallowed it — a permanently stale inbox with no error shown.
    ///   - `timeout` is MILLISECONDS server-side (api.ts clamps to 0…60000).
    ///     Sending `25` asked for 25ms, i.e. a hot poll against production.
    ///   - `count` must carry how many pending requests we already know about.
    ///     The server returns immediately unless `pending.length === count`, so
    ///     omitting it (server default -1) defeats the long poll entirely.
    func waitForRequests(familyId: String, knownCount: Int,
                         timeoutSeconds: Int = 25) async throws -> [AccessRequest] {
        let ms = timeoutSeconds * 1000
        let out: PendingRequests = try await send(
            "/v1/families/\(familyId)/requests/wait?timeout=\(ms)&count=\(knownCount)",
            method: "GET", body: nil, timeout: TimeInterval(timeoutSeconds + 10))
        return out.requests
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

    /// Run a request, and on a 401 refresh the access token ONCE and retry.
    ///
    /// Access tokens live an hour (api.ts REFRESH/ACCESS TTLs). Without this the
    /// app worked for sixty minutes and then failed every call forever: nothing
    /// cleared `signedIn`, so the parent saw error text on every action with no
    /// route back except signing out and in. The web console has always done
    /// this (web/parent/app.js `api()`); the app is the surface that regressed.
    ///
    /// Refresh failure is terminal on purpose — the refresh token is revoked or
    /// the user's tokenVersion moved, and retrying cannot help. Clearing tokens
    /// puts the parent on the sign-in screen instead of an unexplained error.
    private func performAuthed(_ build: () throws -> URLRequest) async throws -> Data {
        do {
            return try await perform(try build())
        } catch ParentAPIError.http(401, let message) {
            guard let refresh = tokens?.refreshToken else { throw ParentAPIError.http(401, message) }
            do {
                let renewed: TokenResponse = try await send(
                    "/v1/auth/refresh", method: "POST",
                    body: ["refreshToken": refresh], authed: false, retryOn401: false)
                adopt(renewed)
            } catch {
                forgetLocally()
                throw ParentAPIError.http(401, message)
            }
            return try await perform(try build())  // once, with the fresh token
        }
    }

    private func send<T: Decodable>(_ path: String, method: String, body: [String: Any]?,
                                    authed: Bool = true, timeout: TimeInterval = 30,
                                    retryOn401: Bool = true) async throws -> T {
        let build = { try self.request(path, method: method, body: body, authed: authed, timeout: timeout) }
        let data = authed && retryOn401
            ? try await performAuthed(build)
            : try await perform(try build())
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    private func sendNoContent(_ path: String, method: String, body: [String: Any]?,
                               timeout: TimeInterval = 30) async throws -> Data {
        try await performAuthed { try self.request(path, method: method, body: body, authed: true, timeout: timeout) }
    }
}
