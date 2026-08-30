/**
 * REST API surface wiring the transport-agnostic Router to the domain services.
 * Auth is a bearer-token skeleton (see auth/tokens.ts); production swaps in Sign
 * in with Apple / passkeys + refresh rotation without changing these routes.
 */
import type { App } from "../app.js";
import { Router, ok, err, type HttpRequest, type HttpResponse } from "./router.js";
import { issueToken, verifyToken, type Principal } from "../auth/tokens.js";
import { openapiDocument } from "./openapi.js";
import { RateLimiter, clientKey } from "./rate-limit.js";
import type { ApprovalDuration, ApprovalScope, Platform, RuleAction, PolicyTargetType, Role } from "../domain/model.js";

async function principal(app: App, req: HttpRequest): Promise<Principal | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyToken(app.authSecret, auth.slice(7));
}
const UNAUTH = (msg: string) => Object.assign(new Error(msg), { code: "UNAUTHORIZED" });

/** Resolve + fully validate a user token: signature/exp, tokenVersion (global
 *  revocation), and — if the token carries a session id — that the session is
 *  still live (per-device revocation). Returns the userId and its session id. */
async function userPrincipal(app: App, req: HttpRequest): Promise<{ userId: string; sid?: string }> {
  const p = await principal(app, req);
  if (!p || p.kind !== "user") throw UNAUTH("login required");
  await app.auth.userForToken(p.userId, p.tv);
  if (p.sid && !(await app.auth.sessionActive(p.sid))) throw UNAUTH("session revoked");
  return { userId: p.userId, sid: p.sid };
}
async function requireUser(app: App, req: HttpRequest): Promise<string> {
  return (await userPrincipal(app, req)).userId;
}

// Access + refresh token pair for one session (sid). Access is short-lived; the
// refresh token mints new access tokens via /v1/auth/refresh. Both carry the
// user's tokenVersion (global revoke) AND the session id (per-device revoke).
const ACCESS_TTL = 60 * 60; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 14; // 14d
const deviceLabel = (req: HttpRequest) =>
  req.headers["x-device-label"] || req.headers["user-agent"] || "Unknown device";
async function tokenPair(app: App, user: { id: string; tokenVersion: number }, sid: string) {
  return {
    userId: user.id,
    tokenType: "Bearer",
    expiresIn: ACCESS_TTL,
    accessToken: await issueToken(app.authSecret, { kind: "user", userId: user.id, tv: user.tokenVersion, sid }, ACCESS_TTL),
    refreshToken: await issueToken(app.authSecret, { kind: "refresh", userId: user.id, tv: user.tokenVersion, sid }, REFRESH_TTL),
  };
}
/**
 * Resolve a device token AND confirm the device still exists. Device tokens are
 * self-contained and long-lived, so without this check a device that a parent
 * deleted kept working until its token expired — erasure that erased nothing.
 */
async function requireDevice(app: App, req: HttpRequest) {
  const p = await principal(app, req);
  if (!p || p.kind !== "device") throw Object.assign(new Error("device token required"), { code: "UNAUTHORIZED" });
  const device = await app.repo.getDevice(p.deviceId);
  if (!device) throw Object.assign(new Error("this device has been removed"), { code: "UNAUTHORIZED" });
  return p;
}

/** Device tokens last 30 days and can be refreshed while still valid. */
const DEVICE_TOKEN_TTL = 60 * 60 * 24 * 30;
const issueDeviceToken = (app: App, d: { id: string; familyId: string; childId: string }) =>
  issueToken(app.authSecret, { kind: "device", deviceId: d.id, familyId: d.familyId, childId: d.childId }, DEVICE_TOKEN_TTL);

