/**
 * Application services: family/roles, enrollment, policy assembly + signed sync,
 * and the access-request → approval → temporary-rule flow. These reproduce the
 * shared evaluation model's inputs; the device runs the shared `evaluate()`.
 */
import { randomUUID } from "node:crypto";
import type { Repository } from "../store/repository.js";
import type { Notifier } from "../push/notifier.js";
import type { EventHub } from "../push/hub.js";
import { signSnapshot, signCanonical } from "./signing.js";
import type { CategoryFilterSet } from "@ajar/shared/categories";
import type {
  User, Session, Family, FamilyMembership, Child, Device, EnrollmentToken,
  AccessRequest, ApprovalDecision, Role, Platform, ApprovalScope, ApprovalDuration,
  PolicyRule, TemporaryRule, DefaultPolicy, PolicyTargetType, RuleScope,
} from "./model.js";
import type { DevicePolicySnapshot } from "@ajar/shared/policy";
import type { CategoryProvider } from "../categories/provider.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

const now = () => new Date().toISOString();
const uid = () => randomUUID();

// Enrollment code: 8 chars from a 32-symbol unambiguous alphabet (no 0/O/1/I/L)
// drawn from a CSPRNG => ~40 bits of entropy. With a 15-min TTL and rate-limited
// redemption this is not brute-forceable (vs. the old 6-digit Math.random code).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function enrollmentCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

export class DomainError extends Error {
  constructor(message: string, public code = "BAD_REQUEST") { super(message); }
}

// ---------------------------------------------------------------------------
// Auth — self-contained password credentials, no external identity provider.
// ---------------------------------------------------------------------------

export class AuthService {
  constructor(private repo: Repository) {}

  /** Register a parent with a password. Fails if the email is already taken. */
  async register(email: string, password: string, displayName: string): Promise<User> {
    if (!email || !displayName) throw new DomainError("email and displayName required");
    // Generic message (don't confirm which specific field is taken). Full
    // non-enumeration would require an email-verification flow — see SECURITY.md.
    if (await this.repo.getUserByEmail(email)) throw new DomainError("could not create an account with those details", "CONFLICT");
    const passwordHash = await hashPassword(password); // throws on too-short
    return this.repo.createUser({ id: uid(), email, displayName, passwordHash, tokenVersion: 0, createdAt: now() });
  }

  /** Verify email + password. One generic error either way (no user enumeration). */
  async authenticate(email: string, password: string): Promise<User> {
    const user = await this.repo.getUserByEmail(email);
    const okUser = user && (await verifyPassword(password, user.passwordHash));
    if (!user || !okUser) throw new DomainError("invalid email or password", "UNAUTHORIZED");
    return user;
  }

