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

struct SignInView: View {
    @EnvironmentObject var model: ParentModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            VStack(spacing: 6) {
                Text("Ajar").font(.largeTitle.weight(.semibold))
                Text("Approve one thing at a time.")
                    .font(.callout).foregroundStyle(.secondary)
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
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 360)

            Button {
                Task { await model.signIn(email: email, password: password) }
            } label: {
                if model.busy { ProgressView() } else { Text("Sign in").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: 360)
            .disabled(model.busy || email.isEmpty || password.isEmpty)

            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .multilineTextAlignment(.center).frame(maxWidth: 360)
            }
            Spacer()
        }
        .padding()
    }
}

struct RequestsView: View {
    @EnvironmentObject var model: ParentModel
    @State private var familyIdField = ""

    var body: some View {
        NavigationStack {
            Group {
                if model.familyId == nil {
                    // Until the family picker exists, the id is entered once and
                    // then remembered by the model for the session.
                    VStack(spacing: 14) {
                        Text("Which family?").font(.headline)
                        TextField("Family id", text: $familyIdField)
                            .textFieldStyle(.roundedBorder).frame(maxWidth: 360)
                            .autocorrectionDisabled()
                        Button("Continue") { Task { await model.use(familyId: familyIdField) } }
                            .buttonStyle(.borderedProminent)
                            .disabled(familyIdField.isEmpty)
                    }.padding()
                } else if model.pending.isEmpty {
                    ContentUnavailableView("Nothing waiting",
                        systemImage: "checkmark.circle",
                        description: Text("New requests appear here the moment they are made."))
                } else {
                    List(model.pending) { RequestRow(request: $0) }
                        .listStyle(.plain)
                }
            }
            .navigationTitle("Requests")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Refresh") { Task { await model.refresh() } }
                        Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
    }
}

/// One waiting request, and the decision.
///
/// The scope choices are derived from the target type, never a fixed list: a
/// scope the target cannot match produces a rule that silently never applies —
/// the parent sees "approved" and the child stays blocked.
struct RequestRow: View {
    @EnvironmentObject var model: ParentModel
    let request: AccessRequest

    @State private var scope: ApprovalScope = .thisRequest
    @State private var duration: ApprovalDuration = .minutes(30)

    private var scopes: [ApprovalScope] { ApprovalScope.applicable(to: request.targetType) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(request.title ?? request.targetValue)
                    .font(.headline).lineLimit(2)
                if let url = request.url {
                    Text(url).font(.caption.monospaced())
                        .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if let reason = request.reason, !reason.isEmpty {
                    Text("“\(reason)”").font(.callout).italic().foregroundStyle(.secondary)
                }
            }

            if scopes.count > 1 {
                Picker("Allow", selection: $scope) {
                    ForEach(scopes, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            } else {
                Text(scopes.first?.label ?? "Just this")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Picker("For", selection: $duration) {
                ForEach(ApprovalDuration.choices, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 10) {
                Button("Not now") {
                    Task { await model.decide(request, allow: false, scope: scope, duration: duration) }
                }
                .buttonStyle(.bordered)

                Button("Allow") {
                    Task { await model.decide(request, allow: true, scope: scope, duration: duration) }
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
        .padding(.vertical, 10)
        .onAppear { scope = scopes.first ?? .thisRequest }
    }
}

extension ApprovalDuration: Hashable {}
