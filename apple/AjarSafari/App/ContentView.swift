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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AjarMark().padding(.bottom, 28)

                Text("Turn on Ajar in Safari")
                    .ajarFont(22, .semibold, relativeTo: .title2)
                    .foregroundStyle(Ajar.ink).padding(.bottom, 12)
                Text("Safari checks each page with Ajar once the extension is on. "
                     + "It stays off until someone turns it on here.")
                    .ajarFont(16).foregroundStyle(Ajar.ink2)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 28)

                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)")
                            .ajarFont(14, .semibold, relativeTo: .footnote)
                            .foregroundStyle(Ajar.accentInk)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(Ajar.accentWash))
                            .accessibilityHidden(true)   // the order is in the list itself
                        Text(step).ajarFont(16).foregroundStyle(Ajar.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.bottom, 14)
                }

                // Privacy said where the decision to trust this is being made,
                // not buried in a policy (UX_PRINCIPLES §5). It is also simply
                // true: the extension evaluates a snapshot already on the
                // device and sends nothing per page.
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "shield")
                        .ajarFont(16).foregroundStyle(Ajar.accentInk)
                        .accessibilityHidden(true)
                    Text("Ajar checks pages on this device. It does not send what you visit anywhere.")
                        .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.accentInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.accentWash))
                .padding(.top, 10)
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .background(Ajar.bg)
    }

    /// The real steps, per platform. iOS puts extensions under Settings; macOS
    /// puts them in Safari's own settings. One generic instruction would be
    /// wrong on both, and a wrong instruction on the only screen this app has
    /// is the whole app being wrong.
    private static var steps: [String] {
        #if os(iOS)
        [
            "Open Settings, then Apps, then Safari.",
            "Tap Extensions, then Ajar.",
            "Switch Ajar on.",
            "Under Permissions, allow Ajar on All Websites — it has to see a page's address to know whether it is open.",
        ]
        #else
        [
            "Open Safari, then Settings from the Safari menu.",
            "Choose Extensions.",
            "Tick Ajar in the list.",
            "Set Ajar's permission to Allow on Every Website — it has to see a page's address to know whether it is open.",
        ]
        #endif
    }
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
