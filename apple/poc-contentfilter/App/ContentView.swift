import SwiftUI

/// Minimal PoC A harness UI. Not the product parent app — just enough to drive
/// the experiments in docs/APPLE_CONTENT_FILTER_POC.md on a device.
struct ContentView: View {
    @StateObject private var controller = FilterController()

    var body: some View {
        NavigationStack {
            Form {
                Section("1 · Authorization (.child)") {
                    Text("Status: \(String(describing: controller.authorizationStatus))")
                    Button("Request .child authorization") {
                        Task { await controller.requestChildAuthorization() }
                    }
                }
                Section("2 · Filter") {
                    Text(controller.filterEnabled ? "Enabled" : "Disabled")
                    Button("Enable content filter") { Task { await controller.enableFilter() } }
                    Button("Seed: default-deny YouTube, allow \(FilterController.allowedVideo)") {
                        controller.seedDefaultDenyYouTube()
                    }
                }
                Section("3 · Temporary approval (A4/A5)") {
                    Button("Approve \(FilterController.blockedVideo) for 30s") {
                        controller.grantTemporary(videoId: FilterController.blockedVideo, seconds: 30)
                    }
                    Text("Then open it in Safari, confirm it plays, and that it is blocked again after 30s.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Try in Safari") {
                    Label("ALLOWED: youtube.com/watch?v=\(FilterController.allowedVideo)", systemImage: "checkmark.circle")
                    Label("BLOCKED: youtube.com/watch?v=\(FilterController.blockedVideo)", systemImage: "xmark.octagon")
                }
                if let err = controller.lastError {
                    Section("Error") { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("ParentFilter PoC")
        }
    }
}
