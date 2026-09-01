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

    func signIn(email: String, password: String) async {
        busy = true; defer { busy = false }
        do {
            _ = try await ParentAPI.shared.signIn(email: email, password: password)
            signedIn = true
            error = nil
            await loadFamilies()
        } catch { self.error = error.localizedDescription }
    }

    func signOut() async {
        pollTask?.cancel(); pollTask = nil
        await ParentAPI.shared.signOut()
        UserDefaults.standard.removeObject(forKey: Self.lastFamilyKey)
        signedIn = false; pending = []; children = []; familyId = nil
        families = []; loadedFamilies = false
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
                    await MainActor.run { self?.pending = fresh.filter { $0.status == "PENDING" } }
                    backoff = 1
                } catch {
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
