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
  /**
   * When the person holding this address proved they hold it. Absent means "not
   * proved" — including for every account created before verification existed,
   * which is why nothing is gated on it (see docs/SECURITY.md). Accounts created
   * through the verify-then-create flow are verified from their first moment.
   */
  emailVerifiedAt?: string;
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
/**
 * A registered passkey. The public key is public by definition, so nothing here
 * is a secret — which is the point of the whole mechanism: a database dump is
 * not a set of account takeovers, the way a password hash dump partially is.
 */
export interface WebAuthnCredential {
  /** base64url of the raw credential id the authenticator generated. */
  id: string;
  userId: string;
  /** COSE public key, base64url. Parsed back to a CryptoKey to verify. */
  publicKeyCose: string;
  /** COSE algorithm identifier (-7 ES256, -257 RS256). */
  alg: number;
  /**
   * The authenticator's own counter, last seen. A counter that goes BACKWARDS
   * means the same credential is being used from two places, which is how a
   * cloned authenticator shows itself. Many real authenticators — including
   * every synced passkey — always report 0, so a zero counter is normal and
   * only a decrease is evidence.
   */
  signCount: number;
  /** What the parent will recognise in a list: "iPhone", "1Password". */
  label: string;
  /** Synced to a cloud keychain (backup-eligible), per the BE flag. */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * A one-shot challenge for a ceremony in flight.
 *
 * Stored server-side rather than handed to the client signed, because it has to
 * be single-use and the simplest way to guarantee that is to delete it on
 * redemption. Short TTL: this is a live conversation with a browser, not
 * something that should still work tomorrow.
 */
export interface WebAuthnChallenge {
  /** base64url of 32 random bytes — the value the authenticator signs over. */
  challenge: string;
  /** Registration binds to a user; sign-in does not know who yet. */
  userId?: string;
  kind: "REGISTER" | "AUTHENTICATE";
  expiresAt: string;
  createdAt: string;
}

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
 * A single-use grant proving an address belongs to whoever asked. Same discipline
 * as PasswordResetToken: only base64url(SHA-256(raw)) is stored, so the table is
 * not a set of ready-made confirmations.
 */
export interface EmailVerificationToken {
  id: string;
  userId: string;
  /** base64url(SHA-256(rawToken)) — never the raw token. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

/**
 * A sign-up that has been ASKED FOR but not yet proved. No `users` row exists
 * yet — that is the whole point: `POST /v1/auth/register` answers identically
 * whether or not the address is already taken, so it cannot be used to test who
 * has an account, and the account only comes into being when someone opens the
 * link in that inbox. The password is stored already hashed (never in the clear,
 * not even for the hour this row lives), and the token only as its SHA-256.
 */
export interface PendingRegistration {
  id: string;
  email: string;
  displayName: string;
  /** PBKDF2 hash of the password the person chose (auth/password.ts). */
  passwordHash: string;
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
