import SwiftUI

/// PoC D harness app entry point. See docs/APPLE_URL_FILTER_POC.md.
///
/// This is the SUPPLEMENTARY NEURLFilter (Bloom + PIR) blocklist proof — NOT the
/// per-video-approval engine. Per-video approval is PoC A
/// (apple/AjarFilter/, NEFilterDataProvider + FamilyControls `.child`).
@main
struct URLFilterPoCApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
