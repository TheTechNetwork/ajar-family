/**
 * Contract test: the OpenAPI document and the live router must expose EXACTLY the
 * same set of (method, path) pairs. If someone adds a route without documenting it
 * (or documents a route that doesn't exist), this fails — so the spec at
 * /openapi.json can never silently drift from the implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.js";
import { buildRouter } from "./api.js";
import { openapiDocument } from "./openapi.js";

const VERBS = new Set(["get", "post", "put", "delete", "patch"]);
const toSpecPath = (routerPath: string) => routerPath.replace(/:([^/]+)/g, "{$1}");

test("OpenAPI document matches the router's registered routes", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const router = buildRouter(app);

  const routerSet = new Set(router.list().map((r) => `${r.method} ${toSpecPath(r.path)}`));

  const specSet = new Set<string>();
  for (const [path, ops] of Object.entries(openapiDocument.paths as Record<string, Record<string, unknown>>)) {
    for (const method of Object.keys(ops)) {
      if (VERBS.has(method)) specSet.add(`${method.toUpperCase()} ${path}`);
    }
  }

  const onlyInRouter = [...routerSet].filter((x) => !specSet.has(x)).sort();
  const onlyInSpec = [...specSet].filter((x) => !routerSet.has(x)).sort();

  assert.deepEqual(onlyInRouter, [], `routes missing from openapi.json: ${onlyInRouter.join(", ")}`);
  assert.deepEqual(onlyInSpec, [], `openapi.json documents non-existent routes: ${onlyInSpec.join(", ")}`);
});

test("every $ref in the OpenAPI document resolves to a defined schema", () => {
  const schemaNames = new Set(Object.keys(openapiDocument.components.schemas));
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k === "$ref" && typeof val === "string") refs.add(val);
        else walk(val);
      }
    }
  };
  walk(openapiDocument);
  const dangling = [...refs].filter((r) => {
    const m = /^#\/components\/schemas\/(.+)$/.exec(r);
    return !m || !schemaNames.has(m[1]!);
  });
  assert.deepEqual(dangling, [], `unresolved $refs: ${dangling.join(", ")}`);
});
