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
  /** Auth is a skeleton for the alpha: opaque credential ref, not a password store. */
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
  lastSyncedVersion: number;
}

/** Short-lived, single-use enrollment token binding a device to a family+child. */
export interface EnrollmentToken {
  id: string;
  code: string; // six-digit or opaque; single-use
  familyId: string;
  childId: string;
  platform: Platform;
  expiresAt: string;
  redeemedAt?: string;
  createdBy: string; // user id
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

export type PushKind = "APNS" | "WEBSOCKET" | "CONSOLE";

export interface NotificationEndpoint {
  id: string;
  userId: string;
  kind: PushKind;
  token: string; // APNs device token, ws connection id, etc.
  createdAt: string;
}

/** A signed, versioned policy container per child+device (the sync unit). */
export interface DevicePolicyVersion {
  familyId: string;
  childId: string;
  deviceId: string;
  version: number;
  updatedAt: string;
}
