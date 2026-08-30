/** The spec side: every conformance vector must hold for the shared evaluator. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../policy/policy-model.js";
import { VECTORS } from "./vectors.js";

for (const v of VECTORS) {
  test(`conformance (shared): ${v.name}`, () => {
    const res = evaluate(v.snapshot, v.ctx as never);
    assert.equal(res.action, v.expect.action, `${v.name} -> ${res.reason}`);
    if (v.expect.reason) assert.equal(res.reason, v.expect.reason);
  });
}