export function buildRouter(app: App): Router {
  const r = new Router();

  // Layered rate limiting: a generous baseline on EVERY route (abuse / scanning /
  // authed hammering), plus stricter caps on the sensitive unauthenticated ones.
  // Per-client (proxy IP header, else a shared bucket); per-process — front with
  // Redis / a Durable Object at multi-instance scale. See docs/SECURITY.md.
  const globalLimiter = new RateLimiter(600, 60_000); // 600/min per client, all routes
  const authLimiter = new RateLimiter(10, 60_000);    // 10/min per client for auth
  const enrollLimiter = new RateLimiter(20, 60_000);  // 20/min per client for redeem
  const limited = (lim: RateLimiter, req: HttpRequest) =>
    !lim.allow(clientKey(req.headers)) ? err(429, "too many attempts — slow down", "RATE_LIMITED") : null;
  r.before((req) => limited(globalLimiter, req));

  r.get("/v1/health", async () => ok({ status: "ok", version: "0.0.0-alpha" }));
  r.get("/v1/signing-key", async () => ok({ publicKeyB64: app.signingPublicKeyB64, alg: "Ed25519" }));
  // Machine-readable API contract (the source of truth clients integrate against).
  r.get("/openapi.json", async () => ok(openapiDocument));

  // --- categorization dataset (lookup + feed import; NOT hardcoded) ---
  // The domain→category classification lives in the datastore behind a provider.
  // These let a parent/ops see how a site is classified and swap the whole
  // dataset for a maintained feed without a code change or redeploy.
  r.get("/v1/categories", async (req) => {
    await requireUser(app, req);
    return ok({ version: await app.categories.version(), categories: await app.categories.listCategories() });
  });
  r.get("/v1/categories/lookup", async (req) => {
    await requireUser(app, req);
    const host = (req.query.get("host") ?? "").trim();
    if (!host) return err(400, "host query param required", "BAD_REQUEST");
    // Follow the CNAME chain (best-effort) so classification reflects the real
    // destination, not a cloaking first-party alias. `resolve=0` opts out.
    const resolve = req.query.get("resolve") !== "0";
    const chain = resolve ? await app.cnameResolver.resolveChain(host) : [];
    const cats = new Set<string>();
    for (const h of [host, ...chain]) for (const c of await app.categories.lookup(h)) cats.add(c);
    return ok({ host, resolvedHosts: chain, categories: [...cats] });
  });
  // Replace the entire categorization dataset from a feed (ops/admin action —
  // there is no admin role yet, so it requires an authenticated user; restrict
  // this further before production, see docs/SECURITY.md).
  r.put("/v1/categories/dataset", async (req) => {
    await requireUser(app, req);
    // The category dataset is GLOBAL, not family-scoped: any authenticated user
    // could otherwise wipe or poison enforcement for every family on the
    // instance (registration is open). Until there is an admin role this is an
    // ops action gated by a deployment secret, and OFF unless configured.
    const admin = app.categoryAdminToken;
    if (!admin) return err(503, "category dataset import is not enabled on this deployment", "DISABLED");
    const offered = req.headers["x-admin-token"] ?? "";
    if (offered.length !== admin.length || offered !== admin)
      return err(403, "admin token required", "FORBIDDEN");
    const b = await req.json<{ categories?: Record<string, string[]> }>();
    if (!b?.categories || typeof b.categories !== "object" || Array.isArray(b.categories)) {
      return err(400, "body must be { categories: { <slug>: string[] } }", "BAD_REQUEST");
    }
    const version = await app.categories.replace(b.categories);
    return ok({ version, categories: await app.categories.listCategories() });
  });
  // Device-facing: the signed, versioned category Bloom-filter asset. A child
  // device downloads this once, caches it, and queries it locally — no per-URL
  // call, no domain list in the app. `?since=N` returns { upToDate: true } when
  // the device already has the current version.
  r.get("/v1/categories/filters", async (req) => {
    await requireDevice(app, req);
    const since = Number(req.query.get("since") ?? "-1");
    const asset = await app.policy.categoryFilterAsset(Number.isFinite(since) ? since : -1);
    return ok(asset);
  });

  // --- auth (self-contained passwords, no external IdP) ---
  r.post("/v1/auth/register", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await req.json<{ email: string; password: string; displayName: string }>();
    const user = await app.auth.register(b.email, b.password, b.displayName);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id), 201);
  });
  r.post("/v1/auth/login", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await req.json<{ email: string; password: string }>();
    const user = await app.auth.authenticate(b.email, b.password);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });
  // Exchange a refresh token for a fresh pair (same session). Rejected if the
  // session was revoked (this device) or the user's tokenVersion changed (all).
  r.post("/v1/auth/refresh", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const { refreshToken } = await req.json<{ refreshToken: string }>();
    const p = refreshToken ? await verifyToken(app.authSecret, refreshToken) : null;
    if (!p || p.kind !== "refresh") return err(401, "invalid refresh token", "UNAUTHORIZED");
    const { user, sid } = await app.auth.refreshSession(p.userId, p.tv, p.sid);
    return ok(await tokenPair(app, user, sid));
  });
  // Start a password reset. ALWAYS 202, whether or not the address is known —
  // a different status for "no such account" turns this into an account
  // enumeration oracle. The email (if any) is sent out of band.
  r.post("/v1/auth/forgot", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await req.json<{ email?: string }>();
    await app.auth.requestPasswordReset(b?.email ?? "", { resetUrlBase: app.resetUrlBase });
    return ok({ status: "accepted" }, 202);
  });
  // Complete a password reset with the emailed token. Single-use, 30-minute TTL,
  // and it kills every existing session (bumped tokenVersion + revoked sessions)
  // so a reset genuinely locks out whoever prompted it.
  r.post("/v1/auth/reset", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await req.json<{ token: string; newPassword: string }>();
    const user = await app.auth.resetPassword(b?.token ?? "", b?.newPassword ?? "");
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });
  // Sign out THIS device (revoke the current session only).
  r.post("/v1/auth/logout", async (req) => {
    const { userId, sid } = await userPrincipal(app, req);
    if (sid) await app.auth.revokeSession(userId, sid);
    return ok({ ok: true });
  });
  // Sign out EVERYWHERE (revoke all sessions + bump tokenVersion).
  r.post("/v1/auth/logout-all", async (req) => {
    const userId = await requireUser(app, req);
    await app.auth.revokeAllSessions(userId);
    return ok({ ok: true });
  });
  // Change password (verifies the current one); revokes all prior sessions and
  // returns a fresh token pair on a new session so the caller stays signed in.
  r.post("/v1/auth/password", async (req) => {
    const { userId } = await userPrincipal(app, req);
    const b = await req.json<{ currentPassword: string; newPassword: string }>();
    const user = await app.auth.changePassword(userId, b.currentPassword, b.newPassword);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });
  // List this user's active sessions (per-device); mark which is the caller's.
  r.get("/v1/me/sessions", async (req) => {
    const { userId, sid } = await userPrincipal(app, req);
    const sessions = await app.auth.listSessions(userId);
    return ok(sessions.map((s) => ({
      id: s.id, label: s.label, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === sid,
    })));
  });
  // Revoke one session by id (remote sign-out of another device).
  r.del("/v1/me/sessions/:sessionId", async (req) => {
    const userId = await requireUser(app, req);
    await app.auth.revokeSession(userId, req.params.sessionId!);
    return ok({ revoked: true });
  });

  r.get("/v1/me", async (req) => {
    const userId = await requireUser(app, req);
    const user = await app.repo.getUser(userId);
    const memberships = await app.repo.listMembershipsForUser(userId);
    const families = await Promise.all(memberships.map(async (m) => ({
      familyId: m.familyId, role: m.role, family: await app.repo.getFamily(m.familyId),
    })));
    return ok({ userId, email: user?.email, displayName: user?.displayName, families });
  });

  // --- families ---
  r.post("/v1/families", async (req) => {
    const userId = await requireUser(app, req);
    const { name } = await req.json<{ name: string }>();
    return ok(await app.family.createFamily(name, userId), 201);
  });
  r.get("/v1/families/:familyId", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId); // authorizes membership
    const fam = await app.repo.getFamily(req.params.familyId!);
    return fam ? ok(fam) : err(404, "not found", "NOT_FOUND");
  });
  // Invite a co-parent/guardian. `email` is the identifier a parent actually
  // knows; `userId` still works for existing integrations. Either way the person
  // must already have an account — this used to accept any string and create a
  // membership pointing at nobody, which showed up as a family member and an
  // approver but could never sign in.
  r.post("/v1/families/:familyId/parents", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ email?: string; userId?: string; role: Role; assignedChildIds?: string[] }>();
    const assigned = b.assignedChildIds ?? [];
    const membership = b.email
      ? await app.family.inviteParentByEmail(req.params.familyId!, userId, b.email, b.role, assigned)
      : await app.family.addParent(req.params.familyId!, userId, b.userId ?? "", b.role, assigned);
    return ok(membership, 201);
  });
  r.post("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    const { displayName, timezone } = await req.json<{ displayName: string; timezone?: string }>();
    return ok(await app.family.addChild(req.params.familyId!, userId, displayName, timezone ?? "UTC"), 201);
  });
  // Update a child's IANA time zone — what "until the end of the day" is measured in.
  r.put("/v1/families/:familyId/children/:childId", async (req) => {
    const userId = await requireUser(app, req);
    const { timezone } = await req.json<{ timezone: string }>();
    return ok(await app.family.setChildTimezone(req.params.familyId!, userId, req.params.childId!, timezone));
  });
  // Erase a child and everything attached to them (devices, rules, grants,
  // requests, defaults). Irreversible by design — this is the erasure path.
  r.del("/v1/families/:familyId/children/:childId", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.removeChild(req.params.familyId!, userId, req.params.childId!);
    return ok({ deleted: true });
  });
  r.get("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    return ok(await app.repo.listChildren(req.params.familyId!));
  });
  // Devices with liveness: `lastSeenAt`, the version each one actually pulled,
  // and a `stale` flag. This is how a parent finds out that protection stopped
  // running on a laptop three weeks ago instead of assuming it is fine.
  r.get("/v1/families/:familyId/devices", async (req) => {
    const userId = await requireUser(app, req);
    return ok(await app.devices.listWithStatus(req.params.familyId!, userId));
  });
  r.del("/v1/families/:familyId/devices/:deviceId", async (req) => {
    const userId = await requireUser(app, req);
    await app.devices.remove(req.params.familyId!, userId, req.params.deviceId!);
    return ok({ deleted: true });
  });
  r.get("/v1/families/:familyId/audit", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    return ok(await app.repo.listAuditEvents(req.params.familyId!));
  });

  // --- policy ---
  r.add("PUT" as string, "/v1/families/:familyId/children/:childId/defaults", async (req) => {
    const userId = await requireUser(app, req);
    const d = await req.json<{ webDefault: RuleAction; youTubeDefault: RuleAction }>();
    await app.policy.setDefaults(req.params.familyId!, userId, req.params.childId!, d);
    return ok({ updated: true });
  });
  r.post("/v1/families/:familyId/rules", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ target: PolicyTargetType; value: string; action: RuleAction;
      scope: { type: "FAMILY" | "CHILD" | "DEVICE"; childId?: string; deviceId?: string }; priority?: number }>();
    const rule = await app.policy.addRule(req.params.familyId!, userId, {
      target: b.target, value: b.value, action: b.action, priority: b.priority,
      scope: { type: b.scope.type, familyId: req.params.familyId!, childId: b.scope.childId, deviceId: b.scope.deviceId },
    });
    return ok(rule, 201);
  });
  r.del("/v1/families/:familyId/rules/:ruleId", async (req) => {
    const userId = await requireUser(app, req);
    await app.policy.removeRule(req.params.familyId!, userId, req.params.ruleId!);
    return ok({ deleted: true });
  });
  r.get("/v1/families/:familyId/rules", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    return ok(await app.repo.listRules(req.params.familyId!));
  });

  // --- enrollment ---
  r.post("/v1/families/:familyId/enroll", async (req) => {
    const userId = await requireUser(app, req);
    const { childId, platform } = await req.json<{ childId: string; platform: Platform }>();
    const tok = await app.enrollment.createToken(req.params.familyId!, userId, childId, platform);
    return ok({ code: tok.code, expiresAt: tok.expiresAt }, 201);
  });
  r.post("/v1/enroll/redeem", async (req) => {
    const capped = limited(enrollLimiter, req); if (capped) return capped;
    const b = await req.json<{ code: string; devicePublicKey: string; displayName: string }>();
    const device = await app.enrollment.redeem(b.code, b.devicePublicKey, b.displayName);
    const token = await issueDeviceToken(app, device);
    return ok({ device, deviceToken: token, expiresIn: DEVICE_TOKEN_TTL, signingPublicKeyB64: app.signingPublicKeyB64 }, 201);
  });

  // --- access requests & approvals ---
  r.post("/v1/requests", async (req) => {
    const dev = await requireDevice(app, req);
    const b = await req.json<{ targetType: PolicyTargetType; targetValue: string; title?: string; url?: string; reason?: string }>();
    const reqRec = await app.approvals.createRequest({
      familyId: dev.familyId, childId: dev.childId, deviceId: dev.deviceId,
      targetType: b.targetType, targetValue: b.targetValue, title: b.title, url: b.url, reason: b.reason,
    });
    return ok(reqRec, 201);
  });
  r.get("/v1/families/:familyId/requests", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    const status = req.query.get("status") ?? undefined;
    return ok(await app.repo.listAccessRequests(req.params.familyId!, status));
  });
  // Long-poll the pending-request feed: returns the current PENDING list the
  // instant a child files a request or a parent decides one (woken via the hub),
  // or the unchanged list after the timeout. Lets the parent console react in
  // seconds without a tight poll. `count` is the client's current pending size;
  // if it already differs we return immediately. Cross-runtime (no streaming).
  r.get("/v1/families/:familyId/requests/wait", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    const known = Number(req.query.get("count") ?? "-1");
    const timeout = Math.min(Math.max(Number(req.query.get("timeout") ?? "25000"), 0), 60000);
    const deadline = Date.now() + timeout;
    // Return immediately if the pending set already differs from what the client
    // knows; otherwise park until a create/decide wakes us (return the fresh list
    // on any wake, so a simultaneous decide+create that nets to the same length is
    // still delivered) or the deadline passes.
    const pending = await app.repo.listAccessRequests(req.params.familyId!, "PENDING");
    if (pending.length !== known) return ok({ requests: pending });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return ok({ requests: pending, upToDate: true });
    const woken = await app.hub.wait(`family:${req.params.familyId}`, remaining);
    if (!woken) return ok({ requests: pending, upToDate: true });
    return ok({ requests: await app.repo.listAccessRequests(req.params.familyId!, "PENDING") });
  });
  r.post("/v1/families/:familyId/requests/:requestId/decide", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ decision: RuleAction; scope: ApprovalScope; duration: ApprovalDuration }>();
    const out = await app.approvals.decide({
      familyId: req.params.familyId!, requestId: req.params.requestId!, decidedBy: userId,
      decision: b.decision, scope: b.scope, duration: b.duration, policy: app.policy,
    });
    return ok(out);
  });

  // --- device policy sync ---
  r.get("/v1/devices/:deviceId/policy", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const since = Number(req.query.get("since") ?? "-1");
    if (Number.isFinite(since) && since >= 0) {
      const snap = await app.policy.syncSince(dev.familyId, dev.childId, dev.deviceId, since);
      // Heartbeat on EVERY poll, including "you're already current" — a device
      // that is up to date is still alive, and that is precisely what the parent
      // needs to see. Record the version it actually holds.
      await app.devices.heartbeat(dev.deviceId, snap ? snap.version : since);
      return snap ? ok(snap) : ok({ upToDate: true });
    }
    const full = await app.policy.buildSnapshot(dev.familyId, dev.childId, dev.deviceId);
    await app.devices.heartbeat(dev.deviceId, full.version);
    return ok(full);
  });

  /**
   * Refresh a device token before it expires. Device tokens last 30 days and had
   * no renewal path at all: on day 31 a child's device stopped syncing policy,
   * silently, and the only recovery was a full re-enrollment by a parent. A
   * device that can still authenticate can mint its successor.
   */
  r.post("/v1/devices/:deviceId/token/refresh", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const device = await app.repo.getDevice(dev.deviceId);
    if (!device) return err(404, "unknown device", "NOT_FOUND");
    await app.devices.heartbeat(device.id);
    return ok({
      deviceToken: await issueDeviceToken(app, device),
      expiresIn: DEVICE_TOKEN_TTL,
      signingPublicKeyB64: app.signingPublicKeyB64,
    });
  });

  /**
   * Spend a single-use ("just once") grant. The device calls this the moment it
   * lets the grant through; the grant then disappears from every later snapshot.
   * Without it, `grantKind: "ONCE"` was an unlimited-replay 5-minute window.
   */
  r.post("/v1/devices/:deviceId/grants/:ruleId/consume", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const grant = await app.approvals.consumeGrant(dev.deviceId, req.params.ruleId!);
    return ok({ consumed: true, ruleId: grant.id, consumedAt: grant.consumedAt });
  });

  // Long-poll: returns the new signed snapshot the moment an approval bumps the
  // version (woken via the hub), or { upToDate: true } after the timeout. Lets a
  // child pick up an approval in seconds without tight polling. Works on Node and
  // Workers (no streaming). `timeout` ms is capped server-side.
  r.get("/v1/devices/:deviceId/policy/wait", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const since = Number(req.query.get("since") ?? "0");
    const timeout = Math.min(Math.max(Number(req.query.get("timeout") ?? "25000"), 0), 60000);
    const deadline = Date.now() + timeout;
    // Wake on this device's nudges; loop to absorb spurious wakes until deadline.
    await app.devices.heartbeat(dev.deviceId, since);
    for (;;) {
      const snap = await app.policy.syncSince(dev.familyId, dev.childId, dev.deviceId, since);
      if (snap) {
        await app.devices.heartbeat(dev.deviceId, snap.version);
        return ok(snap);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return ok({ upToDate: true });
      await app.hub.wait(`device:${dev.deviceId}`, remaining);
    }
  });

  // --- notification endpoints ---
  r.post("/v1/me/endpoints", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ kind: "APNS" | "WEBSOCKET" | "CONSOLE" | "EMAIL" | "WEBPUSH"; token: string }>();
    const ep = await app.repo.addNotificationEndpoint({
      id: crypto.randomUUID(), userId, kind: b.kind, token: b.token, createdAt: new Date().toISOString(),
    });
    return ok(ep, 201);
  });

  return r;
}

export type { HttpResponse };
