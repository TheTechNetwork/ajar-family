import SwiftUI

/// The product UI of Ajar Filter — what someone actually sees on the device
/// being filtered. The engineering levers live in `DebugHarnessView`, reachable
/// only from a debug build.
struct ContentView: View {
    @StateObject private var controller = FilterController()

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
        .animation(.default, value: controller.isEnrolled)
        .animation(.default, value: controller.filterEnabled)
        // The block page's "Ask to unlock" opens ajar://request?u=…
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
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(Ajar.accentInk)
            Text("Ajar").font(.system(size: 14, weight: .semibold)).foregroundStyle(Ajar.ink2)
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

                Text("Set up this device").font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Ajar.ink).padding(.bottom, 12)
                Text("A parent makes a setup code in the Ajar app. Enter it here.")
                    .font(.system(size: 16)).foregroundStyle(Ajar.ink2)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 28)

                TextField("Setup code", text: $code)
                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                    .multilineTextAlignment(.center)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Ajar.surface))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Ajar.fieldLine, lineWidth: 1))
                    .padding(.bottom, 12)

                TextField("Name for this device", text: $deviceName)
                    .font(.system(size: 16)).padding(.horizontal, 14)
                    .frame(minHeight: Ajar.tap)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.surface))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ajar.fieldLine, lineWidth: 1))
                    .padding(.bottom, 24)

                // Privacy IS UX (UX_PRINCIPLES §5) — said on the screen where the
                // child is deciding whether to trust this, not buried in a policy.
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "shield").font(.system(size: 16)).foregroundStyle(Ajar.accentInk)
                    Text("Ajar records what you ask to unlock. It does not record everything you visit.")
                        .font(.system(size: 14)).foregroundStyle(Ajar.accentInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ajar.accentWash))
                .padding(.bottom, 24)

                Button("Set up") {
                    Task { await controller.enroll(code: code, displayName: deviceName.isEmpty ? "This device" : deviceName) }
                }
                .buttonStyle(PrimaryButton())
                .disabled(code.isEmpty)

                if let status = controller.backendStatus {
                    Text(status).font(.system(size: 14)).foregroundStyle(Ajar.muted)
                        .padding(.top, 12).frame(maxWidth: .infinity, alignment: .center)
                }
                if let error = controller.lastError {
                    Text(error).font(.system(size: 14)).foregroundStyle(Ajar.muted)
                        .padding(.top, 8).frame(maxWidth: .infinity, alignment: .center)
                }

                #if DEBUG
                Button("Developer tools") { showingHarness = true }
                    .font(.system(size: 14)).foregroundStyle(Ajar.muted)
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
            Text("Turn on protection").font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Ajar.ink).padding(.bottom, 12)
            Text("iOS will ask you to allow Ajar to filter this device.")
                .font(.system(size: 16)).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center).padding(.bottom, 28)

            Button("Turn on") {
                Task {
                    await controller.requestChildAuthorization()
                    await controller.enableFilter()
                }
            }
            .buttonStyle(PrimaryButton()).frame(maxWidth: 360)

            if let error = controller.lastError {
                Text(error).font(.system(size: 14)).foregroundStyle(Ajar.muted)
                    .multilineTextAlignment(.center).padding(.top, 16)
            }
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
                Image(systemName: "checkmark").font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Ajar.ok)
            }
            .padding(.bottom, 24)

            Text("Ajar is on").font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Ajar.ink).padding(.bottom, 12)
            Text("If something is closed, you’ll see a page with a way to ask.")
                .font(.system(size: 16)).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)

            Spacer()

            #if DEBUG
            Button("Developer tools") { showingHarness = true }
                .font(.system(size: 14)).foregroundStyle(Ajar.muted)
                .frame(minHeight: Ajar.tap)
                .sheet(isPresented: $showingHarness) { DebugHarnessView(controller: controller) }
            #endif
        }
        .padding(24)
    }
}

// MARK: - After "Ask to unlock"

struct RequestStatusView: View {
    @ObservedObject var controller: FilterController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            icon.padding(.bottom, 24)
            Text(title).font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Ajar.ink).multilineTextAlignment(.center).padding(.bottom, 12)
            Text(message).font(.system(size: 16)).foregroundStyle(Ajar.ink2)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Done") { dismiss() }.buttonStyle(SecondaryButton()).frame(maxWidth: 360)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ajar.bg)
    }

    private var icon: some View {
        ZStack {
            Circle().fill(circleFill).frame(width: 72, height: 72)
            Image(systemName: symbol).font(.system(size: 28, weight: .semibold))
                .foregroundStyle(symbolColor)
        }
    }

    private var circleFill: Color {
        switch controller.requestState {
        case .answered: return Ajar.okWash
        case .failed:   return Ajar.surface2
        default:        return Ajar.warnWash
        }
    }
    private var symbolColor: Color {
        switch controller.requestState {
        case .answered: return Ajar.ok
        case .failed:   return Ajar.muted
        default:        return Ajar.warn
        }
    }
    private var symbol: String {
        switch controller.requestState {
        case .answered: return "checkmark"
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
        case .answered: return "Something changed"
        case .failed:   return "Couldn’t send it"
        case .idle:     return ""
        }
    }

    private var message: String {
        switch controller.requestState {
        case .sending:  return "Asking about \(controller.requestTarget)."
        case .waiting:  return "Nothing else to do — it’s on their phone now."
        case .answered: return "Try \(controller.requestTarget) again."
        case .failed(let why): return why
        case .idle:     return ""
        }
    }
}
