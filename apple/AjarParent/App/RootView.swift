import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: ParentModel
    // Not decoration to skip. Someone with a vestibular disorder set this
    // because motion makes them ill, and the whole-screen crossfade between
    // signed-out and signed-in is exactly the kind it applies to. The web
    // surfaces have honoured `prefers-reduced-motion` globally (tokens.css)
    // since the design system landed; the two apps honoured nothing.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if model.signedIn { RequestsView() } else { SignInView() }
        }
        .animation(reduceMotion ? nil : .default, value: model.signedIn)
    }
}

// MARK: - Sign in

struct SignInView: View {
    @EnvironmentObject var model: ParentModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            VStack(spacing: 6) {
                Text("Ajar").ajarFont(28, .semibold, relativeTo: .title).foregroundStyle(Ajar.ink)
                Text("Approve one thing at a time.")
                    .ajarFont(16).foregroundStyle(Ajar.muted)
            }
            if model.pendingPasskey != nil { passkeyStep } else { passwordStep }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ajar.bg)
    }

    /// The second step, shown only when the password bought a challenge rather
    /// than a session. It is a screen and not a silent retry because the
    /// platform sheet can be dismissed, and a parent who dismisses it needs
    /// somewhere to land that is not the password form they already filled in.
    private var passkeyStep: some View {
        VStack(spacing: 16) {
            Text("One more step")
                .ajarFont(20, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
            Text("Use the passkey you saved for Ajar.")
                .ajarFont(16).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)

            Button {
                Task { await model.finishPasskeySignIn() }
            } label: {
                if model.busy { ProgressView() } else { Text("Use passkey") }
            }
            .buttonStyle(PrimaryButton())
            .frame(maxWidth: 360)
            .disabled(model.busy)

            errorText

            Button("Start again") { model.cancelPasskeySignIn() }
                .buttonStyle(SecondaryButton()).frame(maxWidth: 360)
        }
    }

    private var passwordStep: some View {
        VStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 12) {
                LabeledField("Email") {
                    TextField("you@example.com", text: $email)
                        .textContentType(.emailAddress)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        #endif
                        .autocorrectionDisabled()
                        .accessibilityLabel("Email")
                }
                LabeledField("Password") {
                    SecureField("At least 8 characters", text: $password)
                        .textContentType(.password)
                        .accessibilityLabel("Password")
                }
            }
            .frame(maxWidth: 360)

            Button {
                Task { await model.signIn(email: email, password: password) }
            } label: {
                if model.busy { ProgressView() } else { Text("Sign in") }
            }
            .buttonStyle(PrimaryButton())
            .frame(maxWidth: 360)
            .disabled(model.busy || email.isEmpty || password.isEmpty)

            errorText

            // Password recovery is a link out rather than a screen: the reset
            // lands on the console (PASSWORD_RESET_URL), and duplicating that
            // flow here would mean a second place for it to rot. What must not
            // happen is what happened before — no route at all, on the one
            // credential every account has.
            Link("Forgot your password?", destination: URL(string: "https://ajar.family/parent/#forgot")!)
                .ajarFont(15).foregroundStyle(Ajar.accentInk)
                .frame(minHeight: Ajar.tap)
        }
    }

    /// Errors used to be `Ajar.muted` — quieter than body copy, on the text
    /// that matters most when it appears.
    @ViewBuilder private var errorText: some View {
        if let error = model.error {
            Text(error).ajarFont(15).foregroundStyle(Ajar.err)
                .multilineTextAlignment(.center).frame(maxWidth: 360)
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

// MARK: - The inbox

struct RequestsView: View {
    @EnvironmentObject var model: ParentModel

    var body: some View {
        NavigationStack {
            ZStack {
                Ajar.bg.ignoresSafeArea()
                // Order matters, and the first branch is why. Until /v1/me
                // answers we know nothing: `families` is empty and `familyId`
                // is nil, which is indistinguishable from "no family" and from
                // "several to choose between". Leading with the loaded case and
                // ending with a spinner keeps a half-second of network from
                // rendering an empty picker or a wrong empty state.
                if model.familyId != nil {
                    requestList
                } else if model.hasNoFamily {
                    noFamily
                } else if model.families.count > 1 {
                    familyPicker
                } else if let error = model.error {
                    // The branch that was missing. `hasNoFamily` needs
                    // `loadedFamilies`, which is set only on SUCCESS — so a
                    // failed /v1/me fell through to the spinner below and stayed
                    // there. Launch the app on a train and the screen was grey,
                    // forever, with no message and no way to retry.
                    couldNotLoad(error)
                } else {
                    ProgressView().tint(Ajar.muted)
                }
            }
            .navigationTitle("Waiting on you")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Refresh") { Task { await model.refresh() } }
                        // Only when there is somewhere else to go. On a
                        // single-family account this would be a button that
                        // takes a parent to a screen with one option on it.
                        if model.families.count > 1 {
                            Button("Switch family") { model.switchFamily() }
                        }
                        Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Ajar.ink) }
                }
            }
        }
    }

    /// Nothing loaded, and we know why. A retry rather than a sign-out: the
    /// session is almost certainly fine and the network is not.
    private func couldNotLoad(_ error: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .ajarFont(34, relativeTo: .title).foregroundStyle(Ajar.muted)
                .accessibilityHidden(true)
            Text("Can't reach Ajar")
                .ajarFont(20, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
            Text(error).ajarFont(15).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)
            Button("Try again") { Task { await model.loadFamilies() } }
                .buttonStyle(PrimaryButton()).frame(maxWidth: 360)
        }
        .padding(24)
    }

    @ViewBuilder private var requestList: some View {
        ScrollView {
            // A failure AFTER the list has loaded is different from the branch
            // above: there is real content to keep on screen. It sits over the
            // list rather than replacing it, because `decide()` rolls a failed
            // approval back onto the list — silently, before this — while the
            // parent believed they had said yes.
            if let error = model.error {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(Ajar.err).accessibilityHidden(true)
                    Text(error).ajarFont(15).foregroundStyle(Ajar.err)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.errWash))
                .padding(.horizontal, 16).padding(.top, 12)
            }

            if !model.live {
                // Word AND colour, never colour alone (UX_PRINCIPLES §8).
                Text("Reconnecting…")
                    .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.warn)
                    .padding(.horizontal, 16).padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if model.pending.isEmpty {
                quiet
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(model.pending) { RequestCard(request: $0) }
                }
                .padding(16)
            }
        }
        // The gesture every iOS user tries first, where Refresh was buried in
        // an ellipsis menu.
        .refreshable { await model.refresh() }
    }

    /// Shown ONLY when this parent belongs to more than one family.
    ///
    /// It used to be a text field asking for the family id — a server-generated
    /// uuid that is printed nowhere a parent can read, so the screen could not
    /// be got past. One family is now adopted without asking; this asks only
    /// when there is a real choice, and it asks by NAME.
    private var familyPicker: some View {
        VStack(spacing: 14) {
            Text("Which family?").ajarFont(18, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
            Text("You look after more than one.")
                .ajarFont(16).foregroundStyle(Ajar.muted)
                .padding(.bottom, 4)
            ForEach(model.families) { membership in
                Button(membership.label) { Task { await model.use(familyId: membership.familyId) } }
                    .buttonStyle(PrimaryButton()).frame(maxWidth: 360)
            }
        }
        .padding(24)
    }

    /// Signed in, but the account has no family yet — a real state for a parent
    /// who made an account and stopped. It says where to finish rather than
    /// leaving a blank screen, and does not pretend this app can do it: creating
    /// a family, adding a child and enrolling a device all live in the console.
    private var noFamily: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(Ajar.accentWash).frame(width: 64, height: 64)
                Image(systemName: "house").ajarFont(26, .semibold, relativeTo: .title2)
                    .foregroundStyle(Ajar.accentInk)
            }
            .padding(.bottom, 8)
            Text("No family set up yet").ajarFont(18, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
            Text("Finish setting up at ajar.family, then come back here to answer requests.")
                .ajarFont(16).foregroundStyle(Ajar.muted)
                .multilineTextAlignment(.center)
            Button("Check again") { Task { await model.loadFamilies() } }
                .buttonStyle(PrimaryButton()).frame(maxWidth: 360).padding(.top, 8)
        }
        .padding(40)
    }

    /// Not an empty shrug — reassurance that the thing is working.
    private var quiet: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(Ajar.okWash).frame(width: 64, height: 64)
                Image(systemName: "checkmark").ajarFont(26, .semibold, relativeTo: .title2)
                    .foregroundStyle(Ajar.ok)
            }
            .padding(.bottom, 8)
            Text("Nothing waiting").ajarFont(18, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
            // Two sentences, because only one of them is true at a time. The
            // first was shown unconditionally, including while the long poll
            // was down — promising immediacy the app could not deliver.
            Text(model.live
                 ? "A request lands here the moment one is made."
                 : "Reconnecting. A request may take a moment to show up.")
                .ajarFont(16).foregroundStyle(model.live ? Ajar.muted : Ajar.warn)
                .multilineTextAlignment(.center)
        }
        .padding(40)
    }
}

