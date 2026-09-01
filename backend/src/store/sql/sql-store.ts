/**
 * SqlStore — durable Repository over any SqlDatabase (node:sqlite or D1).
 * Same behavior as MemoryStore; the flow tests run against both.
 */
import type { Repository } from "../repository.js";
import type { SqlDatabase, SqlRow } from "./database.js";
import { SCHEMA_SQL, MIGRATIONS_SQL } from "./schema.js";
import { hostCandidates, normalizeHost } from "@ajar/shared/categories";
import type {
  Session,
  User, Family, FamilyMembership, Child, Device, EnrollmentToken,
  AccessRequest, ApprovalDecision, AuditEvent, NotificationEndpoint,
  PolicyRule, TemporaryRule, DefaultPolicy, RuleScope, Role, Platform,
  RuleAction, PolicyTargetType, ApprovalScope, ApprovalDuration,
  CategoryDomain, PasswordResetToken, EmailVerificationToken, PendingRegistration, TemporaryGrant,
  WebAuthnCredential, WebAuthnChallenge,
} from "../../domain/model.js";

const s = (v: unknown) => (v == null ? null : String(v));

function scopeOf(row: SqlRow): RuleScope {
  return {
    type: row.scope_type as RuleScope["type"],
    familyId: row.family_id as string,
    childId: (row.scope_child_id as string) ?? undefined,
    deviceId: (row.scope_device_id as string) ?? undefined,
  };
}

export class SqlStore implements Repository {
  private constructor(private db: SqlDatabase) {}

  static async create(db: SqlDatabase): Promise<SqlStore> {
    await db.exec(SCHEMA_SQL);
    // Bring a database created by an older build up to date. Each ALTER is
    // independent; "duplicate column" just means this one already ran.
    for (const stmt of MIGRATIONS_SQL) {
      try { await db.run(stmt, []); } catch { /* column already present */ }
    }
    return new SqlStore(db);
  }

  // users
  async createUser(u: User) {
    await this.db.run(
      "INSERT INTO users(id,email,display_name,password_hash,token_version,created_at,email_verified_at) VALUES(?,?,?,?,?,?,?)",
      [u.id, u.email, u.displayName, u.passwordHash ?? null, u.tokenVersion, u.createdAt, s(u.emailVerifiedAt)]);
    return u;
  }
  async updateUser(u: User) {
    await this.db.run("UPDATE users SET email=?, display_name=?, password_hash=?, token_version=?, email_verified_at=? WHERE id=?",
      [u.email, u.displayName, u.passwordHash ?? null, u.tokenVersion, s(u.emailVerifiedAt), u.id]);
    return u;
  }
  async getUser(id: string) { return this.mapUser(await this.db.get("SELECT * FROM users WHERE id=?", [id])); }
  async getUserByEmail(email: string) { return this.mapUser(await this.db.get("SELECT * FROM users WHERE email=?", [email])); }
  private mapUser(r: SqlRow | null): User | null {
    return r ? {
      id: r.id as string, email: r.email as string, displayName: r.display_name as string,
      passwordHash: (r.password_hash as string | null) ?? undefined,
      tokenVersion: Number(r.token_version ?? 0), createdAt: r.created_at as string,
      emailVerifiedAt: (r.email_verified_at as string | null) ?? undefined,
    } : null;
  }

  // sessions
  async createSession(s: Session) {
    await this.db.run("INSERT INTO sessions(id,user_id,label,created_at,last_used_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?)",
      [s.id, s.userId, s.label, s.createdAt, s.lastUsedAt, s.expiresAt, s.revokedAt ?? null]);
    return s;
  }
  async updateSession(s: Session) {
    await this.db.run("UPDATE sessions SET label=?, last_used_at=?, expires_at=?, revoked_at=? WHERE id=?",
      [s.label, s.lastUsedAt, s.expiresAt, s.revokedAt ?? null, s.id]);
    return s;
  }
  async getSession(id: string) { return this.mapSession(await this.db.get("SELECT * FROM sessions WHERE id=?", [id])); }
  async listSessionsForUser(userId: string) {
    return (await this.db.all("SELECT * FROM sessions WHERE user_id=?", [userId])).map((r) => this.mapSession(r)!);
  }
  private mapSession(r: SqlRow | null): Session | null {
    return r ? {
      id: r.id as string, userId: r.user_id as string, label: r.label as string,
      createdAt: r.created_at as string, lastUsedAt: r.last_used_at as string,
      expiresAt: r.expires_at as string, revokedAt: (r.revoked_at as string | null) ?? undefined,
    } : null;
  }

