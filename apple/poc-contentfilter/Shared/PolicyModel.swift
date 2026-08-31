import Foundation

/// Swift mirror of `shared/policy/policy-model.ts` (the authoritative spec).
/// The evaluation ORDER and the field set must match; see `PolicyStore.swift`
/// for the evaluator itself.
///
/// NOT COMPILED OR RUN.

public enum RuleAction: String, Codable { case allow = "ALLOW", block = "BLOCK" }

public enum PolicyTargetType: String, Codable {
    case domain = "DOMAIN", url = "URL", urlPattern = "URL_PATTERN"
    case ytVideo = "YOUTUBE_VIDEO", ytChannel = "YOUTUBE_CHANNEL", ytPlaylist = "YOUTUBE_PLAYLIST"
    case category = "CATEGORY", application = "APPLICATION"
}

public enum RuleScopeType: String, Codable { case family = "FAMILY", child = "CHILD", device = "DEVICE" }

/// TS: `grantKind: "TIMED" | "ONCE" | "UNTIL_END_OF_DAY"`.
public enum GrantKind: String, Codable { case timed = "TIMED", once = "ONCE", untilEndOfDay = "UNTIL_END_OF_DAY" }

public struct RuleScope: Codable {
    public var type: RuleScopeType
    public var familyId: String
    public var childId: String?
    public var deviceId: String?

    public init(type: RuleScopeType, familyId: String, childId: String? = nil, deviceId: String? = nil) {
        self.type = type; self.familyId = familyId; self.childId = childId; self.deviceId = deviceId
    }
}

public struct PolicyRule: Codable {
    public var id: String
    public var target: PolicyTargetType
    public var value: String
    public var action: RuleAction
    public var scope: RuleScope
    public var priority: Int?
    /// Audit fields; optional here so an older/newer backend payload still decodes.
    public var createdAt: String?
    public var createdBy: String?

    public init(id: String, target: PolicyTargetType, value: String, action: RuleAction,
                scope: RuleScope, priority: Int? = nil, createdAt: String? = nil, createdBy: String? = nil) {
        self.id = id; self.target = target; self.value = value; self.action = action
        self.scope = scope; self.priority = priority; self.createdAt = createdAt; self.createdBy = createdBy
    }
}

public struct TemporaryRule: Codable {
    public var id: String
    public var target: PolicyTargetType
    public var value: String
    public var action: RuleAction
    public var scope: RuleScope
    public var priority: Int?
    public var startsAt: Date
    public var expiresAt: Date
    public var requestId: String
    public var approvedBy: String
    /// Optional so a payload without it still decodes; the evaluator reports
    /// `temporary:TIMED` in that case, matching the TS reason string shape.
    public var grantKind: GrantKind?

    public init(id: String, target: PolicyTargetType, value: String, action: RuleAction,
                scope: RuleScope, priority: Int? = nil, startsAt: Date, expiresAt: Date,
                requestId: String, approvedBy: String, grantKind: GrantKind? = .timed) {
        self.id = id; self.target = target; self.value = value; self.action = action
        self.scope = scope; self.priority = priority; self.startsAt = startsAt
        self.expiresAt = expiresAt; self.requestId = requestId; self.approvedBy = approvedBy
        self.grantKind = grantKind
    }
}

public struct DefaultPolicy: Codable {
    public var webDefault: RuleAction
    public var youTubeDefault: RuleAction

    public init(webDefault: RuleAction, youTubeDefault: RuleAction) {
        self.webDefault = webDefault; self.youTubeDefault = youTubeDefault
    }
}

public struct DevicePolicySnapshot: Codable {
    public var version: Int
    public var familyId: String
    public var childId: String
    public var deviceId: String
    public var defaults: DefaultPolicy
    public var rules: [PolicyRule]
    public var temporaryRules: [TemporaryRule]
    /// Category → domain map for CATEGORY rules, e.g. `{ "social": ["tiktok.com", …] }`.
    /// Travels inside the SIGNED snapshot so categories are enforced offline; the
    /// separately-downloaded Bloom filter set is unioned with it (see
    /// `CategoryFilters`). Optional: the backend inlines only the categories a
    /// given policy actually enforces, and may inline none when the device is on
    /// the Bloom path.
    public var categories: [String: [String]]?
    public var issuedAt: Date
    /// Ed25519 (base64) over the canonical JSON of everything above.
    public var signature: String

    public init(version: Int, familyId: String, childId: String, deviceId: String,
                defaults: DefaultPolicy, rules: [PolicyRule], temporaryRules: [TemporaryRule],
                categories: [String: [String]]? = nil, issuedAt: Date, signature: String) {
        self.version = version; self.familyId = familyId; self.childId = childId
        self.deviceId = deviceId; self.defaults = defaults; self.rules = rules
        self.temporaryRules = temporaryRules; self.categories = categories
        self.issuedAt = issuedAt; self.signature = signature
    }
}

public struct EvalResult {
    public var action: RuleAction
    /// Which tier decided — "safety-floor", "temporary:TIMED", "rule:DOMAIN",
    /// "default:web", … Matches the TS `reason` strings.
    public var reason: String
    public var matchedRuleId: String?
    public var matchedKey: String?

    /// FALSE for safety-floor hits. `shared/safety/safety-floor.ts`: reaching a
    /// crisis line is never reported to parents — "a floor that is surveilled is
    /// not a floor". Callers must consult this before logging a URL or emitting
    /// an activity report.
    public var isReportable: Bool { reason != "safety-floor" }

    public init(action: RuleAction, reason: String, matchedRuleId: String? = nil, matchedKey: String? = nil) {
        self.action = action; self.reason = reason
        self.matchedRuleId = matchedRuleId; self.matchedKey = matchedKey
    }
}

// MARK: - Date handling

/// The backend emits ISO-8601 UTC produced by `Date.prototype.toISOString()`,
/// which ALWAYS carries milliseconds ("2026-08-30T12:00:00.000Z"). Foundation's
/// `JSONDecoder.DateDecodingStrategy.iso8601` uses `ISO8601DateFormatter` with
/// default options, which does NOT accept fractional seconds and would throw on
/// every real payload. These strategies accept both forms.
public enum PolicyDates {

    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let withoutFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? withoutFraction.date(from: s)
    }

    /// `toISOString()`-shaped output, for the PoC's own writes.
    public static func format(_ d: Date) -> String { withFraction.string(from: d) }

    public static var decoding: JSONDecoder.DateDecodingStrategy {
        .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            guard let d = parse(s) else {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath,
                    debugDescription: "not an ISO-8601 UTC timestamp: \(s)"))
            }
            return d
        }
    }

    public static var encoding: JSONEncoder.DateEncodingStrategy {
        .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(format(date))
        }
    }
}
