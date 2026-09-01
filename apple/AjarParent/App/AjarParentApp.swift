import SwiftUI

@main
struct AjarParentApp: App {
    @StateObject private var model = ParentModel()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).task { await model.restore() }
        }
        #if os(macOS)
        .defaultSize(width: 520, height: 680)
        #endif
    }
}

/// One observable model for the whole app. The parent-facing surface is small —
/// sign in, watch the pending feed, decide — so a single model keeps the flow
/// legible rather than spreading four screens of state across view models.
@MainActor
final class ParentModel: ObservableObject {
    @Published var signedIn = false
    @Published var familyId: String?
    /// Every family this parent can act in. Empty until `/v1/me` answers.
    @Published var families: [Membership] = []
    @Published var children: [Child] = []
    @Published var pending: [AccessRequest] = []
    @Published var error: String?
    @Published var busy = false

    /// True only when the parent genuinely has a choice to make. One family is
    /// not a choice, and no families is a different screen entirely.
    var needsFamilyChoice: Bool { signedIn && familyId == nil && families.count > 1 }
    /// Signed in, and the account has no family at all yet.
    var hasNoFamily: Bool { signedIn && families.isEmpty && loadedFamilies }

    /// Set between the password and the passkey. Non-nil means sign-in is
    /// half done and the screen must say so.
    @Published var pendingPasskey: MFAChallenge?

    /// Whether the long poll is currently connected.
    ///
    /// The loop below used to swallow every failure with no indicator at all,
    /// so the empty state kept promising *"A request lands here the moment one
    /// is made"* while disconnected — a promise the app could not keep and did
    /// not know it was breaking. The web console has always shown this
    /// (`app.js` `setLive()`, rendered as word AND colour, never colour alone).
    @Published var live = true

    private var loadedFamilies = false
    private var pollTask: Task<Void, Never>?

    /// The last family this parent chose, so a relaunch does not re-ask. Not a
    /// credential — an id already in every request this app makes — so
    /// UserDefaults is the right home for it, unlike the tokens next door.
    private static let lastFamilyKey = "parent.lastFamilyId"

    func restore() async {
        await ParentAPI.shared.restore()
        signedIn = await ParentAPI.shared.isSignedIn
        if signedIn { await loadFamilies() }
    }

    /// Step one. A password is not always a session: an account with a passkey
    /// enrolled gets back a challenge, and this is where the app used to render
    /// a `DecodingError` and strand the parent.
    func signIn(email: String, password: String) async {
        busy = true; defer { busy = false }
        do {
            switch try await ParentAPI.shared.signIn(email: email, password: password) {
            case .session:
                await adoptSession()
            case .passkeyNeeded(let challenge):
                guard challenge.canFinishHere else {
                    self.error = "This account needs a security key Ajar can't use on this device yet. Sign in at ajar.family."
                    return
                }
                error = nil
                // Straight into the platform sheet rather than parking on a
                // "now use your passkey" screen: the parent has just typed a
                // password and the second step is one Face ID away. `pending`
                // survives so a cancel lands back on a usable button.
                pendingPasskey = challenge
                await finishPasskeySignIn()
            }
        } catch { self.error = error.localizedDescription }
    }

