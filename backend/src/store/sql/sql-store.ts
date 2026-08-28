/**
 * SqlStore — durable Repository over any SqlDatabase (node:sqlite or D1).
 * Same behavior as MemoryStore; the flow tests run against both.
 */
import type { Repository } from "../repository.js";
import type { SqlDatabase, SqlRow } from "./database.js";
import { SCHEMA_SQL } from "./schema.js";
import type {
  Session,
  User, Family, FamilyMembership, Child, Device, EnrollmentToken,
  AccessRequest, ApprovalDecision, AuditEvent, NotificationEndpoint,
  PolicyRule, TemporaryRule, DefaultPolicy, RuleScope, Role, Platform,
  RuleAction, PolicyTargetType, ApprovalScope, ApprovalDuration,
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
    return new SqlStore(db);
  }

  // users
  async createUser(u: User) {
    await this.db.run("INSERT INTO users(id,email,display_name,password_hash,token_version,created_at) VALUES(?,?,?,?,?,?)",
      [u.id, u.email, u.displayName, u.passwordHash ?? null, u.tokenVersion, u.createdAt]);
    return u;
  }
  async updateUser(u: User) {
    await this.db.run("UPDATE users SET email=?, display_name=?, password_hash=?, token_version=? WHERE id=?",
      [u.email, u.displayName, u.passwordHash ?? null, u.tokenVersion, u.id]);
    return u;
  }
  async getUser(id: string) { return this.mapUser(await this.db.get("SELECT * FROM users WHERE id=?", [id])); }
  async getUserByEmail(email: string) { return this.mapUser(await this.db.get("SELECT * FROM users WHERE email=?", [email])); }
  private mapUser(r: SqlRow | null): User | null {
    return r ? {
      id: r.id as string, email: r.email as string, displayName: r.display_name as string,
      passwordHash: (r.password_hash as string | null) ?? undefined,
      tokenVersion: Number(r.token_version ?? 0), createdAt: r.created_at as string,
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
    await this.db.run("INSERT INTO children(id,family_id,display_name,created_at) VALUES(?,?,?,?)",
      [c.id, c.familyId, c.displayName, c.createdAt]);
    return c;
  }
  async getChild(id: string) { return this.mapChild(await this.db.get("SELECT * FROM children WHERE id=?", [id])); }
  async listChildren(familyId: string) {
    return (await this.db.all("SELECT * FROM children WHERE family_id=?", [familyId])).map((r) => this.mapChild(r)!);
  }
  private mapChild(r: SqlRow | null): Child | null {
    return r ? { id: r.id as string, familyId: r.family_id as string, displayName: r.display_name as string, createdAt: r.created_at as string } : null;
  }

  async createDevice(d: Device) { await this.upsertDevice(d); return d; }
  async updateDevice(d: Device) { await this.upsertDevice(d); return d; }
  private async upsertDevice(d: Device) {
    await this.db.run(
      `INSERT INTO devices(id,family_id,child_id,platform,display_name,device_public_key,enrolled_at,last_synced_version)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, last_synced_version=excluded.last_synced_version`,
      [d.id, d.familyId, d.childId, d.platform, d.displayName, d.devicePublicKey, d.enrolledAt, d.lastSyncedVersion]);
  }
  async getDevice(id: string) { return this.mapDevice(await this.db.get("SELECT * FROM devices WHERE id=?", [id])); }
  async listDevices(familyId: string) {
    return (await this.db.all("SELECT * FROM devices WHERE family_id=?", [familyId])).map((r) => this.mapDevice(r)!);
  }
  private mapDevice(r: SqlRow | null): Device | null {
    return r ? {
      id: r.id as string, familyId: r.family_id as string, childId: r.child_id as string, platform: r.platform as Platform,
      displayName: r.display_name as string, devicePublicKey: r.device_public_key as string,
      enrolledAt: r.enrolled_at as string, lastSyncedVersion: Number(r.last_synced_version),
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
  async deleteRule(_familyId: string, ruleId: string) { await this.db.run("DELETE FROM rules WHERE id=?", [ruleId]); }
  async listRules(familyId: string) {
    return (await this.db.all("SELECT * FROM rules WHERE family_id=?", [familyId])).map((r): PolicyRule => ({
      id: r.id as string, target: r.target as PolicyTargetType, value: r.value as string, action: r.action as RuleAction,
      scope: scopeOf(r), priority: r.priority == null ? undefined : Number(r.priority),
      createdAt: r.created_at as string, createdBy: r.created_by as string,
    }));
  }

  // temporary rules
  async createTemporaryRule(t: TemporaryRule) {
    await this.db.run(
      `INSERT INTO temp_rules(id,family_id,target,value,action,scope_type,scope_child_id,scope_device_id,priority,created_at,created_by,starts_at,expires_at,request_id,approved_by,grant_kind)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.scope.familyId, t.target, t.value, t.action, t.scope.type, s(t.scope.childId), s(t.scope.deviceId),
       t.priority ?? null, t.createdAt, t.createdBy, t.startsAt, t.expiresAt, t.requestId, t.approvedBy, t.grantKind]);
    return t;
  }
  async listTemporaryRules(familyId: string) {
    return (await this.db.all("SELECT * FROM temp_rules WHERE family_id=?", [familyId])).map((r): TemporaryRule => ({
      id: r.id as string, target: r.target as PolicyTargetType, value: r.value as string, action: r.action as RuleAction,
      scope: scopeOf(r), priority: r.priority == null ? undefined : Number(r.priority),
      createdAt: r.created_at as string, createdBy: r.created_by as string,
      startsAt: r.starts_at as string, expiresAt: r.expires_at as string, requestId: r.request_id as string,
      approvedBy: r.approved_by as string, grantKind: r.grant_kind as TemporaryRule["grantKind"],
    }));
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
    await this.db.run("UPDATE access_requests SET status=? WHERE id=?", [r.status, r.id]);
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
