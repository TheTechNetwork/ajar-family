import SwiftUI

/// How to switch the Safari extension on, in the words of the platform the
/// parent is actually holding.
///
/// SHARED BY BOTH HOSTS. On iOS the extension ships inside the filter app
/// (`AjarFilter`), on macOS inside its own container (`AjarSafari`). The
/// instructions are the same instructions, and a second copy of them is a second
/// copy to go stale — this one file is compiled into both app targets.
///
/// NO STATUS CLAIM ANYWHERE HERE. iOS gives an app no way to ask whether its
/// Safari extension is enabled — `SFSafariExtensionManager` is macOS-only — so
/// the honest surface is a standing instruction, not a tick. A screen that says
/// "on" without having checked is worse than one that says nothing.
struct SafariEnableSteps: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
        }
    }

    /// The real steps, per platform. iOS puts extensions under Settings; macOS
    /// puts them in Safari's own settings. One generic instruction would be
    /// wrong on both, and a wrong instruction on the only screen this app has
    /// is the whole app being wrong.
    static var steps: [String] {
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

/// The steps as a whole screen: heading, steps, and the privacy line.
///
/// The macOS container app is nothing but this. On iOS it is a sheet from the
/// filter app, which is why the heading lives here rather than in either
/// caller — so the two hosts cannot word it differently.
struct SafariEnableScreen: View {
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

                SafariEnableSteps()

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
}