  /** Change password after confirming the current one; bumps tokenVersion so all
   *  other outstanding sessions are revoked. Returns the updated user. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user) throw new DomainError("unknown user", "NOT_FOUND");
    if (!(await verifyPassword(currentPassword, user.passwordHash)))
      throw new DomainError("current password is incorrect", "UNAUTHORIZED");
    const passwordHash = await hashPassword(newPassword);
    for (const s of await this.repo.listSessionsForUser(userId)) {
      if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
    }
    return this.repo.updateUser({ ...user, passwordHash, tokenVersion: user.tokenVersion + 1 });
  }

  /** Sign out EVERYWHERE: bump tokenVersion (kills all tokens) and mark every
   *  session record revoked so the session list reflects it. */
  async revokeAllSessions(userId: string): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user) throw new DomainError("unknown user", "NOT_FOUND");
    for (const s of await this.repo.listSessionsForUser(userId)) {
      if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
    }
    return this.repo.updateUser({ ...user, tokenVersion: user.tokenVersion + 1 });
  }

  /** Load a user and confirm the token's version is still current (not revoked). */
  async userForToken(userId: string, tv: number): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user || user.tokenVersion !== tv) throw new DomainError("session expired", "UNAUTHORIZED");
    return user;
  }

  // --- per-device sessions -------------------------------------------------

  /** Create a session for a new sign-in; its id (sid) is embedded in the tokens. */
  async startSession(userId: string, label: string, ttlSeconds: number): Promise<Session> {
    const t = now();
    return this.repo.createSession({
      id: uid(), userId, label: (label || "Unknown device").slice(0, 120),
      createdAt: t, lastUsedAt: t, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }

  /** True if a session is present, not revoked, and not expired. */
  async sessionActive(sid: string): Promise<boolean> {
    const s = await this.repo.getSession(sid);
    return !!s && !s.revokedAt && Date.parse(s.expiresAt) > Date.now();
  }

  /** Validate a refresh: user's tv matches, session live & owned; touch lastUsedAt. */
  async refreshSession(userId: string, tv: number, sid: string | undefined): Promise<{ user: User; sid: string }> {
    const user = await this.userForToken(userId, tv);
    if (!sid) throw new DomainError("session expired", "UNAUTHORIZED"); // pre-session token
    const s = await this.repo.getSession(sid);
    if (!s || s.userId !== userId || s.revokedAt || Date.parse(s.expiresAt) <= Date.now())
      throw new DomainError("session expired", "UNAUTHORIZED");
    await this.repo.updateSession({ ...s, lastUsedAt: now() });
    return { user, sid };
  }

  /** Active (non-revoked, non-expired) sessions for the user. */
  async listSessions(userId: string): Promise<Session[]> {
    const nowMs = Date.now();
    return (await this.repo.listSessionsForUser(userId))
      .filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > nowMs);
  }

  /** Revoke ONE session (this device only). Verifies ownership. */
  async revokeSession(userId: string, sid: string): Promise<void> {
    const s = await this.repo.getSession(sid);
    if (!s || s.userId !== userId) throw new DomainError("unknown session", "NOT_FOUND");
    if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
  }
}

// ---------------------------------------------------------------------------
// Roles / authorization
// ---------------------------------------------------------------------------

export function canApprove(role: Role): boolean {
  return role === "OWNER" || role === "PARENT" || role === "LIMITED_GUARDIAN";
}
export function canManagePolicy(role: Role): boolean {
  return role === "OWNER" || role === "PARENT";
}
export function canManageParents(role: Role): boolean {
  return role === "OWNER";
}

export class FamilyService {
  constructor(private repo: Repository) {}

  async createUser(email: string, displayName: string): Promise<User> {
    const existing = await this.repo.getUserByEmail(email);
    if (existing) return existing;
    return this.repo.createUser({ id: uid(), email, displayName, tokenVersion: 0, createdAt: now() });
  }

  async createFamily(name: string, ownerUserId: string): Promise<Family> {
    const fam = await this.repo.createFamily({ id: uid(), name, createdAt: now() });
    await this.repo.addMembership({
      id: uid(), familyId: fam.id, userId: ownerUserId, role: "OWNER",
      assignedChildIds: [], createdAt: now(),
    });
    await this.audit(fam.id, ownerUserId, "family.created", { name });
    return fam;
  }

  async addParent(familyId: string, actingUserId: string, newUserId: string, role: Role,
                  assignedChildIds: string[] = []): Promise<FamilyMembership> {
    await this.requireRole(familyId, actingUserId, canManageParents, "manage parents");
    const m = await this.repo.addMembership({
      id: uid(), familyId, userId: newUserId, role, assignedChildIds, createdAt: now(),
    });
    await this.audit(familyId, actingUserId, "family.parent_added", { newUserId, role });
    return m;
  }

  async addChild(familyId: string, actingUserId: string, displayName: string): Promise<Child> {
    await this.requireRole(familyId, actingUserId, canManagePolicy, "add child");
    const child = await this.repo.createChild({ id: uid(), familyId, displayName, createdAt: now() });
    // Default posture: default-deny YouTube, default-allow the rest of the web.
    await this.repo.setDefaultPolicy(familyId, child.id, { webDefault: "ALLOW", youTubeDefault: "BLOCK" });
    await this.repo.bumpPolicyVersion(familyId, child.id);
    await this.audit(familyId, actingUserId, "child.added", { childId: child.id, displayName });
    return child;
  }

