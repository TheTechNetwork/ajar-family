import SwiftUI

/// The design tokens, lifted from `web/parent/tokens.css`.
///
/// DUPLICATED from apple/AjarParent/App/Theme.swift. AjarFilter and AjarParent
/// are separate Xcode projects with no shared framework between them, so this is
/// a real copy, like the four inline CSS copies the extensions carry. If a token
/// changes in tokens.css it must change in three places, which is what
/// `apple/check-theme-tokens.mjs` is for.
///
/// Those values are contrast-checked in CI (`web/parent/check-contrast.mjs`), so
/// they are copied EXACTLY rather than eyeballed to something that looks close.
/// `apple/check-theme-tokens.mjs` enforces the copy on every push: change a hex
/// here and CI fails; change one in tokens.css and CI fails until this follows.
/// Two rules from that file carry over and are easy to get wrong here:
///
///   - `accent` (#18A08C) is DECORATIVE only. White on it measures 3.26:1. Text
///     on teal uses `accentStrong`; teal text on a light surface uses `accentInk`.
///   - `yes` (coral) is a FILL that carries `yesInk`, never white — white on
///     coral is 2.32:1.
enum Ajar {
    static func hex(_ v: UInt32) -> Color {
        Color(.sRGB,
              red: Double((v >> 16) & 0xFF) / 255,
              green: Double((v >> 8) & 0xFF) / 255,
              blue: Double(v & 0xFF) / 255)
    }

    // Light / dark pairs, matching the two token blocks.
    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex(dark)) : UIColor(hex(light)) })
        #else
        return hex(light)
        #endif
    }

    static let bg          = dyn(0xF6F4EE, 0x12211D)
    static let surface     = dyn(0xFFFFFF, 0x1A2A26)
    static let surface2    = dyn(0xEFEDE4, 0x223531)
    static let line        = dyn(0xE3E1D8, 0x2B3A35)
    static let fieldLine   = dyn(0x767468, 0x7B8D87)
    static let ink         = dyn(0x12241F, 0xEAF1EE)
    static let ink2        = dyn(0x3E4F49, 0xC3D2CC)
    static let muted       = dyn(0x5C6B64, 0x9FB1AA)
    static let accentStrong = dyn(0x0D6D5E, 0x35B7A2)
    static let accentInk   = dyn(0x0B6355, 0x5FD3BE)
    static let accentWash  = dyn(0xE7F4F1, 0x1F322D)
    static let onAccent    = dyn(0xFFFFFF, 0x0B1512)
    static let yes         = hex(0xFF8A5B)
    static let yesInk      = dyn(0x12241F, 0x2A1208)
    static let warn        = dyn(0x7D5307, 0xE0B25A)
    static let warnWash    = dyn(0xFBF1DE, 0x2E2716)
    static let ok          = dyn(0x14602F, 0x7BD69B)
    static let okWash      = dyn(0xEAF3EC, 0x16301F)
    // Present in tokens.css from the start and missing here, which is why both
    // apps rendered every error in `muted` — quieter than body copy, on the one
    // string that matters when it appears. Not alarm-red (BRAND §7): a child
    // seeing a red screen reads punishment before words.
    static let err         = dyn(0x8C4636, 0xF0A08C)
    static let errWash     = dyn(0xFAEDE9, 0x2E1E19)

    // 44px is the floor we hold ourselves to; WCAG 2.5.8 only asks 24.
    static let tap: CGFloat = 44
    static let tapLarge: CGFloat = 52
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(_ color: Color) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(cgColor: color.cgColor ?? UIColor.black.cgColor).getRed(&r, green: &g, blue: &b, alpha: &a)
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
#endif

/// The primary action. Coral fill, dark ink, 52pt, full width — the one thing
/// on a card that should be unmissable.
struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Ajar.yesInk)
            .frame(maxWidth: .infinity, minHeight: Ajar.tapLarge)
            .background(Ajar.yes.opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(Capsule())
    }
}

/// Secondary. A visible border, because a borderless control on this ground is
/// a link pretending to be a button.
struct SecondaryButton: ButtonStyle {
    var quiet = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16))
            .foregroundStyle(quiet ? Ajar.ink2 : Ajar.ink)
            .frame(maxWidth: .infinity, minHeight: Ajar.tap)
            .background(Capsule().stroke(quiet ? Ajar.line : Ajar.fieldLine, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
