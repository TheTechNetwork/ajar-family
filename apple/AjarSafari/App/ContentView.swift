import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The container app for the Safari extension.
///
/// A Safari Web Extension cannot be installed on its own — it ships inside an
/// app — and this app has exactly one job: tell a parent how to switch the
/// extension on, in the words of the platform they are actually holding. The
/// steps genuinely differ between iOS and macOS, and a single generic sentence
/// would be wrong on both.
///
/// Deliberately does not enrol, sign in, or show policy. The extension reads the
/// snapshot the rest of the product already delivers; duplicating any of that
/// here would be a second place for it to drift.
struct ContentView: View {
    // The screen itself is SafariEnableScreen, in ../SafariExtension/UI, because
    // the iOS host shows the same words from inside the filter app. Two copies
    // of an instruction is two chances for one of them to be wrong.
    var body: some View { SafariEnableScreen() }
}

/// The Ajar mark. Lowercase wordmark in accent ink (BRAND.md §6) — the same
/// mark the console and both block pages use.
struct AjarMark: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "door.left.hand.open")
                .ajarFont(18, .regular, relativeTo: .title3)
                .foregroundStyle(Ajar.accentInk)
                .accessibilityHidden(true)   // the word beside it IS the mark
            Text("ajar").ajarFont(16, .bold).foregroundStyle(Ajar.accentInk)
        }
    }
}