// MARK: - One waiting request

/// The parent's tax is decision fatigue, not shame: ONE primary action at the
/// narrowest useful scope, with the full choice behind "Change…". This is what
/// replaces a row of six duration buttons.
struct RequestCard: View {
    @EnvironmentObject var model: ParentModel
    let request: AccessRequest
    @State private var showingChange = false

    private var scopes: [ApprovalScope] { ApprovalScope.applicable(to: request.targetType) }
    private var defaultScope: ApprovalScope { scopes.first ?? .thisRequest }

    /// The narrowest useful default, stated in full so nobody decodes a chip.
    ///
    /// Thirty minutes for EVERY target type, including a whole domain. A domain
    /// ask used to default to `.always`, so the one-tap button read "… ·
    /// Always" and a tired thumb wrote a permanent, site-wide standing rule —
    /// on the surface with no Undo and no rules list, findable only in a
    /// browser. UX_PRINCIPLES §3: whatever we preselect IS the policy most of
    /// the time, so it has to be the narrowest useful option, never the
    /// broadest. A longer grant is one tap away in `ChangeSheet`; undoing a
    /// permanent one is not.
    private var defaultDuration: ApprovalDuration { .minutes(30) }

    /// Who asked. The avatar used to be `request.childId.prefix(1)` — the first
    /// character of a UUID — so the card showed a hex digit in a circle and the
    /// child's name appeared nowhere, though `model.children` is loaded on every
    /// refresh. UX_PRINCIPLES §8 names this exact failure: a one-tap decision on
    /// an opaque id is not a decision.
    private var childName: String? {
        model.children.first { $0.id == request.childId }?.displayName
    }

