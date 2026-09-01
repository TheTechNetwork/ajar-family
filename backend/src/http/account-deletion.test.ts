/**
 * Closing an account.
 *
 * The route is required — an app that lets you make an account has to let you
 * delete it from inside the app (App Store 5.1.1(v)) — but the reason these
 * tests exist is the half that is not a DELETE statement: **a family is not the
 * deleting parent's property.** It may have another owner in it, and children
 * whose devices are enforcing policy right now.
 *
 * So the cases that matter are about other people's data. Does a co-parent keep
 * their children? Does a family with nobody left to administer it get erased
 * rather than stranded? Does the audit log — the most sensitive thing here, a
 * record of what a named child was told they could not look at — actually go?
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string, body?: unknown, token?: string): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

async function signedIn(app: App, r: ReturnType<typeof buildRouter>, email: string) {
  const user = await app.auth.register(email, "correct-horse", email);
  const res = await call(r, "POST", "/v1/auth/login", { email, password: "correct-horse" });
  return { user, token: (res.body as { accessToken: string }).accessToken };
}

/** A family with a child, a device, a rule and an approval — i.e. one that has
 *  actually been used, which is the only interesting kind to delete. */
async function livedInFamily(app: App, ownerId: string, name = "F") {
  const fam = await app.family.createFamily(name, ownerId);
  const child = await app.family.addChild(fam.id, ownerId, "Jane");
  const tok = await app.enrollment.createToken(fam.id, ownerId, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "iPhone");
  await app.policy.addRule(fam.id, ownerId, {
    target: "DOMAIN", value: "example.com", action: "BLOCK", scope: { type: "FAMILY", familyId: fam.id },
  });
  const req = await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0", title: "Photosynthesis",
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
  });
  await app.approvals.decide({
    familyId: fam.id, requestId: req.id, decidedBy: ownerId,
    decision: "ALLOW", scope: "THIS_VIDEO", duration: { kind: "MINUTES", minutes: 30 }, policy: app.policy,
  });
  return { fam, child, device };
}

test("the wrong password does not close the account", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const { user, token } = await signedIn(app, r, "p@e.com");

  const res = await call(r, "DELETE", "/v1/me", { password: "not-it" }, token);
  assert.equal(res.status, 401);
  assert.ok(await app.repo.getUser(user.id), "the account is still there");
});

test("closing an account erases the family it was the last owner of", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const { user, token } = await signedIn(app, r, "p@e.com");
  const { fam, child, device } = await livedInFamily(app, user.id);

  const res = await call(r, "DELETE", "/v1/me", { password: "correct-horse" }, token);
  assert.equal(res.status, 200);
  assert.equal((res.body as { familiesDeleted: number }).familiesDeleted, 1);

  assert.equal(await app.repo.getUser(user.id), null);
  assert.equal(await app.repo.getFamily(fam.id), null);
  assert.equal(await app.repo.getChild(child.id), null);
  assert.equal(await app.repo.getDevice(device.id), null);
  assert.deepEqual(await app.repo.listRules(fam.id), []);
  assert.deepEqual(await app.repo.listTemporaryRules(fam.id), []);
  assert.deepEqual(await app.repo.listAccessRequests(fam.id), []);
  assert.deepEqual(await app.repo.listMemberships(fam.id), []);
  // The audit log is the record of what a named child was told they could not
  // look at. It is the last thing that should survive an erasure request.
  assert.deepEqual(await app.repo.listAuditEvents(fam.id), []);
});

test("a co-parent keeps their children when the other owner leaves", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const leaving = await signedIn(app, r, "leaving@e.com");
  const staying = await app.auth.register("staying@e.com", "correct-horse", "S");
  const { fam, child, device } = await livedInFamily(app, leaving.user.id);
  await app.family.addParent(fam.id, leaving.user.id, staying.id, "OWNER");

  const res = await call(r, "DELETE", "/v1/me", { password: "correct-horse" }, leaving.token);
  assert.equal(res.status, 200);
  assert.equal((res.body as { familiesDeleted: number }).familiesDeleted, 0,
    "the family is not this person's to take with them");

  assert.ok(await app.repo.getFamily(fam.id));
  assert.ok(await app.repo.getChild(child.id), "the co-parent's child is untouched");
  assert.ok(await app.repo.getDevice(device.id), "and so is the device enforcing policy right now");
  assert.deepEqual(
    (await app.repo.listMemberships(fam.id)).map((m) => m.userId),
    [staying.id],
    "only the leaving parent's membership goes",
  );
  assert.equal(await app.repo.getUser(leaving.user.id), null);
});

test("a family whose only remaining member is NOT an owner is still erased", async () => {
  // A LIMITED_GUARDIAN cannot administer a family: they cannot add children,
  // change defaults, or invite anyone. Leaving the family behind because
  // somebody is still in it would leave a family nobody can run — and a record
  // of a child's blocked requests with no account responsible for it.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const owner = await signedIn(app, r, "owner@e.com");
  const helper = await app.auth.register("helper@e.com", "correct-horse", "H");
  const { fam, child } = await livedInFamily(app, owner.user.id);
  await app.family.addParent(fam.id, owner.user.id, helper.id, "LIMITED_GUARDIAN", [child.id]);

  const res = await call(r, "DELETE", "/v1/me", { password: "correct-horse" }, owner.token);
  assert.equal((res.body as { familiesDeleted: number }).familiesDeleted, 1);
  assert.equal(await app.repo.getFamily(fam.id), null);
  assert.ok(await app.repo.getUser(helper.id), "the guardian's own account is not touched");
  assert.deepEqual(await app.repo.listMembershipsForUser(helper.id), []);
});

test("everything personal goes with the account", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const { user, token } = await signedIn(app, r, "p@e.com");
  await app.repo.createWebAuthnCredential({
    id: "cred", userId: user.id, publicKeyCose: "AAAA", alg: -7, signCount: 0,
    label: "iPhone", backedUp: true, createdAt: new Date().toISOString(),
  });

  assert.equal((await app.repo.listNotificationEndpoints(user.id)).length, 1, "registration made one");
  assert.equal((await app.repo.listSessionsForUser(user.id)).length, 1);

  await call(r, "DELETE", "/v1/me", { password: "correct-horse" }, token);

  assert.deepEqual(await app.repo.listSessionsForUser(user.id), []);
  assert.deepEqual(await app.repo.listWebAuthnCredentials(user.id), []);
  assert.deepEqual(await app.repo.listNotificationEndpoints(user.id), []);
  // And the token that was working a moment ago no longer is.
  assert.equal((await call(r, "GET", "/v1/me", undefined, token)).status, 401);
});

test("the same address can sign up again afterwards", async () => {
  // A deletion that leaves the address unusable is not a deletion a parent would
  // recognise — and a pending sign-up left behind would let a link from before
  // the deletion quietly recreate the account.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const { token } = await signedIn(app, r, "again@e.com");
  await call(r, "DELETE", "/v1/me", { password: "correct-horse" }, token);

  assert.equal(await app.repo.getUserByEmail("again@e.com"), null);
  const fresh = await app.auth.register("again@e.com", "correct-horse", "Again");
  assert.ok(fresh.id);
});
