/**
 * In-memory Repository. Fully functional for the alpha and for tests; no
 * external services. For durable deployments the SqlStore (node:sqlite or
 * Cloudflare D1) replaces this behind the same interface.
 */
import type { Repository } from "./repository.js";
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

const clone = <T>(v: T): T => structuredClone(v);
const versionKey = (familyId: string, childId: string) => `${familyId}:${childId}`;

export class MemoryStore implements Repository {
  private users = new Map<string, User>();
  private families = new Map<string, Family>();
  private memberships = new Map<string, FamilyMembership>();
  private children = new Map<string, Child>();
  private devices = new Map<string, Device>();
  private enrollments = new Map<string, EnrollmentToken>();
  private defaults = new Map<string, DefaultPolicy>();
  private rules = new Map<string, PolicyRule>();
  private tempRules = new Map<string, TemporaryRule>();
  private versions = new Map<string, number>();
  private requests = new Map<string, AccessRequest>();
  private decisions = new Map<string, ApprovalDecision>();
  private endpoints = new Map<string, NotificationEndpoint>();
  private audit: AuditEvent[] = [];

  async createUser(u: User) { this.users.set(u.id, clone(u)); return clone(u); }
  async getUser(id: string) { const v = this.users.get(id); return v ? clone(v) : null; }
  async getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return clone(u);
    return null;
  }

  async createFamily(f: Family) { this.families.set(f.id, clone(f)); return clone(f); }
  async getFamily(id: string) { const v = this.families.get(id); return v ? clone(v) : null; }
  async addMembership(m: FamilyMembership) { this.memberships.set(m.id, clone(m)); return clone(m); }
  async getMembership(familyId: string, userId: string) {
    for (const m of this.memberships.values())
      if (m.familyId === familyId && m.userId === userId) return clone(m);
    return null;
  }
  async listMemberships(familyId: string) {
    return [...this.memberships.values()].filter((m) => m.familyId === familyId).map(clone);
  }
  async listMembershipsForUser(userId: string) {
    return [...this.memberships.values()].filter((m) => m.userId === userId).map(clone);
  }

  async createChild(c: Child) { this.children.set(c.id, clone(c)); return clone(c); }
  async getChild(id: string) { const v = this.children.get(id); return v ? clone(v) : null; }
  async listChildren(familyId: string) {
    return [...this.children.values()].filter((c) => c.familyId === familyId).map(clone);
  }
  async createDevice(d: Device) { this.devices.set(d.id, clone(d)); return clone(d); }
  async getDevice(id: string) { const v = this.devices.get(id); return v ? clone(v) : null; }
  async updateDevice(d: Device) { this.devices.set(d.id, clone(d)); return clone(d); }
  async listDevices(familyId: string) {
    return [...this.devices.values()].filter((d) => d.familyId === familyId).map(clone);
  }

  async createEnrollmentToken(t: EnrollmentToken) { this.enrollments.set(t.id, clone(t)); return clone(t); }
  async getEnrollmentTokenByCode(code: string) {
    for (const t of this.enrollments.values()) if (t.code === code) return clone(t);
    return null;
  }
  async updateEnrollmentToken(t: EnrollmentToken) { this.enrollments.set(t.id, clone(t)); return clone(t); }

  async getDefaultPolicy(familyId: string, childId: string) {
    const v = this.defaults.get(versionKey(familyId, childId));
    return v ? clone(v) : null;
  }
  async setDefaultPolicy(familyId: string, childId: string, d: DefaultPolicy) {
    this.defaults.set(versionKey(familyId, childId), clone(d));
  }
  async createRule(r: PolicyRule) { this.rules.set(r.id, clone(r)); return clone(r); }
  async deleteRule(_familyId: string, ruleId: string) { this.rules.delete(ruleId); }
  async listRules(familyId: string) {
    return [...this.rules.values()].filter((r) => r.scope.familyId === familyId).map(clone);
  }

  async createTemporaryRule(t: TemporaryRule) { this.tempRules.set(t.id, clone(t)); return clone(t); }
  async listTemporaryRules(familyId: string) {
    return [...this.tempRules.values()].filter((t) => t.scope.familyId === familyId).map(clone);
  }

  async bumpPolicyVersion(familyId: string, childId: string) {
    const k = versionKey(familyId, childId);
    const next = (this.versions.get(k) ?? 0) + 1;
    this.versions.set(k, next);
    return next;
  }
  async getPolicyVersion(familyId: string, childId: string) {
    return this.versions.get(versionKey(familyId, childId)) ?? 0;
  }

  async createAccessRequest(r: AccessRequest) { this.requests.set(r.id, clone(r)); return clone(r); }
  async getAccessRequest(id: string) { const v = this.requests.get(id); return v ? clone(v) : null; }
  async updateAccessRequest(r: AccessRequest) { this.requests.set(r.id, clone(r)); return clone(r); }
  async listAccessRequests(familyId: string, status?: string) {
    return [...this.requests.values()]
      .filter((r) => r.familyId === familyId && (!status || r.status === status))
      .map(clone);
  }
  async createApprovalDecision(d: ApprovalDecision) { this.decisions.set(d.id, clone(d)); return clone(d); }

  async addNotificationEndpoint(e: NotificationEndpoint) { this.endpoints.set(e.id, clone(e)); return clone(e); }
  async listNotificationEndpoints(userId: string) {
    return [...this.endpoints.values()].filter((e) => e.userId === userId).map(clone);
  }
  async addAuditEvent(e: AuditEvent) { this.audit.push(clone(e)); return clone(e); }
  async listAuditEvents(familyId: string) {
    return this.audit.filter((e) => e.familyId === familyId).map(clone);
  }
}