    private var initial: String {
        String((childName ?? "?").prefix(1)).uppercased()
    }

    /// `Jane · 4 min ago`, matching the console. The raw ISO-8601 timestamp was
    /// here before; the name half is dropped rather than faked when the child
    /// is not in the roster yet.
    private var byline: String {
        let when = Self.ago(request.createdAt)
        guard let name = childName else { return when }
        return "\(name) · \(when)"
    }

    /// Two formatters, tried in order.
    ///
    /// `ISO8601DateFormatter` is all-or-nothing about fractional seconds: the
    /// one that parses `…:10.812Z` refuses `…:10Z` and vice versa. The backend
    /// writes `toISOString()` (fractional) today, but the audit log and the
    /// stores are not one code path, and a formatter that silently returns nil
    /// here shows the raw timestamp again — the bug this is fixing.
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    private static func parse(_ iso: String) -> Date? {
        withFraction.date(from: iso) ?? plain.date(from: iso)
    }

    /// Elapsed time in the words the console uses (`app.js` `ago()`), ported so
    /// the two surfaces do not describe the same instant differently.
    ///
    /// Falls back to the raw string rather than to "now": an unparseable
    /// timestamp displayed as "just now" would misdate every ask on the screen.
    /// Word for word and rounding for rounding the same as `app.js:688-695`,
    /// including treating a negative interval as "just now" — a device clock a
    /// few seconds ahead of the server must not print "in 3 minutes".
    static func ago(_ iso: String) -> String {
        guard let then = Self.parse(iso) else { return iso }
        let s = Date().timeIntervalSince(then)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int((s / 60).rounded())) min ago" }
        if s < 86400 { return "\(Int((s / 3600).rounded())) h ago" }
        return "\(Int((s / 86400).rounded())) d ago"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Ajar.accentWash).frame(width: 40, height: 40)
                    Text(initial)
                        .ajarFont(16, .semibold).foregroundStyle(Ajar.accentInk)
                }
                .accessibilityHidden(true)   // the name is read out below
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.title ?? request.targetValue)
                        .ajarFont(18, .semibold, relativeTo: .title3).foregroundStyle(Ajar.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(byline).ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            if let reason = request.reason, !reason.isEmpty {
                Text("“\(reason)”")
                    .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface2))
            }

            Button("\(defaultScope.actionLabel) · \(defaultDuration.label)") {
                Task { await model.decide(request, allow: true, scope: defaultScope, duration: defaultDuration) }
            }
            .buttonStyle(PrimaryButton())

            HStack(spacing: 8) {
                Button("Change…") { showingChange = true }.buttonStyle(SecondaryButton())
                // NARROWEST possible refusal, never `defaultScope`/`defaultDuration`.
                // For a DOMAIN ask those are THIS_DOMAIN + ALWAYS, so the softest
                // button on the screen minted a permanent, site-wide block — with
                // no undo on this surface. The web console was fixed for exactly
                // this (app.js: BLOCK / THIS_REQUEST / ONCE); the phone, which is
                // where a tired parent actually decides, was missed.
                //
                // A refusal should be the one thing in this product that is easy
                // to revisit: a permanent invisible block is a door that never
                // opens again and that the child is never told about.
                Button("Not now") {
                    Task { await model.decide(request, allow: false, scope: .thisRequest, duration: .once) }
                }
                .buttonStyle(SecondaryButton(quiet: true))
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14).fill(Ajar.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Ajar.line, lineWidth: 1))
        .sheet(isPresented: $showingChange) {
            ChangeSheet(request: request, scopes: scopes,
                        scope: defaultScope, duration: defaultDuration)
                .environmentObject(model)
        }
    }
}

