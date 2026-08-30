import SwiftUI

/// Minimal PoC A harness UI. Not the product parent app — just enough to drive
/// the experiments in docs/APPLE_CONTENT_FILTER_POC.md on a device.
struct ContentView: View {
    @StateObject private var controller = FilterController()

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
                Section("Try in Safari") {
                    Label("ALLOWED: youtube.com/watch?v=\(FilterController.allowedVideo)", systemImage: "checkmark.circle")
                    Label("BLOCKED: youtube.com/watch?v=\(FilterController.blockedVideo)", systemImage: "xmark.octagon")
                    Label("BLOCKED by CATEGORY: tiktok.com, reddit.com", systemImage: "xmark.octagon")
                    Label("ALWAYS ALLOWED (safety floor, never logged): 988lifeline.org",
                          systemImage: "lifepreserver")
                }
                if let err = controller.lastError {
                    Section("Error") { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("ParentFilter PoC")
        }
    }
}
