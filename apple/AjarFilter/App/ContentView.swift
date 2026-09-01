import SwiftUI

/// The product UI of Ajar Filter — what someone actually sees on the device
/// being filtered. The engineering levers live in `DebugHarnessView`, reachable
/// only from a debug build.
struct ContentView: View {
    @StateObject private var controller = FilterController()
    // See the note in AjarParent/RootView. Same setting, same reason: these two
    // transitions swap the whole screen, and the web has honoured
    // `prefers-reduced-motion` globally since the design system landed.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Ajar.bg.ignoresSafeArea()
            if !controller.isEnrolled {
                SetUpView(controller: controller)
            } else if !controller.filterEnabled {
                TurnOnView(controller: controller)
            } else {
                ProtectedView(controller: controller)
            }
        }
        .animation(reduceMotion ? nil : .default, value: controller.isEnrolled)
        .animation(reduceMotion ? nil : .default, value: controller.filterEnabled)
        // The block page's "Ask to open it" opens ajar://request?u=…
        .onOpenURL { url in Task { await controller.handleIncoming(url: url) } }
        .sheet(isPresented: Binding(
            get: { controller.requestState != .idle },
            set: { if !$0 { controller.requestState = .idle } }
        )) {
            RequestStatusView(controller: controller)
        }
    }
}

/// The Ajar mark. A door left open a crack — calm, never an alarm.
struct AjarMark: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "door.left.hand.open")
                .ajarFont(18, .regular, relativeTo: .title3)
                .foregroundStyle(Ajar.accentInk)
                // VoiceOver announced "door left hand open" beside the word
                // "Ajar" — the SC 1.1.1 problem that got the 🚪 emoji removed
                // from this mark in the first place. The word next to it IS the
                // mark's text alternative.
                .accessibilityHidden(true)
            // BRAND.md:247-254 settles this: the interim mark is the lowercase
            // wordmark in accent-ink at --t-base/700. It names the exact bug it
            // was fixing — "the one branded element on the child's screen
            // rendered as 13px muted grey" — and this file had drifted back to
            // 14px in ink-2, on the child's screen, again. The console and both
            // extension block pages have always complied.
            Text("ajar").ajarFont(16, .bold).foregroundStyle(Ajar.accentInk)
        }
    }
}

// MARK: - Not set up

/// The code is created by a PARENT and typed in HERE. An earlier design had this
/// backwards — showing a code on this device for the parent to type — which the
/// API settles: the parent calls /families/{id}/enroll, the device redeems it.
struct SetUpView: View {
    @ObservedObject var controller: FilterController
    @State private var code = ""
    @State private var deviceName = ""
    #if DEBUG
    @State private var showingHarness = false
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AjarMark().padding(.bottom, 28)

                Text("Set up this device").ajarFont(22, .semibold, relativeTo: .title2)
                    .foregroundStyle(Ajar.ink).padding(.bottom, 12)
                Text("A parent makes a setup code in the Ajar app. Enter it here.")
                    .ajarFont(16).foregroundStyle(Ajar.ink2)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 28)

                LabeledField("Setup code") {
                    // "8 characters", not a specimen code: a plausible-looking
                    // example in a field a child is transcribing into is
                    // something to type by mistake.
                    TextField("8 characters", text: $code)
                    .ajarFont(28, .bold, relativeTo: .title, design: .monospaced)
                    .multilineTextAlignment(.center)
                    .accessibilityLabel("Setup code")
                    // NOT .numberPad. Codes are drawn from
                    // ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (services.ts CODE_ALPHABET),
                    // so an 8-character code almost always contains letters and a
                    // number pad cannot type it — step one of the product, dead on
                    // the primary platform. Uppercase because the server matches
                    // the code exactly.
                    #if os(iOS)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    #endif
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Ajar.surface))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Ajar.fieldLine, lineWidth: 1))
                }
                .padding(.bottom, 12)

                LabeledField("Name for this device") {
                    TextField("Jane's iPhone", text: $deviceName)
                        .accessibilityLabel("Name for this device")
                        .ajarFont(16).padding(.horizontal, 14)
                        .frame(minHeight: Ajar.tap)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ajar.fieldLine, lineWidth: 1))
                }
                .padding(.bottom, 24)

                // Privacy IS UX (UX_PRINCIPLES §5) — said on the screen where the
                // child is deciding whether to trust this, not buried in a policy.
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "shield").ajarFont(16).foregroundStyle(Ajar.accentInk)
                    Text("Ajar records what you ask to open. It does not record everything you visit.")
                        .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.accentInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.accentWash))
                .padding(.bottom, 24)

                Button(controller.enrolling ? "Setting up…" : "Set up") {
                    Task { await controller.enroll(code: code, displayName: deviceName.isEmpty ? "This device" : deviceName) }
                }
                .buttonStyle(PrimaryButton())
                // The code is single use. Without this a second tap on a slow
                // network spends it: the first redeem succeeds and the second is
                // refused, leaving an error on a device that did enrol.
                .disabled(code.isEmpty || controller.enrolling)

                if let status = controller.backendStatus {
                    Text(status).ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.muted)
                        .padding(.top, 12).frame(maxWidth: .infinity, alignment: .center)
                }
                ErrorNote(controller.lastError).padding(.top, 8)

                #if DEBUG
                Button("Developer tools") { showingHarness = true }
                    .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.muted)
                    .frame(maxWidth: .infinity, minHeight: Ajar.tap).padding(.top, 20)
                    .sheet(isPresented: $showingHarness) { DebugHarnessView(controller: controller) }
                #endif
            }
            .padding(24)
        }
    }
}

