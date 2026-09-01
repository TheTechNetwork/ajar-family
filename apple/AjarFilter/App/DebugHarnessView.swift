import SwiftUI

// The whole file is DEBUG-only, so a release binary carries no harness at all.
//
// CORRECTION. The commit that added this guard claimed Release builds of
// AjarFilter could not compile without it, because the harness drives DEBUG-only
// members of FilterController (seedDefaultDenyYouTube, grantTemporary, the flow
// log). That was wrong. Every one of those call sites was ALREADY individually
// wrapped in #if DEBUG below, and TestFlight run 8 archived -configuration
// Release from commit 7360050 and uploaded successfully with this exact code in
// it. There was no latent break, and the archive that would supposedly have
// found it had already passed.
//
// The guard stays because it is still worth having — one gate at the top beats
// three inside, and it keeps a screen of engineering switches out of the shipped
// binary rather than merely unreachable in it. That is a smaller claim than the
// one it was committed under.
#if DEBUG

/// The PoC A harness — the raw levers that drove the on-device experiments in
/// docs/APPLE_CONTENT_FILTER_POC.md (self-test vectors, base URL, enrolment
/// code, seeded rules, the flow log).
///
/// It is NOT the product UI; `ContentView` is. It is kept because A4-A6 are
/// still unrun and this is what runs them, and it is reachable only from a debug
/// build, so a tester never lands on a screen of engineering switches.
struct DebugHarnessView: View {
    // Takes the app's controller rather than making its own. Two
    // FilterControllers would both own NEFilterManager.shared and the same
    // on-disk snapshot store, so the harness would report state the product
    // screens don't have — the worst possible property in a debugging tool.
    @ObservedObject var controller: FilterController
    @State private var baseURL = ""
    @State private var enrollCode = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("0 · Compatibility self-test (run this first)") {
                    Button("Run cross-platform vectors") { controller.runSelfTest() }
                    if controller.selfTestRan {
                        if controller.selfTestFailures.isEmpty {
                            Label("All vectors passed", systemImage: "checkmark.seal")
                                .foregroundStyle(.green)
                        } else {
                            ForEach(Array(controller.selfTestFailures.enumerated()), id: \.offset) { _, f in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.name).font(.footnote.bold()).foregroundStyle(.red)
                                    Text(f.detail).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Text("Canonical-JSON parity and Bloom parity are all-or-nothing; a failure here means policy or category enforcement is silently wrong.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("1 · Authorization (.child)") {
                    Text("Status: \(String(describing: controller.authorizationStatus))")
                    Button("Request .child authorization") {
                        Task { await controller.requestChildAuthorization() }
                    }
                }
                Section("2 · Filter") {
                    Text(controller.filterEnabled ? "Enabled" : "Disabled")
                    Button("Enable content filter") { Task { await controller.enableFilter() } }
                    #if DEBUG
                    Button("Seed: default-deny YouTube + BLOCK category:social") {
                        controller.seedDefaultDenyYouTube()
                    }
                    #endif
                    if controller.tamperDetected {
                        Label("Cached policy failed verification — re-fetch from the backend",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
                #if DEBUG
                Section("3 · Temporary approval (A4/A5)") {
                    Button("Approve \(FilterController.blockedVideo) for 30s") {
                        controller.grantTemporary(videoId: FilterController.blockedVideo, seconds: 30)
                    }
                    Text("Then open it in Safari, confirm it plays, and that it is blocked again after 30s.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                #endif
                Section("5 · Backend (the real, signed path)") {
                    TextField("https://backend.example", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("Save backend URL") { controller.setBaseURL(baseURL) }

                    if controller.isEnrolled {
                        Label("Enrolled", systemImage: "checkmark.seal").foregroundStyle(.green)
                        Text("Policy version: \(controller.policyVersion.map(String.init) ?? "none")")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Sync policy now") { Task { await controller.syncPolicy() } }
                        Button("Wait for a parent's decision (long poll)") {
                            Task { await controller.waitForPolicyChange() }
                        }
                        Button("Sign this device out", role: .destructive) { controller.signOutDevice() }
                    } else {
                        TextField("Enrollment code", text: $enrollCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Enroll this device") {
                            Task { await controller.enroll(code: enrollCode, displayName: "This device") }
                        }
                    }

                    if let status = controller.backendStatus {
                        Text(status).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let req = controller.lastRequest {
                        Text("Last request: \(req)").font(.caption2).foregroundStyle(.secondary)
                    }
                    Text("Enrolling installs the backend's signing key, which is what moves this device off the local unsigned policy onto verified snapshots.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Try in Safari") {
                    Label("ALLOWED: youtube.com/watch?v=\(FilterController.allowedVideo)", systemImage: "checkmark.circle")
                    Label("BLOCKED: youtube.com/watch?v=\(FilterController.blockedVideo)", systemImage: "xmark.octagon")
                    Label("BLOCKED by CATEGORY: tiktok.com, reddit.com", systemImage: "xmark.octagon")
                    Label("ALWAYS ALLOWED (safety floor, never logged): 988lifeline.org",
                          systemImage: "lifepreserver")
                }
                #if DEBUG
                Section("4 · Observed flows — A1/A2 evidence") {
                    HStack {
                        Button("Refresh") { controller.refreshFlowLog() }
                        Spacer()
                        Button("Clear") { controller.clearFlowLog() }
                    }
                    if controller.flowRows.isEmpty {
                        Text("Empty. Browse in Safari, then Refresh. If this stays empty the data provider cannot write to the App Group — which is itself the A2 finding.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(controller.flowRows.enumerated()), id: \.offset) { _, row in
                            let parts = row.split(separator: "\t", omittingEmptySubsequences: false)
                            VStack(alignment: .leading, spacing: 1) {
                                if parts.count >= 5 {
                                    Text("\(parts[1]) · \(parts[2]) · \(parts[3])")
                                        .font(.caption2.bold())
                                    Text(String(parts[4]))
                                        .font(.system(.caption2, design: .monospaced))
                                        .textSelection(.enabled)
                                } else {
                                    Text(row).font(.system(.caption2, design: .monospaced))
                                }
                            }
                        }
                    }
                }
                #endif
                if let err = controller.lastError {
                    Section("Error") { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Ajar")
            // The Request-Access hand-off from the block page: the page is https
            // (NEFilterProvider requires it), its button is ajar://request?u=…,
            // and the request is filed HERE because only the app holds the
            // device token. See FilterController.handleIncoming.
            .onOpenURL { url in Task { await controller.handleIncoming(url: url) } }
            .onAppear { if baseURL.isEmpty { baseURL = controller.baseURLString } }
        }
    }
}

#endif
