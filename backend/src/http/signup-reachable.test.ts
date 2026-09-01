/**
 * Can anyone actually create an account?
 *
 * On a self-hosted deployment the answer was no. INSTALL.md documented four env
 * vars and none of them were the mail ones, so the server accepted the sign-up,
 * answered 202, told the parent to check their inbox, and dropped the message —
 * with no error on any screen. The server says so at boot; the guide did not.
 *
 * And even with mail wired, `VERIFY_EMAIL_URL` was also undocumented, so the
 * email carried a bare code with no link — and there was nowhere in the entire
 * product to type one. Both redemption sites read it from the address bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../app.js";
import { buildRouter } from "./api.js";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("a code that arrives without a link can still be redeemed", () => {
  const html = read("web/site/signup.html");
  assert.ok(/id="verifyCode"/.test(html), "no field to paste a confirmation code into");
  assert.ok(/autocomplete="one-time-code"/.test(html),
    "the paste field should let a phone offer the code from the email");

  const js = read("web/site/signup.js");
  assert.ok(/getElementById\("sPaste"\)/.test(js), "the paste form is not wired up");
  // Both routes must end in the same function, or they can answer differently
  // about what a confirmation means.
  const handler = js.slice(js.indexOf('getElementById("sPaste")'));
  assert.ok(/resumeFromEmail\(/.test(handler.slice(0, 900)),
    "the typed code must go through the same path as the clicked link");
  assert.ok(/verify=/.test(handler.slice(0, 900)),
    "a parent who pastes the whole URL should be understood");
});

test("the HTTP sign-up creates nothing until the code is spent", async () => {
  // The route a browser uses — NOT `auth.register`, which is the direct
  // primitive the tests build fixtures with. With no mail configured this
  // answers 202 and the message is dropped, which is the dead end INSTALL.md now
  // warns about. What must NOT happen is a silent success: an account that
  // exists while the parent is told to check an inbox that will never receive
  // anything would leave them locked out of something they think they made.
  const app = await App.create({ config: { authSecret: "test" } });
  const r = buildRouter(app);
  const res = await r.handle({
    method: "POST", path: "/v1/auth/register", query: new URLSearchParams(), headers: {},
    params: {}, json: async () => ({ email: "nobody@example.com", password: "correct-horse", displayName: "N" }) as never,
  });
  assert.equal(res.status, 202);
  assert.equal(await app.repo.getUserByEmail("nobody@example.com"), null,
    "no account exists until the confirmation code is spent");
});

test("INSTALL.md tells an operator the thing that decides whether signup works", () => {
  const doc = read("docs/INSTALL.md");
  for (const v of ["MAIL_ENDPOINT", "MAIL_TOKEN", "VERIFY_EMAIL_URL"]) {
    assert.ok(doc.includes(v), `${v} is what makes signup possible and the guide does not mention it`);
  }
  assert.ok(/nobody can create an account/i.test(doc),
    "the consequence must be stated, not left as an exercise");
});

test("the release zip ships the pages an account is created on", () => {
  // It shipped web/parent only — a sign-IN page and nowhere to sign UP, plus no
  // privacy notice or terms to link to.
  const wf = read(".github/workflows/release.yml");
  assert.ok(/cp -r web\/site /.test(wf), "web/site is not in the release archive");
  assert.ok(!/cp docs\/INSTALL\.md .*\|\| true/.test(wf),
    "a missing install guide must fail the build, not ship an archive with no instructions");
});
