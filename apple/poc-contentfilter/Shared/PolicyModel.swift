import Foundation

/// Swift mirror of `shared/policy/policy-model.ts` (the authoritative spec).
/// Only the subset the PoC needs is ported; the evaluation ORDER must match.

public enum RuleAction: String, Codable { case allow = "ALLOW", block = "BLOCK" }

public enum PolicyTargetType: String, Codable {
    case domain = "DOMAIN", url = "URL", urlPattern = "URL_PATTERN"
    case ytVideo = "YOUTUBE_VIDEO", ytChannel = "YOUTUBE_CHANNEL", ytPlaylist = "YOUTUBE_PLAYLIST"
    case category = "CATEGORY", application = "APPLICATION"
}

public enum RuleScopeType: String, Codable { case family = "FAMILY", child = "CHILD", device = "DEVICE" }

public struct RuleScope: Codable {
    public var type: RuleScopeType
    public var familyId: String
    public var childId: String?
    public var deviceId: String?
}

public struct PolicyRule: Codable {
    public var id: String
    public var target: PolicyTargetType
    public var value: String
    public var action: RuleAction
    public var scope: RuleScope
    public var priority: Int?
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
}

public struct DefaultPolicy: Codable {
    public var webDefault: RuleAction
    public var youTubeDefault: RuleAction
}

public struct DevicePolicySnapshot: Codable {
    public var version: Int
    public var familyId: String
    public var childId: String
    public var deviceId: String
    public var defaults: DefaultPolicy
    public var rules: [PolicyRule]
    public var temporaryRules: [TemporaryRule]
    public var issuedAt: Date
    public var signature: String   // Ed25519 over canonical JSON; verified on load
}

public struct EvalResult {
    public var action: RuleAction
    public var reason: String
    public var matchedKey: String?
}