  async membership(familyId: string, userId: string): Promise<FamilyMembership> {
    const m = await this.repo.getMembership(familyId, userId);
    if (!m) throw new DomainError("not a member of this family", "FORBIDDEN");
    return m;
  }

  private async requireRole(familyId: string, userId: string,
                            pred: (r: Role) => boolean, action: string) {
    const m = await this.membership(familyId, userId);
    if (!pred(m.role)) throw new DomainError(`role ${m.role} cannot ${action}`, "FORBIDDEN");
    return m;
  }

  private async audit(familyId: string, actorId: string, kind: string, detail: Record<string, unknown>) {
    await this.repo.addAuditEvent({ id: uid(), familyId, actorId, kind, detail, createdAt: now() });
  }
}

// ---------------------------------------------------------------------------
// Enrollment (short-lived, single-use token → device + device keypair)
// ---------------------------------------------------------------------------

export class EnrollmentService {
  constructor(private repo: Repository) {}

  async createToken(familyId: string, actingUserId: string, childId: string,
                    platform: Platform, ttlMinutes = 15): Promise<EnrollmentToken> {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m || !canManagePolicy(m.role)) throw new DomainError("cannot enroll devices", "FORBIDDEN");
    const child = await this.repo.getChild(childId);
    if (!child || child.familyId !== familyId) throw new DomainError("unknown child");
    const code = enrollmentCode(); // crypto-strong, ~40 bits (see below)
    return this.repo.createEnrollmentToken({
      id: uid(), code, familyId, childId, platform,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      createdBy: actingUserId,
    });
  }

  /** Redeemed by the child device, which supplies the public key it generated. */
  async redeem(code: string, devicePublicKey: string, displayName: string): Promise<Device> {
    const tok = await this.repo.getEnrollmentTokenByCode(code);
    if (!tok) throw new DomainError("invalid code", "NOT_FOUND");
    if (tok.redeemedAt) throw new DomainError("code already used", "GONE");
    if (Date.parse(tok.expiresAt) < Date.now()) throw new DomainError("code expired", "GONE");

    const device = await this.repo.createDevice({
      id: uid(), familyId: tok.familyId, childId: tok.childId, platform: tok.platform,
      displayName, devicePublicKey, enrolledAt: now(), lastSyncedVersion: 0,
    });
    tok.redeemedAt = now();
    await this.repo.updateEnrollmentToken(tok);
    await this.repo.addAuditEvent({
      id: uid(), familyId: tok.familyId, actorId: device.id, kind: "device.enrolled",
      detail: { childId: tok.childId, platform: tok.platform }, createdAt: now(),
    });
    return device;
  }
}

// ---------------------------------------------------------------------------
// Policy assembly + signed, versioned sync
// ---------------------------------------------------------------------------

export class PolicyService {
  constructor(
    private repo: Repository,
    private signingPrivateKeyB64: string,
    private categories: CategoryProvider,
  ) {}

  async setDefaults(familyId: string, actingUserId: string, childId: string, d: DefaultPolicy) {
    await this.requireManage(familyId, actingUserId);
    await this.repo.setDefaultPolicy(familyId, childId, d);
    await this.repo.bumpPolicyVersion(familyId, childId);
  }

  async addRule(familyId: string, actingUserId: string, rule: Omit<PolicyRule, "id" | "createdAt" | "createdBy">): Promise<PolicyRule> {
    await this.requireManage(familyId, actingUserId);
    const created = await this.repo.createRule({ ...rule, id: uid(), createdAt: now(), createdBy: actingUserId });
    await this.bumpForScope(familyId, rule.scope);
    return created;
  }