  // password reset tokens
  // --- passkeys -----------------------------------------------------------
  async createWebAuthnCredential(c: WebAuthnCredential) {
    await this.db.run(
      "INSERT INTO webauthn_credentials(id,user_id,public_key_cose,alg,sign_count,label,backed_up,created_at,last_used_at)"
      + " VALUES(?,?,?,?,?,?,?,?,?)",
      [c.id, c.userId, c.publicKeyCose, c.alg, c.signCount, c.label, c.backedUp ? 1 : 0, c.createdAt, s(c.lastUsedAt)]);
    return c;
  }
  async getWebAuthnCredential(id: string) {
    return this.mapCredential(await this.db.get("SELECT * FROM webauthn_credentials WHERE id=?", [id]));
  }
  async listWebAuthnCredentials(userId: string) {
    const rows = await this.db.all("SELECT * FROM webauthn_credentials WHERE user_id=? ORDER BY created_at", [userId]);
    return rows.map((r) => this.mapCredential(r)!).filter(Boolean);
  }
  async updateWebAuthnCredential(c: WebAuthnCredential) {
    await this.db.run("UPDATE webauthn_credentials SET sign_count=?, last_used_at=?, label=?, backed_up=? WHERE id=?",
      [c.signCount, s(c.lastUsedAt), c.label, c.backedUp ? 1 : 0, c.id]);
    return c;
  }
  async deleteWebAuthnCredential(id: string) {
    await this.db.run("DELETE FROM webauthn_credentials WHERE id=?", [id]);
  }
  private mapCredential(r: SqlRow | null): WebAuthnCredential | null {
    return r ? {
      id: r.id as string, userId: r.user_id as string, publicKeyCose: r.public_key_cose as string,
      alg: Number(r.alg), signCount: Number(r.sign_count), label: r.label as string,
      backedUp: Number(r.backed_up) === 1, createdAt: r.created_at as string,
      lastUsedAt: (r.last_used_at as string | null) ?? undefined,
    } : null;
  }
  async createWebAuthnChallenge(c: WebAuthnChallenge) {
    await this.db.run(
      "INSERT INTO webauthn_challenges(challenge,user_id,kind,expires_at,created_at) VALUES(?,?,?,?,?)",
      [c.challenge, s(c.userId), c.kind, c.expiresAt, c.createdAt]);
    return c;
  }
  async takeWebAuthnChallenge(challenge: string) {
    const r = await this.db.get("SELECT * FROM webauthn_challenges WHERE challenge=?", [challenge]);
    // Delete unconditionally — spent whether it was valid, expired or absent.
    // Leaving expired rows is how this table grows forever; leaving USED ones is
    // how an assertion gets replayed.
    await this.db.run("DELETE FROM webauthn_challenges WHERE challenge=?", [challenge]);
    return r ? {
      challenge: r.challenge as string,
      userId: (r.user_id as string | null) ?? undefined,
      kind: r.kind as WebAuthnChallenge["kind"],
      expiresAt: r.expires_at as string, createdAt: r.created_at as string,
    } : null;
  }

