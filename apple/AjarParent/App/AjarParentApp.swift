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
    @Published var children: [Child] = []
    @Published var pending: [AccessRequest] = []
    @Published var error: String?
    @Published var busy = false

    private var pollTask: Task<Void, Never>?

    func restore() async {
        await ParentAPI.shared.restore()
        signedIn = await ParentAPI.shared.isSignedIn
        if signedIn { await refresh() }
    }

    func signIn(email: String, password: String) async {
        busy = true; defer { busy = false }
        do {
            _ = try await ParentAPI.shared.signIn(email: email, password: password)
            signedIn = true
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func signOut() async {
        pollTask?.cancel(); pollTask = nil
        await ParentAPI.shared.signOut()
        signedIn = false; pending = []; children = []; familyId = nil
    }

    func use(familyId id: String) async {
        familyId = id
        await refresh()
        startPolling()
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
                    let fresh = try await ParentAPI.shared.waitForRequests(familyId: familyId)
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
