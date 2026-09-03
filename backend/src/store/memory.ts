/**
 * In-memory Repository. Fully functional for the alpha and for tests; no
 * external services. For durable deployments the SqlStore (node:sqlite or
 * Cloudflare D1) replaces this behind the same interface.
 */
import type { Repository } from "./repository.js";
import { hostCandidates, normalizeHost } from "@ajar/shared/categories";
import type {
  WebAuthnCredential,
  WebAuthnChallenge,
  Session,
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
  CategoryDomain,
  PasswordResetToken,
  EmailVerificationToken,
  PendingRegistration,
  TemporaryGrant,
} from "../domain/model.js";

const clone = <T>(v: T): T => structuredClone(v);
const versionKey = (familyId: string, childId: string) => `${familyId}:${childId}`;

export class MemoryStore implements Repository {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private families = new Map<string, Family>();
  private memberships = new Map<string, FamilyMembership>();
  private children = new Map<string, Child>();
  private devices = new Map<string, Device>();
  private enrollments = new Map<string, EnrollmentToken>();
  private defaults = new Map<string, DefaultPolicy>();
  private rules = new Map<string, PolicyRule>();
  private tempRules = new Map<string, TemporaryGrant>();
  private resetTokens = new Map<string, PasswordResetToken>();
  private verifyTokens = new Map<string, EmailVerificationToken>();
  private pendingRegistrations = new Map<string, PendingRegistration>();
  private versions = new Map<string, number>();
  private requests = new Map<string, AccessRequest>();
  private decisions = new Map<string, ApprovalDecision>();
  private endpoints = new Map<string, NotificationEndpoint>();
  private audit: AuditEvent[] = [];
  // domain → set of categories, plus a monotonic dataset version.
  private categoryDomains = new Map<string, Set<string>>();
  private categoryVersion = 0;

