#if DEBUG
import Foundation

/// DEBUG-ONLY instrument for the PoC A experiments (docs/APPLE_CONTENT_FILTER_POC.md).
///
/// ## Why this exists
///
/// Test **A2** asks whether `NEFilterFlow.url` really carries a full YouTube
/// watch URL at runtime or only the host. That question cannot be answered from
/// the unified log: `FilterDataProvider` logs the URL with `privacy: .private`,
/// which renders as `<private>` in Console — correctly, because a content filter
/// must not spill browsing into the system log. Turning that to `.public` to run
/// one experiment would mean shipping a build whose logging posture differs from
/// the one being tested.
///
/// So the data provider writes each **reportable** verdict into a small ring
/// buffer in the App Group instead, and the containing app renders it. The
/// buffer is capped, never leaves the device, and is wiped by "Clear".
///
/// ## What is deliberately NOT recorded
///
/// Safety-floor hits. `EvalResult.isReportable` is false for them
/// (`shared/safety/safety-floor.ts` — "a floor that is surveilled is not a
/// floor"), and callers must consult it before logging a URL. This recorder is
/// a caller like any other, so reaching a crisis line stays invisible here too,
/// even in a debug build. Do not "fix" that by recording everything.
///
/// The whole file is behind `#if DEBUG`, so no release build can record a URL.
///
/// ## This also tests a claim
///
/// `PolicyStore.recordsDiagnostics` documents that "the NEFilterDataProvider
/// sandbox forbids disk writes, so the extensions read-only". That was written
/// without a device. If the rows below appear in the app, the data provider CAN
/// write to the App Group and that comment needs correcting; if they never
/// appear, the comment is right and the App Group is a one-way channel into the
/// extension. Either way the answer belongs in ADR-012.
public enum FlowLog {

    private static let key = "poc_flow_observations"

    /// Small enough that the App Group never becomes a browsing history, large
    /// enough to hold one A1/A2 run (a page load is many flows).
    private static let limit = 60

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: PolicyStore.defaultAppGroup)
    }

    /// One observed flow. `kind` distinguishes the two shapes A2 compares:
    /// `browser` (NEFilterBrowserFlow — expected to carry a full URL) from
    /// `socket` (NEFilterSocketFlow — expected to expose a hostname only).
    public static func record(kind: String,
                              url: String,
                              action: String,
                              reason: String) {
        guard let defaults else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        var rows = defaults.stringArray(forKey: key) ?? []
        rows.append("\(stamp)\t\(kind)\t\(action)\t\(reason)\t\(url)")
        if rows.count > limit { rows.removeFirst(rows.count - limit) }
        defaults.set(rows, forKey: key)
    }

    /// Newest first, so the app shows the most recent flow without scrolling.
    public static func all() -> [String] {
        (defaults?.stringArray(forKey: key) ?? []).reversed()
    }

    public static func clear() { defaults?.removeObject(forKey: key) }
}
#endif
