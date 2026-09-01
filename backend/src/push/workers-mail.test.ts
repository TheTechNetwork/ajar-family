import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkersEmailSender, type EmailBinding } from "./mail.js";

/**
 * The binding is the only path a verification code takes to a parent now, and
 * account creation is gated on that code arriving. A wrong field name here is
 * not a degraded experience — it is nobody being able to sign up.
 */
function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  const binding: EmailBinding = {
    async send(msg) { sent.push({ ...msg }); return { messageId: "msg_1" }; },
  };
  return { sent, binding };
}

test("sends with the field names the binding actually reads", async () => {
  const { sent, binding } = recorder();
  await new WorkersEmailSender(binding, "no-reply@ajar.family")
    .send({ to: "parent@example.com", subject: "Confirm your address", text: "code 123456" });

  assert.equal(sent.length, 1);
  // from/to/subject/text — the documented shape. A typo in any one of these
  // throws at the provider, not at compile time.
  assert.deepEqual(sent[0], {
    from: "no-reply@ajar.family",
    to: "parent@example.com",
    subject: "Confirm your address",
    text: "code 123456",
  });
});

test("sends no HTML at all", async () => {
  const { sent, binding } = recorder();
  await new WorkersEmailSender(binding, "no-reply@ajar.family")
    .send({ to: "p@example.com", subject: "s", text: "t" });
  // Deliberate, and the same choice FetchMailSender documents: a remote image in
  // an HTML mail is a read receipt on a message about someone's child.
  assert.equal("html" in sent[0]!, false);
});

test("a refusal from the binding propagates instead of being swallowed", async () => {
  // E_SENDER_NOT_VERIFIED is a configuration error — the domain is not onboarded.
  // Swallowing it here would report a sent confirmation that never left.
  const binding: EmailBinding = {
    async send() { throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" }); },
  };
  await assert.rejects(
    () => new WorkersEmailSender(binding, "no-reply@nope.example").send({ to: "a@b.c", subject: "s", text: "t" }),
    /sender not verified/,
  );
});