  async createUser(u: User) { this.users.set(u.id, clone(u)); return clone(u); }
  async updateUser(u: User) { this.users.set(u.id, clone(u)); return clone(u); }
  async getUser(id: string) { const v = this.users.get(id); return v ? clone(v) : null; }
  async getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return clone(u);
    return null;
  }

  async createSession(s: Session) { this.sessions.set(s.id, clone(s)); return clone(s); }
  async getSession(id: string) { const v = this.sessions.get(id); return v ? clone(v) : null; }
  async updateSession(s: Session) { this.sessions.set(s.id, clone(s)); return clone(s); }
  async listSessionsForUser(userId: string) {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map(clone);
  }

  // --- passkeys -----------------------------------------------------------
  private credentials = new Map<string, WebAuthnCredential>();
  private challenges = new Map<string, WebAuthnChallenge>();

  async createWebAuthnCredential(c: WebAuthnCredential) { this.credentials.set(c.id, clone(c)); return clone(c); }
  async getWebAuthnCredential(id: string) { const c = this.credentials.get(id); return c ? clone(c) : null; }
  async listWebAuthnCredentials(userId: string) {
    return [...this.credentials.values()].filter((c) => c.userId === userId).map(clone);
  }
  async updateWebAuthnCredential(c: WebAuthnCredential) { this.credentials.set(c.id, clone(c)); return clone(c); }
  async deleteWebAuthnCredential(id: string) { this.credentials.delete(id); }
  async createWebAuthnChallenge(c: WebAuthnChallenge) { this.challenges.set(c.challenge, clone(c)); return clone(c); }
  async takeWebAuthnChallenge(challenge: string) {
    const c = this.challenges.get(challenge);
    // Deleted whether or not it had expired: a used challenge is spent either
    // way, and leaving expired rows behind is how this map grows without bound.
    this.challenges.delete(challenge);
    return c ? clone(c) : null;
  }

  async createPasswordResetToken(t: PasswordResetToken) { this.resetTokens.set(t.id, clone(t)); return clone(t); }
  async getPasswordResetTokenByHash(tokenHash: string) {
    for (const t of this.resetTokens.values()) if (t.tokenHash === tokenHash) return clone(t);
    return null;
  }
  async updatePasswordResetToken(t: PasswordResetToken) { this.resetTokens.set(t.id, clone(t)); return clone(t); }
  async invalidatePasswordResetTokensForUser(userId: string, at: string) {
    for (const t of this.resetTokens.values())
      if (t.userId === userId && !t.usedAt) this.resetTokens.set(t.id, { ...clone(t), usedAt: at });
  }

  async createEmailVerificationToken(t: EmailVerificationToken) { this.verifyTokens.set(t.id, clone(t)); return clone(t); }
  async getEmailVerificationTokenByHash(tokenHash: string) {
    for (const t of this.verifyTokens.values()) if (t.tokenHash === tokenHash) return clone(t);
    return null;
  }
  async updateEmailVerificationToken(t: EmailVerificationToken) { this.verifyTokens.set(t.id, clone(t)); return clone(t); }
  async invalidateEmailVerificationTokensForUser(userId: string, at: string) {
    for (const t of this.verifyTokens.values())
      if (t.userId === userId && !t.usedAt) this.verifyTokens.set(t.id, { ...clone(t), usedAt: at });
  }

  async createPendingRegistration(p: PendingRegistration) { this.pendingRegistrations.set(p.id, clone(p)); return clone(p); }
  async getPendingRegistrationByHash(tokenHash: string) {
    for (const p of this.pendingRegistrations.values()) if (p.tokenHash === tokenHash) return clone(p);
    return null;
  }
  async updatePendingRegistration(p: PendingRegistration) { this.pendingRegistrations.set(p.id, clone(p)); return clone(p); }
  async invalidatePendingRegistrationsForEmail(email: string, at: string) {
    for (const p of this.pendingRegistrations.values())
      if (p.email === email && !p.usedAt) this.pendingRegistrations.set(p.id, { ...clone(p), usedAt: at });
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
  async listDevicesForChild(childId: string) {
    return [...this.devices.values()].filter((d) => d.childId === childId).map(clone);
  }

  async deleteChildCascade(familyId: string, childId: string) {
    for (const d of [...this.devices.values()])
      if (d.familyId === familyId && d.childId === childId) await this.deleteDeviceCascade(familyId, d.id);
    for (const [id, r] of [...this.rules])
      if (r.scope.familyId === familyId && r.scope.childId === childId) this.rules.delete(id);
    for (const [id, t] of [...this.tempRules])
      if (t.scope.familyId === familyId && t.scope.childId === childId) this.tempRules.delete(id);
    for (const [id, r] of [...this.requests])
      if (r.familyId === familyId && r.childId === childId) this.requests.delete(id);
    this.defaults.delete(versionKey(familyId, childId));
    this.versions.delete(versionKey(familyId, childId));
    for (const [id, c] of [...this.children])
      if (c.id === childId && c.familyId === familyId) this.children.delete(id);
    // A guardian assigned only to this child must not keep a dangling assignment.
    for (const [id, m] of [...this.memberships]) {
      if (m.familyId !== familyId || !m.assignedChildIds.includes(childId)) continue;
      this.memberships.set(id, { ...clone(m), assignedChildIds: m.assignedChildIds.filter((c) => c !== childId) });
    }
  }

  async deleteFamilyCascade(familyId: string) {
    for (const c of [...this.children.values()]) {
      if (c.familyId === familyId) await this.deleteChildCascade(familyId, c.id);
    }
    // Devices, rules and grants scoped to the FAMILY rather than to any child
    // survive deleteChildCascade, so they are swept explicitly. A family-scoped
    // rule left behind would be a dangling permission with nothing to check it
    // against.
    for (const [id, d] of [...this.devices]) if (d.familyId === familyId) this.devices.delete(id);
    for (const [id, r] of [...this.rules]) if (r.scope.familyId === familyId) this.rules.delete(id);
    for (const [id, t] of [...this.tempRules]) if (t.scope.familyId === familyId) this.tempRules.delete(id);
    for (const [id, r] of [...this.requests]) if (r.familyId === familyId) this.requests.delete(id);
    for (const [id, d] of [...this.decisions]) if (d.familyId === familyId) this.decisions.delete(id);
    for (const [id, e] of [...this.enrollments]) if (e.familyId === familyId) this.enrollments.delete(id);
    for (const [id, m] of [...this.memberships]) if (m.familyId === familyId) this.memberships.delete(id);
    for (const k of [...this.defaults.keys()]) if (k.startsWith(`${familyId}:`)) this.defaults.delete(k);
    for (const k of [...this.versions.keys()]) if (k.startsWith(`${familyId}:`)) this.versions.delete(k);
    // The audit log goes too. It is a record OF this family — who approved what
    // for which child — so keeping it after an erasure request would keep the
    // most sensitive thing we hold about them.
    this.audit = this.audit.filter((a) => a.familyId !== familyId);
    this.families.delete(familyId);
  }

  async deleteUserCascade(userId: string) {
    for (const [id, s] of [...this.sessions]) if (s.userId === userId) this.sessions.delete(id);
    for (const [id, c] of [...this.credentials]) if (c.userId === userId) this.credentials.delete(id);
    for (const [k, c] of [...this.challenges]) if (c.userId === userId) this.challenges.delete(k);
    for (const [id, e] of [...this.endpoints]) if (e.userId === userId) this.endpoints.delete(id);
    for (const [k, t] of [...this.resetTokens]) if (t.userId === userId) this.resetTokens.delete(k);
    for (const [k, t] of [...this.verifyTokens]) if (t.userId === userId) this.verifyTokens.delete(k);
    for (const [id, m] of [...this.memberships]) if (m.userId === userId) this.memberships.delete(id);
    const user = this.users.get(userId);
    // A pending sign-up for the same address would otherwise outlive the account
    // and let it be recreated by a link from before the deletion.
    if (user) {
      for (const [k, p] of [...this.pendingRegistrations]) {
        if (p.email === user.email) this.pendingRegistrations.delete(k);
      }
    }
    this.users.delete(userId);
  }

  async deleteDeviceCascade(familyId: string, deviceId: string) {
    for (const [id, r] of [...this.rules])
      if (r.scope.familyId === familyId && r.scope.deviceId === deviceId) this.rules.delete(id);
    for (const [id, t] of [...this.tempRules])
      if (t.scope.familyId === familyId && t.scope.deviceId === deviceId) this.tempRules.delete(id);
    for (const [id, r] of [...this.requests])
      if (r.familyId === familyId && r.deviceId === deviceId) this.requests.delete(id);
    const d = this.devices.get(deviceId);
    if (d && d.familyId === familyId) this.devices.delete(deviceId);
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
  // See the SQL store: the familyId argument is honoured, not ignored.
  async deleteRule(familyId: string, ruleId: string) {
    const r = this.rules.get(ruleId);
    if (r && r.scope.familyId === familyId) this.rules.delete(ruleId);
  }
  async listRules(familyId: string) {
    return [...this.rules.values()].filter((r) => r.scope.familyId === familyId).map(clone);
  }

  async createTemporaryRule(t: TemporaryGrant) { this.tempRules.set(t.id, clone(t)); return clone(t); }
  async getTemporaryRule(id: string) { const v = this.tempRules.get(id); return v ? clone(v) : null; }
  async listTemporaryRules(familyId: string) {
    return [...this.tempRules.values()].filter((t) => t.scope.familyId === familyId).map(clone);
  }
  async deleteTemporaryRule(familyId: string, id: string) {
    const t = this.tempRules.get(id);
    if (t && t.scope.familyId === familyId) this.tempRules.delete(id);
  }

  async markTemporaryRuleConsumed(id: string, at: string) {
    const t = this.tempRules.get(id);
    if (!t || t.consumedAt) return false;
    this.tempRules.set(id, { ...clone(t), consumedAt: at });
    return true;
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

  // category dataset
  async categoriesForHost(host: string) {
    const cats = new Set<string>();
    for (const cand of hostCandidates(host))
      for (const c of this.categoryDomains.get(cand) ?? []) cats.add(c);
    return [...cats];
  }
  async listCategoryDomains(categories?: string[]) {
    const want = categories ? new Set(categories) : null;
    const out: CategoryDomain[] = [];
    for (const [domain, cats] of this.categoryDomains)
      for (const category of cats)
        if (!want || want.has(category)) out.push({ category, domain });
    return out;
  }
  async categoryStats() {
    const counts = new Map<string, number>();
    for (const cats of this.categoryDomains.values())
      for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts].map(([category, domainCount]) => ({ category, domainCount }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }
  async replaceCategoryDomains(entries: CategoryDomain[]) {
    this.categoryDomains = new Map();
    for (const { category, domain } of entries) {
      const d = normalizeHost(domain);
      if (!d || !category) continue;
      (this.categoryDomains.get(d) ?? this.categoryDomains.set(d, new Set()).get(d)!).add(category);
    }
    return ++this.categoryVersion;
  }
  async getCategoryDatasetVersion() { return this.categoryVersion; }

  async addNotificationEndpoint(e: NotificationEndpoint) { this.endpoints.set(e.id, clone(e)); return clone(e); }
  async listNotificationEndpoints(userId: string) {
    return [...this.endpoints.values()].filter((e) => e.userId === userId).map(clone);
  }
  async addAuditEvent(e: AuditEvent) { this.audit.push(clone(e)); return clone(e); }
  async listAuditEvents(familyId: string) {
    return this.audit.filter((e) => e.familyId === familyId).map(clone);
  }
}
