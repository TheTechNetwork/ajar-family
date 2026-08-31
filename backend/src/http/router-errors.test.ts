/**
 * The router must tell a DELIBERATE refusal apart from a BUG.
 *
 * It used to echo `e.message` for whatever was thrown, and `codeToStatus`
 * defaults to 400 — so a server bug reached the client as a 400 carrying an
 * internal message. That is how a parent approving their child's request got
 * "Cannot destructure property 'expiresAt' of 'durationToExpiry(...)' as it is
 * undefined", and why no 5xx ever appeared for anything alerting to notice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, ok, type HttpRequest } from "./router.js";
import { DomainError } from "../domain/services.js";

const req = (path: string): HttpRequest => ({
  method: "GET", path, query: new URLSearchParams(),
  headers: {}, params: {}, json: async () => ({}) as never,
});

test("a DomainError still reaches the client, with its code and message", async () => {
  const r = new Router();
  r.get("/refuse", async () => { throw new DomainError("that video is not approved", "FORBIDDEN"); });
  r.get("/bad", async () => { throw new DomainError("duration must be positive"); }); // default BAD_REQUEST

  const forbidden = await r.handle(req("/refuse"));
  assert.equal(forbidden.status, 403);
  assert.match(JSON.stringify(forbidden.body), /that video is not approved/);

  const bad = await r.handle(req("/bad"));
  assert.equal(bad.status, 400, "DomainError's default code still maps to 400");
  assert.match(JSON.stringify(bad.body), /duration must be positive/);
});

test("an unexpected throw is a 500 and its message is NOT disclosed", async () => {
  const r = new Router();
  // The exact shape that was reported to a parent.
  r.get("/boom", async () => {
    const undef = undefined as unknown as { expiresAt: string };
    const { expiresAt } = undef; // TypeError: Cannot destructure property...
    return ok({ expiresAt });
  });
  r.get("/range", async () => ok({ at: new Date(NaN).toISOString() })); // RangeError

  for (const path of ["/boom", "/range"]) {
    const res = await r.handle(req(path));
    const body = JSON.stringify(res.body);
    assert.equal(res.status, 500, `${path}: a server bug must be a 5xx, not a 4xx`);
    assert.match(body, /internal error/);
    assert.doesNotMatch(body, /destructure|expiresAt|Invalid time value|RangeError|TypeError/,
      `${path}: internal detail must not reach the client`);
  }
});

test("an error carrying an UNRECOGNISED code is still treated as a bug", async () => {
  // Guards the allowlist: a stray `code` must not buy a 4xx and a free message.
  const r = new Router();
  r.get("/sneaky", async () => {
    throw Object.assign(new Error("SELECT * FROM users failed at /srv/app/db.ts:42"),
      { code: "SQLITE_CONSTRAINT" });
  });
  const res = await r.handle(req("/sneaky"));
  assert.equal(res.status, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /SELECT|srv\/app|SQLITE/);
});
