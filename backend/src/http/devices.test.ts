/**
 * Device heartbeat, visibility, token refresh and erasure — through the real
 * router, with real device tokens.
 *
 * Before: `lastSyncedVersion` was written once at enrollment and never again, so
 * a device that had been uninstalled, firewalled or switched off looked exactly
 * like a healthy one; device tokens expired after 30 days with no renewal path,
 * so a device silently stopped syncing; and there was no way to delete a device
 * or a child at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

function call(router: ReturnType<typeof buildRouter>, method: string, path: string,
              body?: unknown, token?: string): Promise<HttpResponse> {
  const url = new URL(path, "http://localhost");
  const req: HttpRequest = {
    method, path: url.pathname, query: url.searchParams,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: {}, json: async () => (body ?? {}) as never,
  };
  return router.handle(req);
}

interface Ctx { app: App; r: ReturnType<typeof buildRouter>; parent: string; famId: string; childId: string;
                deviceId: string; deviceToken: string }

async function fixture(): Promise<Ctx> {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  await app.auth.register("d@e.com", "correct-horse", "D");
  const parent = ((await call(r, "POST", "/v1/auth/login", { email: "d@e.com", password: "correct-horse" }))
    .body as { accessToken: string }).accessToken;
  const fam = (await call(r, "POST", "/v1/families", { name: "F" }, parent)).body as { id: string };
  const child = (await call(r, "POST", `/v1/families/${fam.id}/children`, { displayName: "Kid" }, parent)).body as { id: string };
  const code = (await call(r, "POST", `/v1/families/${fam.id}/enroll`, { childId: child.id, platform: "WINDOWS" }, parent)).body as { code: string };
  const redeemed = (await call(r, "POST", "/v1/enroll/redeem",
    { code: code.code, devicePublicKey: "pk", displayName: "Kid's PC" })).body as
    { device: { id: string }; deviceToken: string };
  return { app, r, parent, famId: fam.id, childId: child.id, deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken };
}

type DeviceRow = {
  id: string; lastSeenAt?: string; lastSyncedVersion: number; currentVersion: number; upToDate: boolean; stale: boolean;
};
const listDevices = async (c: Ctx) =>
  (await call(c.r, "GET", `/v1/families/${c.famId}/devices`, undefined, c.parent)).body as DeviceRow[];

test("fetching policy updates lastSeenAt and the version the device actually holds", async () => {
  const c = await fixture();

  const before = (await listDevices(c))[0]!;
  assert.equal(before.lastSeenAt, undefined, "never seen since enrollment");
  assert.equal(before.lastSyncedVersion, 0);
  assert.equal(before.upToDate, false, "enrollment alone does not mean synced");

  const snap = (await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, c.deviceToken)).body as { version: number };
  assert.ok(snap.version >= 1);

  const after = (await listDevices(c))[0]!;
  assert.ok(after.lastSeenAt, "the device is now visibly alive");
  assert.equal(after.lastSyncedVersion, snap.version, "we record the version it took away");
  assert.equal(after.currentVersion, snap.version);
  assert.equal(after.upToDate, true);
  assert.equal(after.stale, false);
});

test("an up-to-date poll still counts as a heartbeat", async () => {
  const c = await fixture();
  const snap = (await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, c.deviceToken)).body as { version: number };
  // Roll lastSeenAt back so we can see it move.
  const dev = (await c.app.repo.getDevice(c.deviceId))!;
  await c.app.repo.updateDevice({ ...dev, lastSeenAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  assert.equal((await listDevices(c))[0]!.stale, true, "three days of silence reads as stale");

  const res = await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy?since=${snap.version}`, undefined, c.deviceToken);
  assert.deepEqual(res.body, { upToDate: true });
  assert.equal((await listDevices(c))[0]!.stale, false, "a device with nothing to fetch is still alive");
});

test("a device token can be refreshed before it expires", async () => {
  const c = await fixture();
  const res = await call(c.r, "POST", `/v1/devices/${c.deviceId}/token/refresh`, undefined, c.deviceToken);
  assert.equal(res.status, 200);
  const { deviceToken, expiresIn } = res.body as { deviceToken: string; expiresIn: number };
  assert.ok(deviceToken && deviceToken !== "");
  assert.equal(expiresIn, 60 * 60 * 24 * 30);

  // The successor works for policy sync.
  assert.equal((await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, deviceToken)).status, 200);
  // A parent token cannot mint a device token, and one device cannot refresh another's.
  assert.equal((await call(c.r, "POST", `/v1/devices/${c.deviceId}/token/refresh`, undefined, c.parent)).status, 401);
  assert.equal((await call(c.r, "POST", "/v1/devices/someone-else/token/refresh", undefined, c.deviceToken)).status, 403);
  assert.equal((await listDevices(c))[0]!.lastSeenAt !== undefined, true, "refresh is also a heartbeat");
});

test("deleting a device cascades and its token stops working immediately", async () => {
  const c = await fixture();
  await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, c.deviceToken);
  // Give the device something device-scoped to leave behind.
  await call(c.r, "POST", `/v1/families/${c.famId}/rules`, {
    target: "DOMAIN", value: "example.com", action: "BLOCK",
    scope: { type: "DEVICE", childId: c.childId, deviceId: c.deviceId },
  }, c.parent);
  await c.app.approvals.createRequest({
    familyId: c.famId, childId: c.childId, deviceId: c.deviceId, targetType: "DOMAIN", targetValue: "reddit.com",
  });
  assert.equal((await c.app.repo.listRules(c.famId)).length, 1);
  assert.equal((await c.app.repo.listAccessRequests(c.famId)).length, 1);

  const del = await call(c.r, "DELETE", `/v1/families/${c.famId}/devices/${c.deviceId}`, undefined, c.parent);
  assert.equal(del.status, 200);
  assert.deepEqual(await listDevices(c), []);
  assert.deepEqual(await c.app.repo.listRules(c.famId), [], "device-scoped rules went with it");
  assert.deepEqual(await c.app.repo.listAccessRequests(c.famId), [], "its requests went with it");
  assert.equal((await call(c.r, "GET", `/v1/devices/${c.deviceId}/policy`, undefined, c.deviceToken)).status, 401,
    "a removed device's long-lived token is no longer accepted");
});

test("deleting a child erases their devices, policy, grants and requests", async () => {
  const c = await fixture();
  await call(c.r, "POST", `/v1/families/${c.famId}/rules`, {
    target: "CATEGORY", value: "social", action: "BLOCK", scope: { type: "CHILD", childId: c.childId },
  }, c.parent);
  const req = await c.app.approvals.createRequest({
    familyId: c.famId, childId: c.childId, deviceId: c.deviceId, targetType: "CATEGORY", targetValue: "social",
    url: "https://tiktok.com/@nasa",
  });
  await c.app.approvals.decide({
    familyId: c.famId, requestId: req.id, decidedBy: (await c.app.repo.getUserByEmail("d@e.com"))!.id,
    decision: "ALLOW", scope: "THIS_DOMAIN", duration: { kind: "MINUTES", minutes: 30 }, policy: c.app.policy,
  });
  assert.equal((await c.app.repo.listTemporaryRules(c.famId)).length, 1);

  const del = await call(c.r, "DELETE", `/v1/families/${c.famId}/children/${c.childId}`, undefined, c.parent);
  assert.equal(del.status, 200);

  assert.deepEqual((await call(c.r, "GET", `/v1/families/${c.famId}/children`, undefined, c.parent)).body, []);
  assert.deepEqual(await listDevices(c), [], "their devices are gone");
  assert.deepEqual(await c.app.repo.listRules(c.famId), [], "their rules are gone");
  assert.deepEqual(await c.app.repo.listTemporaryRules(c.famId), [], "their temporary grants are gone");
  assert.deepEqual(await c.app.repo.listAccessRequests(c.famId), [], "their requests are gone");
  assert.equal(await c.app.repo.getDefaultPolicy(c.famId, c.childId), null, "their default policy is gone");
  assert.equal((await call(c.r, "DELETE", `/v1/families/${c.famId}/children/${c.childId}`, undefined, c.parent)).status, 404);
});

test("a non-member can neither see nor delete another family's devices", async () => {
  const c = await fixture();
  await c.app.auth.register("out@e.com", "correct-horse", "Out");
  const outsider = (await call(c.r, "POST", "/v1/auth/login",
    { email: "out@e.com", password: "correct-horse" })).body as { accessToken: string };
  assert.equal((await call(c.r, "GET", `/v1/families/${c.famId}/devices`, undefined, outsider.accessToken)).status, 403);
  assert.equal((await call(c.r, "DELETE", `/v1/families/${c.famId}/devices/${c.deviceId}`, undefined, outsider.accessToken)).status, 403);
  assert.equal((await call(c.r, "DELETE", `/v1/families/${c.famId}/children/${c.childId}`, undefined, outsider.accessToken)).status, 403);
});
