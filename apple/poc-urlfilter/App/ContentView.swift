import SwiftUI

/// Minimal PoC D harness UI. Drives the NEURLFilter Bloom+PIR blocklist and lets
/// the tester probe a URL's verdict and reset the PIR cache. Not the product
/// parent app — just enough to run the experiments in
/// docs/APPLE_URL_FILTER_POC.md on a device.
///
/// Reminder: this is the SUPPLEMENTARY blocklist layer. Per-video approval is
/// PoC A (apple/AjarFilter/).
struct ContentView: View {
    @StateObject private var controller = URLFilterController()

    // The two canonical PoC URLs (see docs/APPLE_URL_FILTER_POC.md):
    //   BLOCKED — present in the blocklist dataset.
    //   ALLOWED — absent from the blocklist, so it is allowed BY ABSENCE.
    @State private var urlToTest = "https://www.youtube.com/watch?v=9bZkp7q19f0"

    private let blockedURL = "https://www.youtube.com/watch?v=9bZkp7q19f0"
    private let allowedURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    var body: some View {
        NavigationStack {
            Form {
                Section("1 · NEURLFilter (blocklist layer)") {
                    Text("Status: \(controller.statusText)")
                    Button("Configure + enable (fail-closed)") {
                        Task { await controller.configureAndEnable() }
                    }
                    Button("Refresh status") { Task { await controller.refreshStatus() } }
                    Button("Detailed status (async)") { Task { await controller.refreshDetailedStatus() } }
                    Button("Disable") { Task { await controller.disableFilter() } }
                }

                Section("2 · Test a URL verdict") {
                    TextField("URL", text: $urlToTest)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Check verdict(for:)") {
                        Task { await controller.testVerdict(for: urlToTest) }
                    }
                    Text("Verdict: \(controller.lastVerdict)")
                        .font(.headline)
                    Button("Use BLOCKED url") { urlToTest = blockedURL }
                    Button("Use ALLOWED url (absent → allow)") { urlToTest = allowedURL }
                }

                Section("3 · PIR fast path") {
                    Button("resetPIRCache() + refreshPIRParameters()") {
                        Task { await controller.resetPIRCache() }
                    }
                    Text("The Bloom prefilter cannot update faster than ~45 min; PIR verdicts refresh faster, but only when THIS app runs to reset the cache. No server→device trigger.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("Try in Safari (WebKit is filtered automatically)") {
                    Label("BLOCKED: \(blockedURL)", systemImage: "xmark.octagon")
                    Label("ALLOWED: \(allowedURL)", systemImage: "checkmark.circle")
                    Text("NEURLFilter has NO block page / remediation API. A blocked URL simply fails to load; the app is never told what was blocked (privacy by design). Request-Access UX lives in PoC A.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if let err = controller.lastError {
                    Section("Error") { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("URLFilter PoC (D)")
        }
    }
}
