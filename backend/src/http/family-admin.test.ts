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
  // Accounts are made with the account-creation primitive and then signed in:
  // the HTTP sign-up path deliberately hands back no tokens any more (it answers
  // 202 and emails a link — see auth-verify.test.ts).
  const register = async (email: string, name: string) => {
    await app.auth.register(email, "correct-horse", name);
    return (await call(r, "POST", "/v1/auth/login", { email, password: "correct-horse" })).body as
      { accessToken: string; userId: string };
  };
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

test("a LIMITED_GUARDIAN sees only their own child — requests, children, rules, audit", async () => {
  // model.ts calls assignedChildIds "the children they may see/act on", and
  // devices + decisions honoured that. The request feed, the child list, the
  // rule list and the audit log did not, and each returned the whole family.
  //
  // An access request carries the URL, the title, and the child's own words
  // about why they want it. So a babysitter, a step-parent or an ex-partner,
  // given the deliberately narrow role, could read every other child's asks
  // verbatim. That is the most sensitive data this product holds.
  const { app, r, owner, coparent, famId, childId } = await fixture();
  const other = (await call(r, "POST", `/v1/families/${famId}/children`,
    { displayName: "Other" }, owner.accessToken)).body as { id: string };
  await app.family.addParent(famId, owner.userId, coparent.userId, "LIMITED_GUARDIAN", [childId]);

  // Both children file an ask.
  const enrol = async (kid: string) => {
    const tok = await app.enrollment.createToken(famId, owner.userId, kid, "WINDOWS");
    return app.enrollment.redeem(tok.code, `pk-${kid}`, "PC");
  };
  const mine = await enrol(childId);
  const theirs = await enrol(other.id);
  await app.approvals.createRequest({
    familyId: famId, childId, deviceId: mine.id,
    targetType: "DOMAIN", targetValue: "mine.example", title: "mine",
  });
  await app.approvals.createRequest({
    familyId: famId, childId: other.id, deviceId: theirs.id,
    targetType: "URL", targetValue: "https://sensitive.example/help", title: "a private thing",
    reason: "personal",
  });

  // A rule for each child, plus one for the whole family.
  await app.policy.addRule(famId, owner.userId, {
    target: "DOMAIN", value: "a.example", action: "BLOCK",
    scope: { type: "CHILD", familyId: famId, childId },
  });
  await app.policy.addRule(famId, owner.userId, {
    target: "DOMAIN", value: "b.example", action: "BLOCK",
    scope: { type: "CHILD", familyId: famId, childId: other.id },
  });
  await app.policy.addRule(famId, owner.userId, {
    target: "DOMAIN", value: "everyone.example", action: "BLOCK",
    scope: { type: "FAMILY", familyId: famId },
  });

  const g = coparent.accessToken;

  const reqs = (await call(r, "GET", `/v1/families/${famId}/requests`, undefined, g)).body as { childId: string }[];
  assert.deepEqual(reqs.map((x) => x.childId), [childId], "only their child's asks");

  const waited = (await call(r, "GET", `/v1/families/${famId}/requests/wait?count=1&timeout=0`, undefined, g))
    .body as { requests: { childId: string }[] };
  assert.deepEqual(waited.requests.map((x) => x.childId), [childId], "the long-poll feed is filtered too");

  const kids = (await call(r, "GET", `/v1/families/${famId}/children`, undefined, g)).body as { id: string }[];
  assert.deepEqual(kids.map((k) => k.id), [childId]);

  const rules = (await call(r, "GET", `/v1/families/${famId}/rules`, undefined, g)).body as
    { value: string }[];
  assert.deepEqual(rules.map((x) => x.value).sort(), ["a.example", "everyone.example"],
    "their child's rules and the family-wide ones; not the other child's");

  const audit = await call(r, "GET", `/v1/families/${famId}/audit`, undefined, g);
  assert.equal(audit.status, 403, "the family-wide log cannot be safely sliced, so it is refused");

  // The owner still sees everything.
  const allReqs = (await call(r, "GET", `/v1/families/${famId}/requests`, undefined, owner.accessToken))
    .body as unknown[];
  assert.equal(allReqs.length, 2);
  assert.equal((await call(r, "GET", `/v1/families/${famId}/audit`, undefined, owner.accessToken)).status, 200);
});

test("one family cannot delete another family's rule", async () => {
  // Both stores took a familyId and ignored it, so the tenancy check upstream —
  // "are you a member of THIS family" — was the only thing standing between
  // DELETE /v1/families/<mine>/rules/<yours> and a 200. It needed a known rule
  // id, so it was never remotely exploitable; it was still a store not honouring
  // an argument its own signature declares.
  //
  // ONE app, TWO families. An earlier version of this test built two fixtures,
  // which are two separate App instances with separate stores — so the delete
  // was a no-op for a reason that had nothing to do with tenancy, and the test
  // passed against the bug.
  const { app, r, owner: ownerA, famId: famA } = await fixture();
  const registerB = async () => {
    await app.auth.register("b@e.com", "correct-horse", "B");
    return (await call(r, "POST", "/v1/auth/login", { email: "b@e.com", password: "correct-horse" }))
      .body as { accessToken: string; userId: string };
  };
  const ownerB = await registerB();
  const famB = (await call(r, "POST", "/v1/families", { name: "B" }, ownerB.accessToken)).body as { id: string };

  const theirRule = (await call(r, "POST", `/v1/families/${famA}/rules`, {
    target: "DOMAIN", value: "theirs.example", action: "BLOCK", scope: { type: "FAMILY" },
  }, ownerA.accessToken)).body as { id: string };

  // B's owner, acting inside B's own family, naming A's rule.
  const res = await call(r, "DELETE", `/v1/families/${famB.id}/rules/${theirRule.id}`,
    undefined, ownerB.accessToken);
  assert.equal(res.status, 200, "nothing to delete is not an error");

  const stillThere = (await call(r, "GET", `/v1/families/${famA}/rules`, undefined, ownerA.accessToken))
    .body as { id: string }[];
  assert.ok(stillThere.some((x) => x.id === theirRule.id), "their rule survives");
});