// MARK: - Enrolled, filter not running

struct TurnOnView: View {
    @ObservedObject var controller: FilterController

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            AjarMark().padding(.bottom, 28)
            Text("Turn on protection").ajarFont(22, .semibold, relativeTo: .title2)
                .foregroundStyle(Ajar.ink).padding(.bottom, 12)
            Text("iOS will ask you to allow Ajar to filter this device.")
                .ajarFont(16).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center).padding(.bottom, 28)

            Button("Turn on") {
                Task {
                    // Only if authorization was actually GRANTED. Running on
                    // regardless produced a second failure for an unrelated-
                    // looking reason, which overwrote the message that said what
                    // had really happened.
                    if await controller.requestChildAuthorization() {
                        await controller.enableFilter()
                    }
                }
            }
            .buttonStyle(PrimaryButton()).frame(maxWidth: 360)

            ErrorNote(controller.lastError).padding(.top, 16).frame(maxWidth: 360)
            Spacer()
        }
        .padding(24)
    }
}

// MARK: - Running

/// Deliberately dull. Once it is on there is nothing to do here, and a screen
/// that invents activity to look busy invites poking at it.
struct ProtectedView: View {
    @ObservedObject var controller: FilterController
    #if DEBUG
    @State private var showingHarness = false
    #endif

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            ZStack {
                Circle().fill(Ajar.okWash).frame(width: 72, height: 72)
                Image(systemName: "checkmark").ajarFont(30, .semibold, relativeTo: .title)
                    .foregroundStyle(Ajar.ok)
            }
            .padding(.bottom, 24)

            Text("Ajar is on").ajarFont(22, .semibold, relativeTo: .title2)
                .foregroundStyle(Ajar.ink).padding(.bottom, 12)
            Text("If something is closed, you’ll see a page with a way to ask.")
                .ajarFont(16).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)

            Spacer()

            #if DEBUG
            Button("Developer tools") { showingHarness = true }
                .ajarFont(14, relativeTo: .footnote).foregroundStyle(Ajar.muted)
                .frame(minHeight: Ajar.tap)
                .sheet(isPresented: $showingHarness) { DebugHarnessView(controller: controller) }
            #endif
        }
        .padding(24)
    }
}

// MARK: - After "Ask to open it"

