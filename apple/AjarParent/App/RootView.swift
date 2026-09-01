import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: ParentModel

    var body: some View {
        Group {
            if model.signedIn { RequestsView() } else { SignInView() }
        }
        .animation(.default, value: model.signedIn)
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
                Text("Ajar").font(.system(size: 28, weight: .semibold)).foregroundStyle(Ajar.ink)
                Text("Approve one thing at a time.")
                    .font(.system(size: 16)).foregroundStyle(Ajar.muted)
            }
            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(.password)
            }
            .font(.system(size: 16))
            .padding(.horizontal, 14)
            .frame(minHeight: Ajar.tap)
            .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ajar.fieldLine, lineWidth: 1))
            .frame(maxWidth: 360)

            Button {
                Task { await model.signIn(email: email, password: password) }
            } label: {
                if model.busy { ProgressView() } else { Text("Sign in") }
            }
            .buttonStyle(PrimaryButton())
            .frame(maxWidth: 360)
            .disabled(model.busy || email.isEmpty || password.isEmpty)

            if let error = model.error {
                Text(error).font(.system(size: 14)).foregroundStyle(Ajar.muted)
                    .multilineTextAlignment(.center).frame(maxWidth: 360)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ajar.bg)
    }
}

// MARK: - The inbox

struct RequestsView: View {
    @EnvironmentObject var model: ParentModel
    @State private var familyIdField = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Ajar.bg.ignoresSafeArea()
                if model.familyId == nil {
                    familyPrompt
                } else if model.pending.isEmpty {
                    quiet
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(model.pending) { RequestCard(request: $0) }
                        }
                        .padding(16)
                    }
                }
            }
            .navigationTitle("Waiting on you")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Refresh") { Task { await model.refresh() } }
                        Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Ajar.ink) }
                }
            }
        }
    }

    private var familyPrompt: some View {
        VStack(spacing: 14) {
            Text("Which family?").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ajar.ink)
            TextField("Family id", text: $familyIdField)
                .font(.system(size: 16)).autocorrectionDisabled()
                .padding(.horizontal, 14).frame(minHeight: Ajar.tap).frame(maxWidth: 360)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ajar.fieldLine, lineWidth: 1))
            Button("Continue") { Task { await model.use(familyId: familyIdField) } }
                .buttonStyle(PrimaryButton()).frame(maxWidth: 360)
                .disabled(familyIdField.isEmpty)
        }
        .padding(24)
    }

    /// Not an empty shrug — reassurance that the thing is working.
    private var quiet: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(Ajar.okWash).frame(width: 64, height: 64)
                Image(systemName: "checkmark").font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Ajar.ok)
            }
            .padding(.bottom, 8)
            Text("Nothing waiting").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ajar.ink)
            Text("A request lands here the moment one is made.")
                .font(.system(size: 16)).foregroundStyle(Ajar.muted)
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
    private var defaultDuration: ApprovalDuration {
        request.targetType == .domain ? .always : .minutes(30)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Ajar.accentWash).frame(width: 40, height: 40)
                    Text(String(request.childId.prefix(1)).uppercased())
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Ajar.accentInk)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.title ?? request.targetValue)
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(Ajar.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(request.createdAt).font(.system(size: 14)).foregroundStyle(Ajar.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            if let reason = request.reason, !reason.isEmpty {
                Text("“\(reason)”")
                    .font(.system(size: 14)).foregroundStyle(Ajar.ink2)
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
                Button("Not now") {
                    Task { await model.decide(request, allow: false, scope: defaultScope, duration: defaultDuration) }
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
                    .font(.system(size: 22, weight: .semibold)).foregroundStyle(Ajar.ink)
                Text(request.title ?? request.targetValue)
                    .font(.system(size: 14)).foregroundStyle(Ajar.muted)
                    .padding(.top, 4).padding(.bottom, 24)

                Text("What").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Ajar.ink2).padding(.bottom, 8)
                // Only scopes this target can MATCH — see ApprovalScope.applicable.
                VStack(spacing: 8) {
                    ForEach(scopes, id: \.self) { s in
                        row(s.label, selected: s == scope) { scope = s }
                    }
                }
                .padding(.bottom, 24)

                Text("For how long").font(.system(size: 14, weight: .semibold))
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
                Text(label).font(.system(size: 16, weight: selected ? .medium : .regular))
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