  async createPasswordResetToken(t: PasswordResetToken) {
    await this.db.run(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at,used_at) VALUES(?,?,?,?,?,?)",
      [t.id, t.userId, t.tokenHash, t.expiresAt, t.createdAt, s(t.usedAt)]);
    return t;
  }
  async getPasswordResetTokenByHash(tokenHash: string) {
    return this.mapReset(await this.db.get("SELECT * FROM password_reset_tokens WHERE token_hash=?", [tokenHash]));
  }
  async updatePasswordResetToken(t: PasswordResetToken) {
    await this.db.run("UPDATE password_reset_tokens SET used_at=? WHERE id=?", [s(t.usedAt), t.id]);
    return t;
  }
  async invalidatePasswordResetTokensForUser(userId: string, at: string) {
    await this.db.run("UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL", [at, userId]);
  }
  private mapReset(r: SqlRow | null): PasswordResetToken | null {
    return r ? {
      id: r.id as string, userId: r.user_id as string, tokenHash: r.token_hash as string,
      expiresAt: r.expires_at as string, createdAt: r.created_at as string,
      usedAt: (r.used_at as string | null) ?? undefined,
    } : null;
  }

  // email verification tokens
  async createEmailVerificationToken(t: EmailVerificationToken) {
    await this.db.run(
      "INSERT INTO email_verification_tokens(id,user_id,token_hash,expires_at,created_at,used_at) VALUES(?,?,?,?,?,?)",
      [t.id, t.userId, t.tokenHash, t.expiresAt, t.createdAt, s(t.usedAt)]);
    return t;
  }
  async getEmailVerificationTokenByHash(tokenHash: string) {
    return this.mapVerify(await this.db.get("SELECT * FROM email_verification_tokens WHERE token_hash=?", [tokenHash]));
  }
  async updateEmailVerificationToken(t: EmailVerificationToken) {
    await this.db.run("UPDATE email_verification_tokens SET used_at=? WHERE id=?", [s(t.usedAt), t.id]);
    return t;
  }
  async invalidateEmailVerificationTokensForUser(userId: string, at: string) {
    await this.db.run("UPDATE email_verification_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL", [at, userId]);
  }
  private mapVerify(r: SqlRow | null): EmailVerificationToken | null {
    return r ? {
      id: r.id as string, userId: r.user_id as string, tokenHash: r.token_hash as string,
      expiresAt: r.expires_at as string, createdAt: r.created_at as string,
      usedAt: (r.used_at as string | null) ?? undefined,
    } : null;
  }

  // pending registrations
  async createPendingRegistration(p: PendingRegistration) {
    await this.db.run(
      "INSERT INTO pending_registrations(id,email,display_name,password_hash,token_hash,expires_at,created_at,used_at) VALUES(?,?,?,?,?,?,?,?)",
      [p.id, p.email, p.displayName, p.passwordHash, p.tokenHash, p.expiresAt, p.createdAt, s(p.usedAt)]);
    return p;
  }
  async getPendingRegistrationByHash(tokenHash: string) {
    return this.mapPending(await this.db.get("SELECT * FROM pending_registrations WHERE token_hash=?", [tokenHash]));
  }
  async updatePendingRegistration(p: PendingRegistration) {
    await this.db.run("UPDATE pending_registrations SET used_at=? WHERE id=?", [s(p.usedAt), p.id]);
    return p;
  }
  async invalidatePendingRegistrationsForEmail(email: string, at: string) {
    await this.db.run("UPDATE pending_registrations SET used_at=? WHERE email=? AND used_at IS NULL", [at, email]);
  }
  private mapPending(r: SqlRow | null): PendingRegistration | null {
    return r ? {
      id: r.id as string, email: r.email as string, displayName: r.display_name as string,
      passwordHash: r.password_hash as string, tokenHash: r.token_hash as string,
      expiresAt: r.expires_at as string, createdAt: r.created_at as string,
      usedAt: (r.used_at as string | null) ?? undefined,
    } : null;
  }

  // families & membership
  async createFamily(f: Family) {
    await this.db.run("INSERT INTO families(id,name,created_at) VALUES(?,?,?)", [f.id, f.name, f.createdAt]);
    return f;
  }
  async getFamily(id: string) {
    const r = await this.db.get("SELECT * FROM families WHERE id=?", [id]);
    return r ? { id: r.id as string, name: r.name as string, createdAt: r.created_at as string } : null;
  }
  async addMembership(m: FamilyMembership) {
    await this.db.run("INSERT INTO memberships(id,family_id,user_id,role,assigned_child_ids,created_at) VALUES(?,?,?,?,?,?)",
      [m.id, m.familyId, m.userId, m.role, JSON.stringify(m.assignedChildIds), m.createdAt]);
    return m;
  }
  async getMembership(familyId: string, userId: string) {
    return this.mapMembership(await this.db.get("SELECT * FROM memberships WHERE family_id=? AND user_id=?", [familyId, userId]));
  }
  async listMemberships(familyId: string) {
    return (await this.db.all("SELECT * FROM memberships WHERE family_id=?", [familyId])).map((r) => this.mapMembership(r)!);
  }
  async listMembershipsForUser(userId: string) {
    return (await this.db.all("SELECT * FROM memberships WHERE user_id=?", [userId])).map((r) => this.mapMembership(r)!);
  }
  private mapMembership(r: SqlRow | null): FamilyMembership | null {
    return r ? {
      id: r.id as string, familyId: r.family_id as string, userId: r.user_id as string, role: r.role as Role,
      assignedChildIds: JSON.parse((r.assigned_child_ids as string) ?? "[]"), createdAt: r.created_at as string,
    } : null;
  }

  // children & devices
  async createChild(c: Child) {
    await this.db.run("INSERT INTO children(id,family_id,display_name,timezone,created_at) VALUES(?,?,?,?,?)",
      [c.id, c.familyId, c.displayName, c.timezone ?? "UTC", c.createdAt]);
    return c;
  }
  async getChild(id: string) { return this.mapChild(await this.db.get("SELECT * FROM children WHERE id=?", [id])); }
  async listChildren(familyId: string) {
    return (await this.db.all("SELECT * FROM children WHERE family_id=?", [familyId])).map((r) => this.mapChild(r)!);
  }
  private mapChild(r: SqlRow | null): Child | null {
    return r ? {
      id: r.id as string, familyId: r.family_id as string, displayName: r.display_name as string,
      timezone: (r.timezone as string) || "UTC", createdAt: r.created_at as string,
    } : null;
  }

  async createDevice(d: Device) { await this.upsertDevice(d); return d; }
  async updateDevice(d: Device) { await this.upsertDevice(d); return d; }
  private async upsertDevice(d: Device) {
    await this.db.run(
      `INSERT INTO devices(id,family_id,child_id,platform,display_name,device_public_key,enrolled_at,last_synced_version,last_seen_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
         last_synced_version=excluded.last_synced_version, last_seen_at=excluded.last_seen_at`,
      [d.id, d.familyId, d.childId, d.platform, d.displayName, d.devicePublicKey, d.enrolledAt,
       d.lastSyncedVersion, s(d.lastSeenAt)]);
  }
  async getDevice(id: string) { return this.mapDevice(await this.db.get("SELECT * FROM devices WHERE id=?", [id])); }
  async listDevices(familyId: string) {
    return (await this.db.all("SELECT * FROM devices WHERE family_id=?", [familyId])).map((r) => this.mapDevice(r)!);
  }
  async listDevicesForChild(childId: string) {
    return (await this.db.all("SELECT * FROM devices WHERE child_id=?", [childId])).map((r) => this.mapDevice(r)!);
  }

  async deleteChildCascade(familyId: string, childId: string) {
    for (const d of await this.listDevicesForChild(childId)) {
      if (d.familyId === familyId) await this.deleteDeviceCascade(familyId, d.id);
    }
    await this.db.run("DELETE FROM rules WHERE family_id=? AND scope_child_id=?", [familyId, childId]);
    await this.db.run("DELETE FROM temp_rules WHERE family_id=? AND scope_child_id=?", [familyId, childId]);
    await this.db.run("DELETE FROM access_requests WHERE family_id=? AND child_id=?", [familyId, childId]);
    await this.db.run("DELETE FROM default_policy WHERE family_id=? AND child_id=?", [familyId, childId]);
    await this.db.run("DELETE FROM policy_versions WHERE family_id=? AND child_id=?", [familyId, childId]);
    await this.db.run("DELETE FROM children WHERE id=? AND family_id=?", [childId, familyId]);
    // Drop the child from any LIMITED_GUARDIAN assignment (no dangling ids).
    for (const m of await this.listMemberships(familyId)) {
      if (!m.assignedChildIds.includes(childId)) continue;
      await this.db.run("UPDATE memberships SET assigned_child_ids=? WHERE id=?",
        [JSON.stringify(m.assignedChildIds.filter((c) => c !== childId)), m.id]);
    }
  }

  async deleteFamilyCascade(familyId: string) {
    for (const c of await this.listChildren(familyId)) {
      await this.deleteChildCascade(familyId, c.id);
    }
    // Rows scoped to the FAMILY rather than to any child survive the loop above,
    // so they are swept explicitly. A family-scoped rule left behind would be a
    // dangling permission with nothing to check it against.
    await this.db.run("DELETE FROM devices WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM rules WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM temp_rules WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM access_requests WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM approval_decisions WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM enrollment_tokens WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM memberships WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM default_policy WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM policy_versions WHERE family_id=?", [familyId]);
    // The audit log goes too. It is a record OF this family — who approved what
    // for which child — so keeping it after an erasure request would keep the
    // most sensitive thing we hold about them.
    await this.db.run("DELETE FROM audit_events WHERE family_id=?", [familyId]);
    await this.db.run("DELETE FROM families WHERE id=?", [familyId]);
  }

  async deleteUserCascade(userId: string) {
    // Read the address before the row goes: a pending sign-up for the same
    // address would otherwise outlive the account and let a link from before the
    // deletion recreate it.
    const user = await this.getUser(userId);
    await this.db.run("DELETE FROM sessions WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM webauthn_credentials WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM webauthn_challenges WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM notification_endpoints WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM password_reset_tokens WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM email_verification_tokens WHERE user_id=?", [userId]);
    await this.db.run("DELETE FROM memberships WHERE user_id=?", [userId]);
    if (user) await this.db.run("DELETE FROM pending_registrations WHERE email=?", [user.email]);
    await this.db.run("DELETE FROM users WHERE id=?", [userId]);
  }

  async deleteDeviceCascade(familyId: string, deviceId: string) {
    await this.db.run("DELETE FROM rules WHERE family_id=? AND scope_device_id=?", [familyId, deviceId]);
    await this.db.run("DELETE FROM temp_rules WHERE family_id=? AND scope_device_id=?", [familyId, deviceId]);
    await this.db.run("DELETE FROM access_requests WHERE family_id=? AND device_id=?", [familyId, deviceId]);
    await this.db.run("DELETE FROM devices WHERE id=? AND family_id=?", [deviceId, familyId]);
  }
  private mapDevice(r: SqlRow | null): Device | null {
    return r ? {
      id: r.id as string, familyId: r.family_id as string, childId: r.child_id as string, platform: r.platform as Platform,
      displayName: r.display_name as string, devicePublicKey: r.device_public_key as string,
      enrolledAt: r.enrolled_at as string, lastSyncedVersion: Number(r.last_synced_version),
      lastSeenAt: (r.last_seen_at as string | null) ?? undefined,
    } : null;
  }

  // enrollment
  async createEnrollmentToken(t: EnrollmentToken) {
    await this.db.run(
      "INSERT INTO enrollment_tokens(id,code,family_id,child_id,platform,expires_at,redeemed_at,created_by) VALUES(?,?,?,?,?,?,?,?)",
      [t.id, t.code, t.familyId, t.childId, t.platform, t.expiresAt, s(t.redeemedAt), t.createdBy]);
    return t;
  }
  async getEnrollmentTokenByCode(code: string) {
    return this.mapToken(await this.db.get("SELECT * FROM enrollment_tokens WHERE code=?", [code]));
  }
  async updateEnrollmentToken(t: EnrollmentToken) {
    await this.db.run("UPDATE enrollment_tokens SET redeemed_at=? WHERE id=?", [s(t.redeemedAt), t.id]);
    return t;
  }
  private mapToken(r: SqlRow | null): EnrollmentToken | null {
    return r ? {
      id: r.id as string, code: r.code as string, familyId: r.family_id as string, childId: r.child_id as string,
      platform: r.platform as Platform, expiresAt: r.expires_at as string,
      redeemedAt: (r.redeemed_at as string) ?? undefined, createdBy: r.created_by as string,
    } : null;
  }

  // default policy
  async getDefaultPolicy(familyId: string, childId: string) {
    const r = await this.db.get("SELECT * FROM default_policy WHERE family_id=? AND child_id=?", [familyId, childId]);
    return r ? { webDefault: r.web_default as RuleAction, youTubeDefault: r.youtube_default as RuleAction } : null;
  }
  async setDefaultPolicy(familyId: string, childId: string, d: DefaultPolicy) {
    await this.db.run(
      `INSERT INTO default_policy(family_id,child_id,web_default,youtube_default) VALUES(?,?,?,?)
       ON CONFLICT(family_id,child_id) DO UPDATE SET web_default=excluded.web_default, youtube_default=excluded.youtube_default`,
      [familyId, childId, d.webDefault, d.youTubeDefault]);
  }

  // rules
  async createRule(r: PolicyRule) {
    await this.db.run(
      `INSERT INTO rules(id,family_id,target,value,action,scope_type,scope_child_id,scope_device_id,priority,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.scope.familyId, r.target, r.value, r.action, r.scope.type, s(r.scope.childId), s(r.scope.deviceId), r.priority ?? null, r.createdAt, r.createdBy]);
    return r;
  }
  // Scoped to the family, because the caller passes one and the tenancy check
  // upstream is about a DIFFERENT family's membership. Ignoring it made
  // `DELETE /v1/families/<mine>/rules/<a rule of yours>` return 200 and delete
  // your rule — the one tenancy hole in an otherwise clean set. It needs a known
  // rule id, so it was not remotely exploitable; it was still the store quietly
  // not honouring an argument its own signature declares.
  async deleteRule(familyId: string, ruleId: string) {
    await this.db.run("DELETE FROM rules WHERE id=? AND family_id=?", [ruleId, familyId]);
  }
  async listRules(familyId: string) {
    return (await this.db.all("SELECT * FROM rules WHERE family_id=?", [familyId])).map((r): PolicyRule => ({
      id: r.id as string, target: r.target as PolicyTargetType, value: r.value as string, action: r.action as RuleAction,
      scope: scopeOf(r), priority: r.priority == null ? undefined : Number(r.priority),
      createdAt: r.created_at as string, createdBy: r.created_by as string,
    }));
  }

  // temporary rules
  async createTemporaryRule(t: TemporaryGrant) {
    await this.db.run(
      `INSERT INTO temp_rules(id,family_id,target,value,action,scope_type,scope_child_id,scope_device_id,priority,created_at,created_by,starts_at,expires_at,request_id,approved_by,grant_kind,consumed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.scope.familyId, t.target, t.value, t.action, t.scope.type, s(t.scope.childId), s(t.scope.deviceId),
       t.priority ?? null, t.createdAt, t.createdBy, t.startsAt, t.expiresAt, t.requestId, t.approvedBy,
       t.grantKind, s(t.consumedAt)]);
    return t;
  }
  async getTemporaryRule(id: string) {
    const r = await this.db.get("SELECT * FROM temp_rules WHERE id=?", [id]);
    return r ? this.mapTemp(r) : null;
  }
  async listTemporaryRules(familyId: string) {
    return (await this.db.all("SELECT * FROM temp_rules WHERE family_id=?", [familyId])).map((r) => this.mapTemp(r));
  }
  /** Single-use consumption: the UPDATE itself is the guard, so two devices
   *  racing on the same grant cannot both spend it. */
  async deleteTemporaryRule(familyId: string, id: string) {
    await this.db.run("DELETE FROM temp_rules WHERE id=? AND family_id=?", [id, familyId]);
  }
  async markTemporaryRuleConsumed(id: string, at: string) {
    const before = await this.getTemporaryRule(id);
    if (!before || before.consumedAt) return false;
    await this.db.run("UPDATE temp_rules SET consumed_at=? WHERE id=? AND consumed_at IS NULL", [at, id]);
    const after = await this.getTemporaryRule(id);
    return after?.consumedAt === at;
  }
  private mapTemp(r: SqlRow): TemporaryGrant {
    return {
      id: r.id as string, target: r.target as PolicyTargetType, value: r.value as string, action: r.action as RuleAction,
      scope: scopeOf(r), priority: r.priority == null ? undefined : Number(r.priority),
      createdAt: r.created_at as string, createdBy: r.created_by as string,
      startsAt: r.starts_at as string, expiresAt: r.expires_at as string, requestId: r.request_id as string,
      approvedBy: r.approved_by as string, grantKind: r.grant_kind as TemporaryRule["grantKind"],
      consumedAt: (r.consumed_at as string | null) ?? undefined,
    };
  }

  // policy versions
  async bumpPolicyVersion(familyId: string, childId: string) {
    await this.db.run(
      `INSERT INTO policy_versions(family_id,child_id,version) VALUES(?,?,1)
       ON CONFLICT(family_id,child_id) DO UPDATE SET version = version + 1`,
      [familyId, childId]);
    return this.getPolicyVersion(familyId, childId);
  }
  async getPolicyVersion(familyId: string, childId: string) {
    const r = await this.db.get("SELECT version FROM policy_versions WHERE family_id=? AND child_id=?", [familyId, childId]);
    return r ? Number(r.version) : 0;
  }

  // access requests & decisions
  async createAccessRequest(r: AccessRequest) {
    await this.db.run(
      `INSERT INTO access_requests(id,family_id,child_id,device_id,target_type,target_value,title,url,reason,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.familyId, r.childId, r.deviceId, r.targetType, r.targetValue, s(r.title), s(r.url), s(r.reason), r.status, r.createdAt]);
    return r;
  }
  async getAccessRequest(id: string) { return this.mapRequest(await this.db.get("SELECT * FROM access_requests WHERE id=?", [id])); }
  async updateAccessRequest(r: AccessRequest) {
    // title/url/reason are updatable too: a deduped re-file can carry richer
    // context than the first bare request did (see ApprovalService.createRequest).
    await this.db.run("UPDATE access_requests SET status=?, title=?, url=?, reason=? WHERE id=?",
      [r.status, s(r.title), s(r.url), s(r.reason), r.id]);
    return r;
  }
  async listAccessRequests(familyId: string, status?: string) {
    const rows = status
      ? await this.db.all("SELECT * FROM access_requests WHERE family_id=? AND status=?", [familyId, status])
      : await this.db.all("SELECT * FROM access_requests WHERE family_id=?", [familyId]);
    return rows.map((r) => this.mapRequest(r)!);
  }
  private mapRequest(r: SqlRow | null): AccessRequest | null {
    return r ? {
      id: r.id as string, familyId: r.family_id as string, childId: r.child_id as string, deviceId: r.device_id as string,
      targetType: r.target_type as PolicyTargetType, targetValue: r.target_value as string,
      title: (r.title as string) ?? undefined, url: (r.url as string) ?? undefined, reason: (r.reason as string) ?? undefined,
      status: r.status as AccessRequest["status"], createdAt: r.created_at as string,
    } : null;
  }
  async createApprovalDecision(d: ApprovalDecision) {
    await this.db.run(
      `INSERT INTO approval_decisions(id,request_id,family_id,decided_by,decision,scope,duration,created_at,produced_rule_id)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [d.id, d.requestId, d.familyId, d.decidedBy, d.decision, d.scope, JSON.stringify(d.duration), d.createdAt, s(d.producedRuleId)]);
    return d;
  }

  // endpoints & audit
  // category dataset (feed-importable classification; see host-match.ts)
  async categoriesForHost(host: string) {
    const cands = hostCandidates(host);
    if (cands.length === 0) return [];
    const placeholders = cands.map(() => "?").join(",");
    const rows = await this.db.all<SqlRow>(
      `SELECT DISTINCT category FROM category_domains WHERE domain IN (${placeholders})`, cands);
    return rows.map((r) => r.category as string);
  }
  async listCategoryDomains(categories?: string[]) {
    let rows: SqlRow[];
    if (categories && categories.length > 0) {
      const ph = categories.map(() => "?").join(",");
      rows = await this.db.all<SqlRow>(`SELECT category, domain FROM category_domains WHERE category IN (${ph})`, categories);
    } else {
      rows = await this.db.all<SqlRow>("SELECT category, domain FROM category_domains");
    }
    return rows.map((r): CategoryDomain => ({ category: r.category as string, domain: r.domain as string }));
  }
  async categoryStats() {
    const rows = await this.db.all<SqlRow>(
      "SELECT category, COUNT(*) AS n FROM category_domains GROUP BY category ORDER BY category ASC");
    return rows.map((r) => ({ category: r.category as string, domainCount: Number(r.n ?? 0) }));
  }
  async replaceCategoryDomains(entries: CategoryDomain[]) {
    await this.db.run("DELETE FROM category_domains", []);
    for (const { category, domain } of entries) {
      const d = normalizeHost(domain);
      if (!d || !category) continue;
      await this.db.run("INSERT OR IGNORE INTO category_domains(category, domain) VALUES(?, ?)", [category, d]);
    }
    const cur = await this.getCategoryDatasetVersion();
    const next = cur + 1;
    await this.db.run(
      "INSERT INTO category_meta(id, version, updated_at) VALUES(1, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at",
      [next, new Date().toISOString()]);
    return next;
  }
  async getCategoryDatasetVersion() {
    const r = await this.db.get<SqlRow>("SELECT version FROM category_meta WHERE id=1", []);
    return r ? Number(r.version ?? 0) : 0;
  }

  async addNotificationEndpoint(e: NotificationEndpoint) {
    await this.db.run("INSERT INTO notification_endpoints(id,user_id,kind,token,created_at) VALUES(?,?,?,?,?)",
      [e.id, e.userId, e.kind, e.token, e.createdAt]);
    return e;
  }
  async listNotificationEndpoints(userId: string) {
    return (await this.db.all("SELECT * FROM notification_endpoints WHERE user_id=?", [userId])).map((r): NotificationEndpoint => ({
      id: r.id as string, userId: r.user_id as string, kind: r.kind as NotificationEndpoint["kind"],
      token: r.token as string, createdAt: r.created_at as string,
    }));
  }
  async addAuditEvent(e: AuditEvent) {
    await this.db.run("INSERT INTO audit_events(id,family_id,actor_id,kind,detail,created_at) VALUES(?,?,?,?,?,?)",
      [e.id, e.familyId, s(e.actorId), e.kind, JSON.stringify(e.detail), e.createdAt]);
    return e;
  }
  async listAuditEvents(familyId: string) {
    return (await this.db.all("SELECT * FROM audit_events WHERE family_id=? ORDER BY rowid ASC", [familyId])).map((r): AuditEvent => ({
      id: r.id as string, familyId: r.family_id as string, actorId: (r.actor_id as string) ?? undefined,
      kind: r.kind as string, detail: JSON.parse((r.detail as string) ?? "{}"), createdAt: r.created_at as string,
    }));
  }
}