struct RequestStatusView: View {
    @ObservedObject var controller: FilterController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            icon.padding(.bottom, 24)
            Text(title).ajarFont(22, .semibold, relativeTo: .title2)
                .foregroundStyle(Ajar.ink).multilineTextAlignment(.center).padding(.bottom, 12)
            Text(message).ajarFont(16).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)
            Spacer()
            // The way BACK to the page. "Try example.com again" used to be the
            // end of the road: the page is in Safari, the child is here, and
            // nothing on this screen could take them there. Only offered once
            // something has changed — before that there is nothing to try.
            if controller.requestState == .answered, let url = controller.requestURL {
                Link("Open the page", destination: url)
                    .buttonStyle(PrimaryButton()).frame(maxWidth: 360).padding(.bottom, 12)
            }
            // The retry the refresh icon has always promised. A failed ask used
            // to offer "Done" alone, so the only way forward was back to Safari
            // to start the whole thing over — on the one screen a child reaches
            // by being told no by the network.
            if case .failed = controller.requestState, controller.lastIncoming != nil {
                Button("Try again") { Task { await controller.retryLastRequest() } }
                    .buttonStyle(PrimaryButton()).frame(maxWidth: 360).padding(.bottom, 12)
            }
            Button("Done") { dismiss() }.buttonStyle(SecondaryButton()).frame(maxWidth: 360)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ajar.bg)
    }

    private var icon: some View {
        ZStack {
            Circle().fill(circleFill).frame(width: 72, height: 72)
            Image(systemName: symbol).ajarFont(28, .semibold, relativeTo: .title)
                .foregroundStyle(symbolColor)
        }
    }

    // `.answered` means the POLICY CHANGED, not that a parent said yes — the
    // long poll wakes on any version bump, and a refusal bumps it too
    // (services.ts decide(), BLOCK branch). So a denied child was shown a green
    // wash and a checkmark: an affirmative signal, which a young child reads
    // before the words, followed by the same wall. The copy was already careful
    // here ("NOT 'You're in'"); the icon was never brought into line with it.
    //
    // Neutral until the device can be told the actual decision.
    private var circleFill: Color {
        switch controller.requestState {
        case .answered: return Ajar.surface2
        case .failed:   return Ajar.surface2
        default:        return Ajar.warnWash
        }
    }
    private var symbolColor: Color {
        switch controller.requestState {
        case .answered: return Ajar.ink2
        case .failed:   return Ajar.muted
        default:        return Ajar.warn
        }
    }
    private var symbol: String {
        switch controller.requestState {
        case .answered: return "arrow.clockwise"
        case .failed:   return "arrow.clockwise"
        default:        return "clock"
        }
    }

    private var title: String {
        switch controller.requestState {
        case .sending:  return "Sending…"
        case .waiting:  return "Sent. Waiting on a parent."
        // NOT "You're in": the long poll returns on any policy change, and the
        // backend does not report the decision to the device yet. Claiming a yes
        // the parent may not have given is worse than saying what is known.
        case .answered: return "There’s an answer"
        case .failed:   return "Couldn’t send it"
        case .idle:     return ""
        }
    }

    private var message: String {
        switch controller.requestState {
        case .sending:  return "Asking about \(controller.requestTarget)."
        case .waiting:  return "Nothing else to do — it is with a parent now."
        case .answered: return "Open \(controller.requestTarget) to see what it is."
        case .failed(let why): return why
        case .idle:     return ""
        }
    }
}

// MARK: - A field with a label that stays

/// A visible label above the control, and an example inside it.
///
/// Both apps used the placeholder AS the label — `TextField("Setup code", …)` —
/// which UX_PRINCIPLES §8 requirement 4 forbids and which the web console has
/// always got right. The failure is not the screen reader (SwiftUI does expose
/// the title): the label vanishes the moment anyone types, so the setup code
/// field becomes an unlabelled box of characters on the very first screen of the
/// product, at the moment a child is transcribing from another device and
/// looking away and back.
///
/// The control keeps whatever background it already carried, because the setup
/// code field is deliberately taller and rounder than an ordinary one.
struct LabeledField<Content: View>: View {
    private let label: String
    private let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).ajarFont(14).foregroundStyle(Ajar.ink2)
            content
        }
    }
}

// MARK: - Something went wrong

/// One place that renders an error, in the error colour.
///
/// Every error in this app was drawn in `Ajar.muted` at 14pt centred — quieter
/// than the body copy around it, on the one string that matters at the moment it
/// appears. `--err` was in tokens.css from the start and in neither Swift
/// palette, so there was no colour to reach for.
///
/// Not alarm-red (BRAND §7): this screen belongs to a child, and a red panel
/// reads as punishment before the words are read.
struct ErrorNote: View {
    private let message: String?
    init(_ message: String?) { self.message = message }

    var body: some View {
        if let message, !message.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(Ajar.err)
                    .accessibilityHidden(true)   // the sentence says it
                Text(message).ajarFont(15).foregroundStyle(Ajar.err)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.errWash))
        }
    }
}
