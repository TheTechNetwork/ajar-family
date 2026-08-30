import Foundation

/// Swift port of `shared/safety/safety-floor.ts`. Keep the list and the matching
/// rule byte-identical to the TypeScript.
///
/// These hosts resolve to ALLOW *above every other tier* — above device-scoped
/// rules, above an active temporary BLOCK, above default-deny. A parent cannot
/// switch this off. Reaching one is also NOT reported to parents: a floor that is
/// surveilled is not a floor, so `EvalResult.isReportable` is false for it and
/// the providers must not log the URL.
///
/// Scope discipline (copied from the TS): crisis/emergency/public-health only.
/// This is not a general allowlist and must not grow into one.
///
/// NOT COMPILED OR RUN.
public enum SafetyFloor {

    /// Mirror of `SAFETY_FLOOR_DOMAINS` — same order, same entries.
    public static let domains: [String] = [
        // Crisis & suicide prevention
        "988lifeline.org", "suicidepreventionlifeline.org", "crisistextline.org",
        "befrienders.org", "findahelpline.com", "samaritans.org", "papyrus-uk.org",
        // Youth-specific
        "thetrevorproject.org", "childline.org.uk", "kidshelpphone.ca",
        "childhelphotline.org", "youthline.co.nz",
        // Abuse, assault, trafficking
        "rainn.org", "thehotline.org", "childhelp.org", "humantraffickinghotline.org",
        // Public health authorities
    ]

    private static let domainSet = Set(domains)

    /// Mirror of `isSafetyFloorHost()`:
    ///
    ///     const h = (host || "").replace(/^www\./i, "").toLowerCase();
    ///     return SAFETY_FLOOR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
    ///
    /// The TS strips only a leading `www.` here (NOT a trailing root dot) — the
    /// evaluator hands it hosts that `normalizeHost()` already cleaned. This port
    /// does the same and is likewise called with normalized hosts, so
    /// "988lifeline.org." is covered via `Host.normalize` upstream.
    ///
    /// Suffix matching is anchored on a dot, so "988lifeline.org.evil.com" does
    /// NOT match (the TS test asserts exactly this).
    public static func matches(_ host: String) -> Bool {
        var h = host
        if h.count >= 4, h.prefix(4).lowercased() == "www." { h.removeFirst(4) }
        h = h.lowercased()
        if h.isEmpty { return false }
        if domainSet.contains(h) { return true }
        // Exact-suffix check on label boundaries; equivalent to the TS
        // `h.endsWith("." + d)` over the same list.
        return domains.contains { h.hasSuffix("." + $0) }
    }
}
