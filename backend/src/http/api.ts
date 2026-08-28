/**
 * REST API surface wiring the transport-agnostic Router to the domain services.
 * Auth is a bearer-token skeleton (see auth/tokens.ts); production swaps in Sign
 * in with Apple / passkeys + refresh rotation without changing these routes.
 */
import type { App } from "../app.js";
import { Router, ok, err, type HttpRequest, type HttpResponse } from "./router.js";
import { issueToken, verifyToken, type Principal } from "../auth/tokens.js";
import { openapiDocument } from "./openapi.js";
import type { ApprovalDuration, ApprovalScope, Platform, RuleAction, PolicyTargetType, Role } from "../domain/model.js";

async function principal(app: App, req: HttpRequest): Promise<Principal | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyToken(app.authSecret, auth.slice(7));
}
async function requireUser(app: App, req: HttpRequest): Promise<string> {
  const p = await principal(app, req);
  if (!p || p.kind !== "user") throw Object.assign(new Error("login required"), { code: "UNAUTHORIZED" });
  return p.userId;
}
async function requireDevice(app: App, req: HttpRequest) {
  const p = await principal(app, req);
  if (!p || p.kind !== "device") throw Object.assign(new Error("device token required"), { code: "UNAUTHORIZED" });
  return p;
}

export function buildRouter(app: App): Router {
  const r = new Router();

  r.get("/v1/health", async () => ok({ status: "ok", version: "0.0.0-alpha" }));
  r.get("/v1/signing-key", async () => ok({ publicKeyB64: app.signingPublicKeyB64, alg: "Ed25519" }));
  // Machine-readable API contract (the source of truth clients integrate against).
  r.get("/openapi.json", async () => ok(openapiDocument));

  // --- auth (skeleton) ---
  r.post("/v1/auth/register", async (req) => {
    const { email, displayName } = await req.json<{ email: string; displayName: string }>();
    if (!email || !displayName) return err(400, "email and displayName required");
    const user = await app.family.createUser(email, displayName);
    return ok({ userId: user.id, token: await issueToken(app.authSecret, { kind: "user", userId: user.id }) });
  });
  r.post("/v1/auth/login", async (req) => {
    const { email } = await req.json<{ email: string }>();
    const user = await app.repo.getUserByEmail(email);
    if (!user) return err(404, "no such user", "NOT_FOUND");
    return ok({ userId: user.id, token: await issueToken(app.authSecret, { kind: "user", userId: user.id }) });
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
  r.post("/v1/families/:familyId/parents", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ userId: string; role: Role; assignedChildIds?: string[] }>();
    return ok(await app.family.addParent(req.params.familyId!, userId, b.userId, b.role, b.assignedChildIds ?? []), 201);
  });
  r.post("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    const { displayName } = await req.json<{ displayName: string }>();
    return ok(await app.family.addChild(req.params.familyId!, userId, displayName), 201);
  });
  r.get("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    return ok(await app.repo.listChildren(req.params.familyId!));
  });
  r.get("/v1/families/:familyId/devices", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId);
    return ok(await app.repo.listDevices(req.params.familyId!));
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
    const b = await req.json<{ code: string; devicePublicKey: string; displayName: string }>();
    const device = await app.enrollment.redeem(b.code, b.devicePublicKey, b.displayName);
    const token = await issueToken(app.authSecret,
      { kind: "device", deviceId: device.id, familyId: device.familyId, childId: device.childId },
      60 * 60 * 24 * 30);
    return ok({ device, deviceToken: token, signingPublicKeyB64: app.signingPublicKeyB64 }, 201);
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
      return snap ? ok(snap) : ok({ upToDate: true });
    }
    return ok(await app.policy.buildSnapshot(dev.familyId, dev.childId, dev.deviceId));
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
    for (;;) {
      const snap = await app.policy.syncSince(dev.familyId, dev.childId, dev.deviceId, since);
      if (snap) return ok(snap);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return ok({ upToDate: true });
      await app.hub.wait(`device:${dev.deviceId}`, remaining);
    }
  });

  // --- notification endpoints ---
  r.post("/v1/me/endpoints", async (req) => {
    const userId = await requireUser(app, req);
    const b = await req.json<{ kind: "APNS" | "WEBSOCKET" | "CONSOLE"; token: string }>();
    const ep = await app.repo.addNotificationEndpoint({
      id: crypto.randomUUID(), userId, kind: b.kind, token: b.token, createdAt: new Date().toISOString(),
    });
    return ok(ep, 201);
  });

  return r;
}

export type { HttpResponse };
