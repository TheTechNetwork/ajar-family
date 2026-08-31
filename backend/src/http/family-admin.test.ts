/**
 * Adding a co-parent used to take a raw `userId` on trust. Anything you sent —
 * an email address, a typo, a random string — produced a membership row that
 * showed up in the family, counted as an approver, and belonged to an account
 * nobody could ever sign into. Guardians could likewise be "assigned" children
 * that do not exist.
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

async function fixture() {
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const register = async (email: string, name: string) =>
    ((await call(r, "POST", "/v1/auth/register", { email, password: "correct-horse", displayName: name })).body as
      { accessToken: string; userId: string });
  const owner = await register("owner@e.com", "Owner");
  const coparent = await register("co@e.com", "Co");
  const fam = (await call(r, "POST", "/v1/families", { name: "F" }, owner.accessToken)).body as { id: string };
  const child = (await call(r, "POST", `/v1/families/${fam.id}/children`, { displayName: "Kid" }, owner.accessToken)).body as { id: string };
  return { app, r, owner, coparent, famId: fam.id, childId: child.id };
}

test("a co-parent is invited by email and can then act in the family", async () => {
  const { r, owner, coparent, famId } = await fixture();
  const res = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "co@e.com", role: "PARENT" }, owner.accessToken);
  assert.equal(res.status, 201);
  assert.equal((res.body as { userId: string }).userId, coparent.userId, "resolved to the real account");

  // The invited parent can now see the family.
  assert.equal((await call(r, "GET", `/v1/families/${famId}`, undefined, coparent.accessToken)).status, 200);
});

test("an unknown email is refused instead of creating a membership pointing at nobody", async () => {
  const { app, r, owner, famId } = await fixture();
  const res = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "stranger@e.com", role: "PARENT" }, owner.accessToken);
  assert.equal(res.status, 404);
  assert.match((res.body as { error: string }).error, /no Ajar account uses that email/);
  assert.equal((await app.repo.listMemberships(famId)).length, 1, "still just the owner — no dangling row");
});

test("a raw userId that is not an account is refused too", async () => {
  const { app, r, owner, famId } = await fixture();
  // The exact old bug: an email posted into the userId field.
  const asEmail = await call(r, "POST", `/v1/families/${famId}/parents`,
    { userId: "co@e.com", role: "PARENT" }, owner.accessToken);
  assert.equal(asEmail.status, 404, "an email in the userId field is not a user id");

  const garbage = await call(r, "POST", `/v1/families/${famId}/parents`,
    { userId: "not-a-real-id", role: "PARENT" }, owner.accessToken);
  assert.equal(garbage.status, 404);
  assert.equal((await app.repo.listMemberships(famId)).length, 1, "no dangling memberships");
});

test("a guardian cannot be assigned a child from another family (or one that does not exist)", async () => {
  const { app, r, owner, famId } = await fixture();
  const other = (await call(r, "POST", "/v1/families", { name: "Other" }, owner.accessToken)).body as { id: string };
  const otherChild = (await call(r, "POST", `/v1/families/${other.id}/children`, { displayName: "Elsewhere" }, owner.accessToken)).body as { id: string };

  const foreign = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "co@e.com", role: "LIMITED_GUARDIAN", assignedChildIds: [otherChild.id] }, owner.accessToken);
  assert.equal(foreign.status, 404);

  const bogus = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "co@e.com", role: "LIMITED_GUARDIAN", assignedChildIds: ["nope"] }, owner.accessToken);
  assert.equal(bogus.status, 404);
  assert.equal((await app.repo.listMemberships(famId)).length, 1);
});

test("a valid guardian assignment is accepted, deduped, and only for LIMITED_GUARDIAN", async () => {
  const { r, owner, famId, childId } = await fixture();
  const good = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "co@e.com", role: "LIMITED_GUARDIAN", assignedChildIds: [childId, childId] }, owner.accessToken);
  assert.equal(good.status, 201);
  assert.deepEqual((good.body as { assignedChildIds: string[] }).assignedChildIds, [childId]);

  const app2 = await fixture();
  const misuse = await call(app2.r, "POST", `/v1/families/${app2.famId}/parents`,
    { email: "co@e.com", role: "PARENT", assignedChildIds: [app2.childId] }, app2.owner.accessToken);
  assert.equal(misuse.status, 400, "an assignment list on a full PARENT would read as a limit nothing enforces");
});

test("the same person cannot be added twice, and an unknown role is refused", async () => {
  const { r, owner, famId } = await fixture();
  assert.equal((await call(r, "POST", `/v1/families/${famId}/parents`, { email: "co@e.com", role: "PARENT" }, owner.accessToken)).status, 201);
  const dupe = await call(r, "POST", `/v1/families/${famId}/parents`, { email: "co@e.com", role: "PARENT" }, owner.accessToken);
  assert.equal(dupe.status, 409);

  const badRole = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "co@e.com", role: "SUPERUSER" }, owner.accessToken);
  assert.equal(badRole.status, 400);
});

test("only an OWNER can add parents", async () => {
  const { r, owner, coparent, famId } = await fixture();
  await call(r, "POST", `/v1/families/${famId}/parents`, { email: "co@e.com", role: "PARENT" }, owner.accessToken);
  const res = await call(r, "POST", `/v1/families/${famId}/parents`,
    { email: "owner@e.com", role: "PARENT" }, coparent.accessToken);
  assert.equal(res.status, 403);
});