  async removeRule(familyId: string, actingUserId: string, ruleId: string) {
    await this.requireManage(familyId, actingUserId);
    await this.repo.deleteRule(familyId, ruleId);
    for (const child of await this.repo.listChildren(familyId))
      await this.repo.bumpPolicyVersion(familyId, child.id);
  }

  /** Build + sign the snapshot for one child+device at the current version. */
  async buildSnapshot(familyId: string, childId: string, deviceId: string): Promise<DevicePolicySnapshot> {
    const defaults = (await this.repo.getDefaultPolicy(familyId, childId))
      ?? { webDefault: "ALLOW", youTubeDefault: "BLOCK" };
    const nowMs = Date.now();
    const rules = (await this.repo.listRules(familyId))
      .filter((r) => this.appliesToChildDevice(r.scope, childId, deviceId));
    const temporaryRules = (await this.repo.listTemporaryRules(familyId))
      .filter((t) => this.appliesToChildDevice(t.scope, childId, deviceId))
      .filter((t) => Date.parse(t.expiresAt) > nowMs); // drop already-expired
    const version = await this.repo.getPolicyVersion(familyId, childId);

    // Inline ONLY the categories this policy actually enforces (referenced by a
    // CATEGORY rule, standing or temporary), sourced from the datastore-backed
    // provider — not a hardcoded map, and bounded to what this device needs.
    const activeCategories = [...new Set(
      [...rules, ...temporaryRules]
        .filter((r) => r.target === "CATEGORY")
        .map((r) => r.value),
    )];
    const categories = activeCategories.length > 0
      ? await this.categories.categoryMap(activeCategories)
      : undefined;

    const unsigned: DevicePolicySnapshot = {
      version, familyId, childId, deviceId, defaults, rules, temporaryRules,
      ...(categories ? { categories } : {}),
      issuedAt: now(), signature: "",
    };
    unsigned.signature = await signSnapshot(unsigned, this.signingPrivateKeyB64);
    return unsigned;
  }

  /** Incremental sync: null when the device is already current. */
  async syncSince(familyId: string, childId: string, deviceId: string, sinceVersion: number):
    Promise<DevicePolicySnapshot | null> {
    const version = await this.repo.getPolicyVersion(familyId, childId);
    if (version <= sinceVersion) return null;
    return this.buildSnapshot(familyId, childId, deviceId);
  }

  /**
   * The compact category-membership asset a device downloads and caches
   * separately from its policy: per-category Bloom filters, signed with the same
   * key as snapshots and versioned so the device only re-fetches on change. This
   * is what lets a client enforce "block all social" over a huge domain set with
   * no per-URL backend call and no multi-megabyte domain list in the app.
   */
  async categoryFilterAsset(since?: number):
    Promise<{ upToDate: true } | { set: CategoryFilterSet; signature: string }> {
    const version = await this.categories.version();
    if (since !== undefined && since >= 0 && version <= since) return { upToDate: true };
    const set = await this.categories.compileFilters();
    const signature = await signCanonical(set, this.signingPrivateKeyB64);
    return { set, signature };
  }

  private appliesToChildDevice(scope: RuleScope, childId: string, deviceId: string): boolean {
    if (scope.childId && scope.childId !== childId) return false;
    if (scope.deviceId && scope.deviceId !== deviceId) return false;
    return true;
  }

  private async bumpForScope(familyId: string, scope: RuleScope) {
    if (scope.childId) { await this.repo.bumpPolicyVersion(familyId, scope.childId); return; }
    for (const child of await this.repo.listChildren(familyId))
      await this.repo.bumpPolicyVersion(familyId, child.id);
  }

  private async requireManage(familyId: string, userId: string) {
    const m = await this.repo.getMembership(familyId, userId);
    if (!m || !canManagePolicy(m.role)) throw new DomainError("cannot manage policy", "FORBIDDEN");
  }
}

// ---------------------------------------------------------------------------
// Access requests → approvals → temporary/standing rules
// ---------------------------------------------------------------------------

