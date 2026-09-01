/**
 * Repository interface. Implementations: in-memory (dev) and a SQL store backed
 * by node:sqlite (self-host) or Cloudflare D1 (Workers), all behind this same
 * interface. Services depend only on this interface.
 */
import type {
  User,
  Family,
  FamilyMembership,
  Child,
  Device,
  EnrollmentToken,
  AccessRequest,
  ApprovalDecision,
  AuditEvent,
  NotificationEndpoint,
  PolicyRule,
  DefaultPolicy,
  Session,
  CategoryDomain,
  PasswordResetToken,
  WebAuthnCredential,
  WebAuthnChallenge,
  EmailVerificationToken,
  PendingRegistration,
  TemporaryGrant,
} from "../domain/model.js";

export interface Repository {
  // users
  createUser(u: User): Promise<User>;
  updateUser(u: User): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

  // sessions (one per signed-in device; enables per-device token revocation)
  createSession(s: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  updateSession(s: Session): Promise<Session>;
  listSessionsForUser(userId: string): Promise<Session[]>;

  // password reset (single-use, 30-min, hashed at rest — see AuthService)
  // --- passkeys -----------------------------------------------------------
  createWebAuthnCredential(c: WebAuthnCredential): Promise<WebAuthnCredential>;
  getWebAuthnCredential(id: string): Promise<WebAuthnCredential | null>;
  listWebAuthnCredentials(userId: string): Promise<WebAuthnCredential[]>;
  updateWebAuthnCredential(c: WebAuthnCredential): Promise<WebAuthnCredential>;
  deleteWebAuthnCredential(id: string): Promise<void>;
  createWebAuthnChallenge(c: WebAuthnChallenge): Promise<WebAuthnChallenge>;
  /**
   * Fetch a challenge AND remove it. One call rather than get-then-delete so a
   * challenge cannot be redeemed twice by two requests racing between them —
   * single use is the property that stops a replayed assertion.
   */
  takeWebAuthnChallenge(challenge: string): Promise<WebAuthnChallenge | null>;

  createPasswordResetToken(t: PasswordResetToken): Promise<PasswordResetToken>;
  getPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | null>;
  updatePasswordResetToken(t: PasswordResetToken): Promise<PasswordResetToken>;
  /** Burn every outstanding token for a user (new request supersedes; reset used). */
  invalidatePasswordResetTokensForUser(userId: string, at: string): Promise<void>;

  // email verification (single-use, short-lived, hashed at rest — see AuthService)
  createEmailVerificationToken(t: EmailVerificationToken): Promise<EmailVerificationToken>;
  getEmailVerificationTokenByHash(tokenHash: string): Promise<EmailVerificationToken | null>;
  updateEmailVerificationToken(t: EmailVerificationToken): Promise<EmailVerificationToken>;
  invalidateEmailVerificationTokensForUser(userId: string, at: string): Promise<void>;

  // pending registrations (a sign-up that has not yet proved its address; no
  // `users` row exists until the link in that inbox is opened)
  createPendingRegistration(p: PendingRegistration): Promise<PendingRegistration>;
  getPendingRegistrationByHash(tokenHash: string): Promise<PendingRegistration | null>;
  updatePendingRegistration(p: PendingRegistration): Promise<PendingRegistration>;
  /** Burn every outstanding sign-up for an address (a newer attempt supersedes). */
  invalidatePendingRegistrationsForEmail(email: string, at: string): Promise<void>;

  // families & membership
  createFamily(f: Family): Promise<Family>;
  getFamily(id: string): Promise<Family | null>;
  addMembership(m: FamilyMembership): Promise<FamilyMembership>;
  getMembership(familyId: string, userId: string): Promise<FamilyMembership | null>;
  listMemberships(familyId: string): Promise<FamilyMembership[]>;
  listMembershipsForUser(userId: string): Promise<FamilyMembership[]>;

  // children & devices
  createChild(c: Child): Promise<Child>;
  getChild(id: string): Promise<Child | null>;
  listChildren(familyId: string): Promise<Child[]>;
  createDevice(d: Device): Promise<Device>;
  getDevice(id: string): Promise<Device | null>;
  updateDevice(d: Device): Promise<Device>;
  listDevices(familyId: string): Promise<Device[]>;
  listDevicesForChild(childId: string): Promise<Device[]>;

  /** Erasure. Both cascade: a deleted child takes its devices, rules, temporary
   *  grants, requests and default policy with it; a deleted device takes its
   *  device-scoped rules, grants and requests. Nothing is left dangling. */
  deleteChildCascade(familyId: string, childId: string): Promise<void>;
  deleteDeviceCascade(familyId: string, deviceId: string): Promise<void>;
  /**
   * Erase a whole family: every child (and so every device), every rule,
   * grant, request, decision, enrollment code, audit row and membership.
   * Used when the last owner closes their account — see AuthService.deleteAccount.
   */
  deleteFamilyCascade(familyId: string): Promise<void>;
  /**
   * Erase everything that belongs to ONE person: sessions, passkeys and their
   * pending challenges, notification endpoints, outstanding reset and
   * verification tokens, memberships, and the user row.
   *
   * Deliberately NOT families. Whether a family goes with its member is a
   * domain question — it depends on who else owns it — and answering it here
   * would either strand co-parents or delete their children's policy under
   * them. AuthService decides; this erases.
   */
  deleteUserCascade(userId: string): Promise<void>;

  // enrollment
  createEnrollmentToken(t: EnrollmentToken): Promise<EnrollmentToken>;
  getEnrollmentTokenByCode(code: string): Promise<EnrollmentToken | null>;
  updateEnrollmentToken(t: EnrollmentToken): Promise<EnrollmentToken>;

  // policy: default + standing rules, per family (scopes narrow to child/device)
  getDefaultPolicy(familyId: string, childId: string): Promise<DefaultPolicy | null>;
  setDefaultPolicy(familyId: string, childId: string, d: DefaultPolicy): Promise<void>;
  createRule(r: PolicyRule): Promise<PolicyRule>;
  deleteRule(familyId: string, ruleId: string): Promise<void>;
  listRules(familyId: string): Promise<PolicyRule[]>;

  // temporary rules (approvals). Stored as TemporaryGrant so the backend can
  // track single-use consumption without changing the shared wire contract.
  createTemporaryRule(t: TemporaryGrant): Promise<TemporaryGrant>;
  getTemporaryRule(id: string): Promise<TemporaryGrant | null>;
  listTemporaryRules(familyId: string): Promise<TemporaryGrant[]>;
  /** Mark a grant spent. Returns false if it was already consumed (idempotent
   *  callers get a definitive "someone beat you to it"). */
  markTemporaryRuleConsumed(id: string, at: string): Promise<boolean>;

  // policy version per (child, device)
  bumpPolicyVersion(familyId: string, childId: string): Promise<number>;
  getPolicyVersion(familyId: string, childId: string): Promise<number>;

  // access requests & decisions
  createAccessRequest(r: AccessRequest): Promise<AccessRequest>;
  getAccessRequest(id: string): Promise<AccessRequest | null>;
  updateAccessRequest(r: AccessRequest): Promise<AccessRequest>;
  listAccessRequests(familyId: string, status?: string): Promise<AccessRequest[]>;
  createApprovalDecision(d: ApprovalDecision): Promise<ApprovalDecision>;

  // category dataset (domain→category classification; feed-importable, never
  // hardcoded). `categoriesForHost` is the indexed lookup used on the hot path;
  // `listCategoryDomains` compiles the map inlined into device snapshots.
  categoriesForHost(host: string): Promise<string[]>;
  listCategoryDomains(categories?: string[]): Promise<CategoryDomain[]>;
  categoryStats(): Promise<{ category: string; domainCount: number }[]>;
  replaceCategoryDomains(entries: CategoryDomain[]): Promise<number>; // → new dataset version
  getCategoryDatasetVersion(): Promise<number>;

  // endpoints & audit
  addNotificationEndpoint(e: NotificationEndpoint): Promise<NotificationEndpoint>;
  listNotificationEndpoints(userId: string): Promise<NotificationEndpoint[]>;
  addAuditEvent(e: AuditEvent): Promise<AuditEvent>;
  listAuditEvents(familyId: string): Promise<AuditEvent[]>;
}
