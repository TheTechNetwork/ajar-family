import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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

    #if canImport(AppKit) && !canImport(UIKit)
    /// The same hex, as an `NSColor`, built from components rather than bridged
    /// through `NSColor(_: Color)`. SwiftUI already vends an initialiser of that
    /// exact shape, so going via `Color` here would resolve to it — or, if it
    /// were ever shadowed locally, recurse. Components have no such ambiguity.
    static func nsHex(_ v: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255,
                green: CGFloat((v >> 8) & 0xFF) / 255,
                blue: CGFloat(v & 0xFF) / 255,
                alpha: 1)
    }
    #endif

    /// Light / dark pairs, matching the two token blocks.
    ///
    /// The `#else` used to return the LIGHT hex, which meant the macOS build had
    /// no dark mode at all — every token resolved to its light value on a
    /// platform whose users switch appearance constantly, in a design system
    /// whose entire dark palette is recomputed by CI (check-contrast.mjs) and
    /// diffed against these files (check-theme-tokens.mjs). Two checks defended
    /// a palette that one of the two platforms never rendered.
    ///
    /// AppKit's equivalent of the UIKit dynamic provider is
    /// `NSColor(name:dynamicProvider:)`, resolved against the appearance in
    /// effect when the colour is read.
    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex(dark)) : UIColor(hex(light)) })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil) { appearance in
            // `bestMatch` rather than comparing `appearance.name` directly: the
            // real names are aqua, darkAqua, and the two high-contrast variants,
            // and an equality check against `.darkAqua` alone renders the light
            // palette for a user on increased contrast — the users least able to
            // absorb a wrong palette.
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return nsHex(isDark ? dark : light)
        })
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

// MARK: - Type that actually scales

/// Apply one of the design sizes so that it HONOURS DYNAMIC TYPE.
///
/// `Font.system(size:)` is a fixed point size: it ignores the reader's text-size
/// setting entirely. Both apps used it at every call site — around forty between
/// them — so the single accessibility setting most people actually change did
/// nothing at all here, on a product whose buyers skew to an age where system
/// text is set above default. The web surfaces have always honoured it, because
/// they size in `rem`.
///
/// `ScaledMetric` is the supported way to keep a specific design size AND scale
/// it. It is a property wrapper, so it has to live on a `ViewModifier` rather
/// than in a `Font` factory — a static function cannot observe the environment,
/// which is exactly why a size computed once at launch would freeze at whatever
/// the setting was then.
///
/// `relativeTo` picks the ramp: body text and headings scale at different rates,
/// and a 28pt title tied to `.body` grows like a paragraph.
private struct ScaledFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design

    init(size: CGFloat, relativeTo style: Font.TextStyle, weight: Font.Weight, design: Font.Design) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}

extension View {
    /// The design size, scaled. A drop-in for `.font(.system(size:weight:design:))`.
    func ajarFont(_ size: CGFloat,
                  _ weight: Font.Weight = .regular,
                  relativeTo style: Font.TextStyle = .body,
                  design: Font.Design = .default) -> some View {
        modifier(ScaledFont(size: size, relativeTo: style, weight: weight, design: design))
    }
}

/// The primary action. Coral fill, dark ink, 52pt, full width — the one thing
/// on a card that should be unmissable.
struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .ajarFont(16, .semibold)
            .foregroundStyle(Ajar.yesInk)
            .frame(maxWidth: .infinity, minHeight: Ajar.tapLarge)
            .background(Ajar.yes.opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(Capsule())
            // The boundary, and it is not decoration. Coral measures 2.32:1
            // against a white card, so a coral capsule with no edge is the most
            // important control in the product with no perceivable shape — SC
            // 1.4.11. tokens.css states the rule and the web `.btn-yes` has
            // always carried it; both Swift copies re-implemented the button and
            // dropped it. yes-ink is the label colour, so the edge is the one
            // colour already proven to read on this fill.
            .overlay(Capsule().stroke(Ajar.yesInk, lineWidth: 1))
    }
}

/// Secondary. A visible border, because a borderless control on this ground is
/// a link pretending to be a button.
struct SecondaryButton: ButtonStyle {
    var quiet = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .ajarFont(16)
            .foregroundStyle(quiet ? Ajar.ink2 : Ajar.ink)
            .frame(maxWidth: .infinity, minHeight: Ajar.tap)
            // `line` is documented decorative-only (1.31:1) and was the border
            // on the QUIET variant — which is the parent's "Not now", the
            // softest button on the screen and still a control that has to be
            // findable. Both variants use field-line; the quiet one stays quiet
            // through its label colour, not by being hard to see.
            .background(Capsule().stroke(Ajar.fieldLine, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
