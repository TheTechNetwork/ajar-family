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
  TemporaryRule,
  DefaultPolicy,
} from "../domain/model.js";

export interface Repository {
  // users
  createUser(u: User): Promise<User>;
  updateUser(u: User): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

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

  // temporary rules (approvals)
  createTemporaryRule(t: TemporaryRule): Promise<TemporaryRule>;
  listTemporaryRules(familyId: string): Promise<TemporaryRule[]>;

  // policy version per (child, device)
  bumpPolicyVersion(familyId: string, childId: string): Promise<number>;
  getPolicyVersion(familyId: string, childId: string): Promise<number>;

  // access requests & decisions
  createAccessRequest(r: AccessRequest): Promise<AccessRequest>;
  getAccessRequest(id: string): Promise<AccessRequest | null>;
  updateAccessRequest(r: AccessRequest): Promise<AccessRequest>;
  listAccessRequests(familyId: string, status?: string): Promise<AccessRequest[]>;
  createApprovalDecision(d: ApprovalDecision): Promise<ApprovalDecision>;

  // endpoints & audit
  addNotificationEndpoint(e: NotificationEndpoint): Promise<NotificationEndpoint>;
  listNotificationEndpoints(userId: string): Promise<NotificationEndpoint[]>;
  addAuditEvent(e: AuditEvent): Promise<AuditEvent>;
  listAuditEvents(familyId: string): Promise<AuditEvent[]>;
}
