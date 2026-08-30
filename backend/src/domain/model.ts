/**
 * Backend domain entities. Policy shapes (PolicyRule, TemporaryRule,
 * DevicePolicySnapshot, DefaultPolicy, targets/actions/scopes) are imported from
 * the shared source of truth so the server and every device adapter agree.
 */
import type {
  PolicyRule,
  TemporaryRule,
  DefaultPolicy,
  RuleAction,
  PolicyTargetType,
  RuleScope,
} from "@ajar/shared/policy";

export type {
  PolicyRule,
  TemporaryRule,
  DefaultPolicy,
  RuleAction,
  PolicyTargetType,
  RuleScope,
};

export type Role = "OWNER" | "PARENT" | "LIMITED_GUARDIAN";

export type Platform = "IOS" | "IPADOS" | "MACOS" | "WINDOWS";

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** PBKDF2 hash (auth/password.ts). Absent for users created without a password
   *  (e.g. a co-parent added by id who hasn't set one yet) — they cannot log in. */
  passwordHash?: string;
  /** Bumped on logout / password change to revoke every outstanding token. */
  tokenVersion: number;
  createdAt: string;
}

export interface Family {
  id: string;
  name: string;
  createdAt: string;
}

export interface FamilyMembership {
  id: string;
  familyId: string;
  userId: string;
  role: Role;
  /** For LIMITED_GUARDIAN: the children they may see/act on. Empty = all (OWNER/PARENT). */
  assignedChildIds: string[];
  createdAt: string;
}

export interface Child {
  id: string;
  familyId: string;
  displayName: string;
  /**
   * IANA time zone (e.g. "America/Los_Angeles"). Authoritative for anything a
   * parent thinks of in LOCAL time — above all "until the end of the day", which
   * before this field expired at UTC midnight (5pm in California, i.e. the grant
   * died mid-afternoon). Defaults to "UTC"; validated against Intl on write.
   */
  timezone: string;
  createdAt: string;
}

export interface Device {
  id: string;
  familyId: string;
  childId: string;
  platform: Platform;
  displayName: string;
  /** Public key (base64, raw Ed25519) the device generated at enrollment. */
  devicePublicKey: string;
  enrolledAt: string;
  /** Policy version this device last actually pulled (heartbeat, not enrollment). */
  lastSyncedVersion: number;
  /** Last time the device contacted the backend at all. Absent = never since
   *  enrollment. This is how a parent can tell whether protection is running. */
  lastSeenAt?: string;
}

/** Short-lived, single-use enrollment token binding a device to a family+child. */
export interface EnrollmentToken {
  id: string;
  code: string; // opaque single-use code (crypto-random)
  familyId: string;
  childId: string;
  platform: Platform;
  expiresAt: string;
  redeemedAt?: string;
  createdBy: string; // user id
}

/** One signed-in session per device/browser. The refresh + access tokens carry
 *  its `id` (sid); revoking a session invalidates that device only, immediately. */
export interface Session {
  id: string;
  userId: string;
  label: string; // best-effort device/client label (User-Agent or client-provided)
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string; // matches the refresh-token lifetime
  revokedAt?: string;
}

export type AccessRequestStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface AccessRequest {
  id: string;
  familyId: string;
  childId: string;
  deviceId: string;
  /** Canonical target the child asked for, e.g. "YOUTUBE_VIDEO:dQw4w9WgXcQ". */
  targetType: PolicyTargetType;
  targetValue: string;
  /** Human-facing context for the parent UI. */
  title?: string;
  url?: string;
  reason?: string;
  status: AccessRequestStatus;
  createdAt: string;
}

/** The narrowest-useful scope the parent can pick; never auto-broadened. */
export type ApprovalScope =
  | "THIS_REQUEST" // one-time, this exact target
  | "THIS_URL"
  | "THIS_VIDEO"
  | "THIS_CHANNEL"
  | "THIS_DOMAIN"
  | "THIS_DEVICE"
  | "THIS_CHILD"
  | "WHOLE_FAMILY";

/** Duration presets from the brief. */
export type ApprovalDuration =
  | { kind: "MINUTES"; minutes: number } // 15/30/60
  | { kind: "UNTIL_END_OF_DAY" }
  | { kind: "ONCE" }
  | { kind: "ALWAYS" }; // permanent standing rule

export interface ApprovalDecision {
  id: string;
  requestId: string;
  familyId: string;
  decidedBy: string; // user id — server-authoritative
  decision: RuleAction; // ALLOW or BLOCK
  scope: ApprovalScope;
  duration: ApprovalDuration;
  createdAt: string;
  /** The rule/temporary-rule this decision produced (if any). */
  producedRuleId?: string;
}

export interface AuditEvent {
  id: string;
  familyId: string;
  actorId?: string; // user or device id
  kind: string; // e.g. "policy.change", "approval.decided", "device.enrolled"
  detail: Record<string, unknown>;
  createdAt: string;
}

export type PushKind = "APNS" | "WEBSOCKET" | "CONSOLE" | "EMAIL" | "WEBPUSH";

export interface NotificationEndpoint {
  id: string;
  userId: string;
  kind: PushKind;
  /** APNs device token, Web Push subscription JSON, ws connection id, or — for
   *  EMAIL — the destination address. */
  token: string;
  createdAt: string;
}

/**
 * A single-use password-reset grant. Only the SHA-256 of the token is stored, so
 * a database leak does not hand out account takeovers; the raw token exists only
 * in the email we send. 30-minute TTL, consumed on first use, and redeeming it
 * bumps the user's tokenVersion so every outstanding session dies.
 */
export interface PasswordResetToken {
  id: string;
  userId: string;
  /** base64url(SHA-256(rawToken)) — never the raw token. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

/**
 * One (category, domain) classification in the categorization dataset. The
 * dataset is DATA in the store — seeded from a bundled list, replaceable from a
 * maintained feed via the import endpoint, never hardcoded into enforcement.
 */
export interface CategoryDomain {
  category: string; // slug, e.g. "social", "adult"
  domain: string;   // registrable root, lowercased (subdomains match by suffix)
}

/** A signed, versioned policy container per child+device (the sync unit). */
export interface DevicePolicyVersion {
  familyId: string;
  childId: string;
  deviceId: string;
  version: number;
  updatedAt: string;
}

/**
 * A TemporaryRule as the BACKEND stores it. `consumedAt` is server-side state
 * that never travels to the device: it is how a "just once" grant is actually
 * spent (see ApprovalService/`POST /v1/devices/{id}/grants/{ruleId}/consume`).
 * The shared `TemporaryRule` — the wire/enforcement contract every platform
 * adapter implements — deliberately stays unchanged, and snapshots ship the
 * shared shape with consumed grants dropped rather than flagged.
 */
export interface TemporaryGrant extends TemporaryRule {
  /** ISO-8601 when the device reported the grant used. Consumed grants are
   *  excluded from every snapshot from that moment on. */
  consumedAt?: string;
}