    /// Step two. Kept separate so "Try your passkey again" after a cancel does
    /// not re-send the password.
    func finishPasskeySignIn() async {
        guard let challenge = pendingPasskey else { return }
        busy = true; defer { busy = false }
        do {
            let options = try await ParentAPI.shared.passkeyLoginOptions(mfaToken: challenge.mfaToken)
            let credential = try await Passkeys.signIn(optionsJSON: options)
            _ = try await ParentAPI.shared.finishPasskeyLogin(mfaToken: challenge.mfaToken, credential: credential)
            pendingPasskey = nil
            await adoptSession()
        } catch Passkeys.Failure.cancelled {
            // Not an error to shout about — the parent chose it. The retry
            // button stays on screen because `pendingPasskey` is untouched.
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Abandon a half-finished sign-in. The `mfa` token expires on its own, but
    /// leaving the passkey step on screen with no way out is a dead end.
    func cancelPasskeySignIn() {
        pendingPasskey = nil
        error = nil
    }

    private func adoptSession() async {
        signedIn = true
        pendingPasskey = nil
        error = nil
        await loadFamilies()
    }

    func signOut() async {
        pollTask?.cancel(); pollTask = nil
        await ParentAPI.shared.signOut()
        UserDefaults.standard.removeObject(forKey: Self.lastFamilyKey)
        signedIn = false; pending = []; children = []; familyId = nil
        families = []; loadedFamilies = false; pendingPasskey = nil; live = true
    }

    /// Ask the server which families this parent belongs to, then pick one
    /// WITHOUT asking whenever there is nothing to ask about.
    ///
    /// This replaced a text field that wanted the family id typed in. The id is
    /// a server-generated uuid printed nowhere a parent can see, so that field
    /// could not be filled: signing in led straight to a dead end.
    ///
    /// Order matters. The remembered family is preferred, but only if it is
    /// still one this account belongs to — a parent removed from a family must
    /// not keep landing in it. Otherwise a single family is adopted silently,
    /// and only a genuine multi-family account is asked.
    func loadFamilies() async {
        do {
            let me = try await ParentAPI.shared.me()
            families = me.families
            loadedFamilies = true
            error = nil
        } catch {
            self.error = error.localizedDescription
            return
        }

        let remembered = UserDefaults.standard.string(forKey: Self.lastFamilyKey)
        if let remembered, families.contains(where: { $0.familyId == remembered }) {
            await use(familyId: remembered)
        } else if families.count == 1, let only = families.first {
            await use(familyId: only.familyId)
        }
        // More than one and nothing remembered: RequestsView shows the picker.
    }

    func use(familyId id: String) async {
        familyId = id
        UserDefaults.standard.set(id, forKey: Self.lastFamilyKey)
        await refresh()
        startPolling()
    }

    /// Go back to the picker. Only reachable when there is more than one family,
    /// because otherwise it would strand a parent on a screen with one button.
    func switchFamily() {
        pollTask?.cancel(); pollTask = nil
        UserDefaults.standard.removeObject(forKey: Self.lastFamilyKey)
        familyId = nil; pending = []; children = []
    }

    func refresh() async {
        guard let familyId else { return }
        do {
            async let kids = ParentAPI.shared.children(familyId: familyId)
            async let reqs = ParentAPI.shared.pendingRequests(familyId: familyId)
            children = try await kids
            pending = try await reqs
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    /// Long-poll so an approval feels immediate rather than arriving on a timer.
    /// A timeout is a normal ending, not a failure: loop again. Any other error
    /// backs off, so a server outage does not become a hot request loop.
    private func startPolling() {
        pollTask?.cancel()
        guard let familyId else { return }
        pollTask = Task { [weak self] in
            var backoff: UInt64 = 1
            while !Task.isCancelled {
                do {
                    // The server holds the connection open only while the count
                    // it sees still matches what we already have, so this has to
                    // be the CURRENT pending count or the poll returns instantly.
                    let known = await MainActor.run { self?.pending.count ?? 0 }
                    let fresh = try await ParentAPI.shared.waitForRequests(
                        familyId: familyId, knownCount: known)
                    guard !Task.isCancelled else { return }
                    await MainActor.run {
                        self?.pending = fresh.filter { $0.status == "PENDING" }
                        self?.live = true
                    }
                    backoff = 1
                } catch {
                    // Cancellation is this task being torn down (sign out,
                    // family switch), not a connection problem — flagging it
                    // would leave "reconnecting…" on a screen nobody is on.
                    if Task.isCancelled { return }
                    await MainActor.run { self?.live = false }
                    try? await Task.sleep(for: .seconds(backoff))
                    backoff = min(backoff * 2, 30)
                }
            }
        }
    }

    func decide(_ request: AccessRequest, allow: Bool,
                scope: ApprovalScope, duration: ApprovalDuration) async {
        guard let familyId else { return }
        busy = true; defer { busy = false }
        // Optimistic: the child is waiting, so the row should leave immediately.
        // Restored on failure rather than silently dropped.
        let previous = pending
        pending.removeAll { $0.id == request.id }
        do {
            try await ParentAPI.shared.decide(familyId: familyId, requestId: request.id,
                                              allow: allow, scope: scope, duration: duration)
        } catch {
            pending = previous
            self.error = error.localizedDescription
        }
    }
}
