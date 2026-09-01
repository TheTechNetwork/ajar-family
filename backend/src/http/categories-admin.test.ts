/**
 * The gate on `PUT /v1/categories/dataset`, which replaces the domain→category
 * dataset for EVERY family on the instance. Registration is open, so "any
 * authenticated user" was never an acceptable bar for that: one account could
 * wipe or poison category enforcement for everyone.
 *
 * HONEST PROVENANCE: the gate itself (off unless `CATEGORY_ADMIN_TOKEN` is set,
 * then `x-admin-token` must match) was already in the code and is what
 * docs/SECURITY.md lists under "In place" — the "not yet role-restricted" entry
 * under Deferred had gone stale and contradicted it. These tests were added
 * because the gate had NO coverage at all, not because they were failing. They
 * pass before and after this change and prove nothing about it; what they do is
 * stop the gate from being removed by accident.
 *
 * A deployment secret, not a per-user admin flag, deliberately: an admin flag on
 * an account puts a switch over global reference data behind that parent's
 * password and inbox, so a single account takeover reaches every family. The ops
 * credential is reachable only by whoever can deploy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import type { HttpRequest, HttpResponse } from "./router.js";

async function fixture(categoryAdminToken?: string) {
  const app = await App.create({ config: { authSecret: "test", categoryAdminToken } });
  const r = buildRouter(app);
  await app.auth.register("p@e.com", "correct-horse", "P");
  const login = await r.handle({
    method: "POST", path: "/v1/auth/login", query: new URLSearchParams(),
    headers: { "cf-connecting-ip": "7.7.7.1" }, params: {},
    json: async () => ({ email: "p@e.com", password: "correct-horse" }) as never,
  });
  const access = (login.body as { accessToken: string }).accessToken;
  const importDataset = (adminToken?: string, auth = access): Promise<HttpResponse> => {
    const req: HttpRequest = {
      method: "PUT", path: "/v1/categories/dataset", query: new URLSearchParams(),
      headers: {
        "cf-connecting-ip": "7.7.7.1",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(adminToken === undefined ? {} : { "x-admin-token": adminToken }),
      },
      params: {}, json: async () => ({ categories: { social: ["example.com"] } }) as never,
    };
    return r.handle(req);
  };
  return { app, r, access, importDataset };
}

test("dataset import is OFF unless the deployment configures an ops credential", async () => {
  const { app, importDataset } = await fixture(undefined);
  const before = await app.categories.version();
  assert.equal((await importDataset()).status, 503, "a signed-in parent cannot replace global data");
  assert.equal((await importDataset("guess")).status, 503);
  assert.equal(await app.categories.version(), before, "the dataset is untouched");
});

test("with a credential configured, only the credential opens it", async () => {
  const { app, importDataset } = await fixture("ops-secret");
  const before = await app.categories.version();

  assert.equal((await importDataset()).status, 403, "a signed-in parent without the credential");
  assert.equal((await importDataset("wrong-secret")).status, 403);
  assert.equal((await importDataset("ops-secre")).status, 403, "a prefix is not close enough");
  assert.equal((await importDataset("ops-secretx")).status, 403);
  assert.equal(await app.categories.version(), before, "none of that changed the dataset");

  // The credential alone is not enough either: a session is still required, so
  // the endpoint is not reachable by a leaked header on its own.
  assert.equal((await importDataset("ops-secret", "")).status, 401);

  const good = await importDataset("ops-secret");
  assert.equal(good.status, 200);
  assert.ok(await app.categories.version() > before, "the import landed");
  assert.deepEqual(await app.repo.categoriesForHost("example.com"), ["social"]);
});