function durationToExpiry(d: ApprovalDuration, from = Date.now()): { expiresAt?: string; standing: boolean } {
  switch (d.kind) {
    case "ALWAYS": return { standing: true };
    case "ONCE": return { expiresAt: new Date(from + 5 * 60_000).toISOString(), standing: false }; // short TTL; device marks consumed
    case "MINUTES": return { expiresAt: new Date(from + d.minutes * 60_000).toISOString(), standing: false };
    case "UNTIL_END_OF_DAY": {
      const end = new Date(from); end.setUTCHours(23, 59, 59, 999);
      return { expiresAt: end.toISOString(), standing: false };
    }
  }
}

/** Map an approval scope + the request onto a concrete (target, rule scope). */
export function mapScope(req: AccessRequest, scope: ApprovalScope):
  { targetType: PolicyTargetType; targetValue: string; ruleScope: Omit<RuleScope, "type"> & { type: RuleScope["type"] } } {
  const familyScope = { type: "FAMILY" as const, familyId: req.familyId };
  const childScope = { type: "CHILD" as const, familyId: req.familyId, childId: req.childId };
  const deviceScope = { type: "DEVICE" as const, familyId: req.familyId, childId: req.childId, deviceId: req.deviceId };
  const host = (() => { try { return req.url ? new URL(req.url).hostname.replace(/^www\./, "") : ""; } catch { return ""; } })();

  switch (scope) {
    case "THIS_URL":
      return { targetType: "URL", targetValue: req.url ?? req.targetValue, ruleScope: childScope };
    case "THIS_VIDEO":
      return { targetType: "YOUTUBE_VIDEO", targetValue: req.targetValue, ruleScope: childScope };
    case "THIS_CHANNEL":
      return { targetType: "YOUTUBE_CHANNEL", targetValue: req.targetValue, ruleScope: childScope };
    case "THIS_DOMAIN":
      return { targetType: "DOMAIN", targetValue: host || req.targetValue, ruleScope: childScope };
    case "THIS_DEVICE":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: deviceScope };
    case "THIS_CHILD":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: childScope };
    case "WHOLE_FAMILY":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: familyScope };
    case "THIS_REQUEST":
    default:
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: deviceScope };
  }
}

export class ApprovalService {
  constructor(private repo: Repository, private notifier: Notifier, private hub?: EventHub) {}

  /** Called by the child device when it hits blocked content. */
  async createRequest(input: {
    familyId: string; childId: string; deviceId: string;
    targetType: PolicyTargetType; targetValue: string; title?: string; url?: string; reason?: string;
  }): Promise<AccessRequest> {
    const device = await this.repo.getDevice(input.deviceId);
    if (!device || device.familyId !== input.familyId || device.childId !== input.childId)
      throw new DomainError("device/child mismatch", "FORBIDDEN");

    const req = await this.repo.createAccessRequest({
      id: uid(), familyId: input.familyId, childId: input.childId, deviceId: input.deviceId,
      targetType: input.targetType, targetValue: input.targetValue,
      title: input.title, url: input.url, reason: input.reason,
      status: "PENDING", createdAt: now(),
    });
    await this.repo.addAuditEvent({
      id: uid(), familyId: req.familyId, actorId: input.deviceId, kind: "request.created",
      detail: { requestId: req.id, target: `${input.targetType}:${input.targetValue}` }, createdAt: now(),
    });
    // Notify all authorized parents (OWNER/PARENT, and LIMITED_GUARDIANs assigned this child).
    const child = await this.repo.getChild(input.childId);
    for (const m of await this.repo.listMemberships(input.familyId)) {
      if (!canApprove(m.role)) continue;
      if (m.role === "LIMITED_GUARDIAN" && !m.assignedChildIds.includes(input.childId)) continue;
      for (const ep of await this.repo.listNotificationEndpoints(m.userId)) {
        await this.notifier.send(ep, {
          title: `${child?.displayName ?? "Your child"} requested access`,
          body: input.title ?? `${input.targetType} ${input.targetValue}`,
          data: { requestId: req.id, kind: "access_request" },
        });
      }
    }
    // Wake any parent long-poll waiting on this family's pending-request feed.
    this.hub?.notify(`family:${input.familyId}`);
    return req;
  }