// MARK: - The full decision, only when asked for

struct ChangeSheet: View {
    @EnvironmentObject var model: ParentModel
    @Environment(\.dismiss) private var dismiss
    let request: AccessRequest
    let scopes: [ApprovalScope]
    @State var scope: ApprovalScope
    @State var duration: ApprovalDuration

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("How much to unlock")
                    .ajarFont(22, .semibold, relativeTo: .title2).foregroundStyle(Ajar.ink)
                Text(request.title ?? request.targetValue)
                    .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.muted)
                    .padding(.top, 4).padding(.bottom, 24)

                Text("What").ajarFont(14, .semibold, relativeTo: .footnote)
                    .foregroundStyle(Ajar.ink2).padding(.bottom, 8)
                // Only scopes this target can MATCH — see ApprovalScope.applicable.
                VStack(spacing: 8) {
                    ForEach(scopes, id: \.self) { s in
                        row(s.label, selected: s == scope) { scope = s }
                    }
                }
                .padding(.bottom, 24)

                Text("For how long").ajarFont(14, .semibold, relativeTo: .footnote)
                    .foregroundStyle(Ajar.ink2).padding(.bottom, 8)
                VStack(spacing: 8) {
                    ForEach(ApprovalDuration.choices, id: \.self) { d in
                        row(d.label, selected: d == duration) { duration = d }
                    }
                }
                .padding(.bottom, 28)

                Button("\(scope.actionLabel) · \(duration.label)") {
                    Task { await model.decide(request, allow: true, scope: scope, duration: duration); dismiss() }
                }
                .buttonStyle(PrimaryButton())
            }
            .padding(24)
        }
        .background(Ajar.bg)
    }

    private func row(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(selected ? Ajar.accentStrong : Ajar.fieldLine, lineWidth: 2)
                        .frame(width: 20, height: 20)
                    if selected { Circle().fill(Ajar.accentStrong).frame(width: 10, height: 10) }
                }
                Text(label).ajarFont(16, selected ? .medium : .regular)
                    .foregroundStyle(selected ? Ajar.ink : Ajar.ink2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).frame(minHeight: Ajar.tapLarge)
            .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
            .overlay(RoundedRectangle(cornerRadius: 10)
                .stroke(selected ? Ajar.accentStrong : Ajar.line, lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - A field with a label that stays

/// A visible label above the control, and an example inside it.
///
/// Both apps used the placeholder AS the label — `TextField("Email", …)` — which
/// UX_PRINCIPLES §8 requirement 4 forbids and which the web console has always
/// got right. The failure is not the screen reader (SwiftUI does expose the
/// title): it is that the label vanishes the moment anyone types, so a field
/// that was "Password" becomes an unlabelled box of dots, and a form returned to
/// after an interruption has nothing on it saying what goes where.
///
/// The placeholder is now an EXAMPLE, which is what a placeholder is for.
struct LabeledField<Content: View>: View {
    private let label: String
    private let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).ajarFont(14).foregroundStyle(Ajar.ink2)
            content
                .ajarFont(16)
                .padding(.horizontal, 14)
                .frame(minHeight: Ajar.tap)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ajar.fieldLine, lineWidth: 1))
        }
    }
}