  /** Parent decides. Server-authoritative; records who decided; produces a rule. */
  async decide(input: {
    familyId: string; requestId: string; decidedBy: string;
    decision: "ALLOW" | "BLOCK"; scope: ApprovalScope; duration: ApprovalDuration;
    policy: PolicyService;
  }): Promise<{ decision: ApprovalDecision; request: AccessRequest }> {
    const m = await this.repo.getMembership(input.familyId, input.decidedBy);
    if (!m || !canApprove(m.role)) throw new DomainError("cannot approve", "FORBIDDEN");

    const req = await this.repo.getAccessRequest(input.requestId);
    if (!req || req.familyId !== input.familyId) throw new DomainError("unknown request", "NOT_FOUND");
    if (req.status !== "PENDING") throw new DomainError("request already decided", "CONFLICT");
    if (m.role === "LIMITED_GUARDIAN" && !m.assignedChildIds.includes(req.childId))
      throw new DomainError("guardian not assigned this child", "FORBIDDEN");

    const { targetType, targetValue, ruleScope } = mapScope(req, input.scope);
    let producedRuleId: string | undefined;

    if (input.decision === "ALLOW") {
      const { expiresAt, standing } = durationToExpiry(input.duration);
      if (standing) {
        const rule = await input.policy.addRule(input.familyId, input.decidedBy, {
          target: targetType, value: targetValue, action: "ALLOW", scope: ruleScope, priority: 10,
        });
        producedRuleId = rule.id;
      } else {
        const t: TemporaryRule = {
          id: uid(), target: targetType, value: targetValue, action: "ALLOW", scope: ruleScope,
          priority: 100, createdAt: now(), createdBy: input.decidedBy,
          startsAt: now(), expiresAt: expiresAt!, requestId: req.id, approvedBy: input.decidedBy,
          grantKind: input.duration.kind === "ONCE" ? "ONCE"
            : input.duration.kind === "UNTIL_END_OF_DAY" ? "UNTIL_END_OF_DAY" : "TIMED",
        };
        await this.repo.createTemporaryRule(t);
        await this.repo.bumpPolicyVersion(input.familyId, req.childId);
        producedRuleId = t.id;
      }
    } else {
      // Explicit deny → standing block rule.
      const rule = await input.policy.addRule(input.familyId, input.decidedBy, {
        target: targetType, value: targetValue, action: "BLOCK", scope: ruleScope, priority: 10,
      });
      producedRuleId = rule.id;
    }

    req.status = input.decision === "ALLOW" ? "APPROVED" : "DENIED";
    await this.repo.updateAccessRequest(req);

    const decision = await this.repo.createApprovalDecision({
      id: uid(), requestId: req.id, familyId: input.familyId, decidedBy: input.decidedBy,
      decision: input.decision, scope: input.scope, duration: input.duration,
      createdAt: now(), producedRuleId,
    });
    await this.repo.addAuditEvent({
      id: uid(), familyId: input.familyId, actorId: input.decidedBy, kind: "approval.decided",
      detail: { requestId: req.id, decision: input.decision, scope: input.scope, producedRuleId }, createdAt: now(),
    });

    // Nudge the child device to sync immediately.
    const device = await this.repo.getDevice(req.deviceId);
    if (device) {
      await this.notifier.send(
        { id: "device", userId: device.id, kind: "WEBSOCKET", token: device.id, createdAt: now() },
        { title: "policy_update", body: "sync", data: { kind: "policy_update", childId: req.childId } },
      );
    }
    // Wake parent consoles long-polling this family: the pending set just shrank.
    this.hub?.notify(`family:${input.familyId}`);
    return { decision, request: req };
  }
}
