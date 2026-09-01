/**
 * Nobody was ever notified: the only wired Notifier logged to stdout. These
 * tests pin the delivery path that replaces it — a dependency-free MailSender,
 * an EmailNotifier that routes EMAIL endpoints to it, and the App wiring that
 * turns "a child asked for something" into a message in a parent's inbox.
 *
 * All offline: FetchMailSender gets an injected fetch, App gets an in-memory
 * MailSender. No network, no provider account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchMailSender, InMemoryMailSender, NullMailSender } from "./mail.js";
import { EmailNotifier, InMemoryNotifier } from "./notifier.js";
import { App } from "../app.js";
import type { NotificationEndpoint } from "../domain/model.js";

const ep = (kind: NotificationEndpoint["kind"], token: string): NotificationEndpoint =>
  ({ id: "e", userId: "u", kind, token, createdAt: new Date().toISOString() });

test("FetchMailSender posts the provider envelope with a bearer token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;

  const sender = new FetchMailSender({
    endpoint: "https://mail.example/send", token: "secret-token",
    from: "Ajar <no-reply@ajar.test>", fetchImpl: fakeFetch,
  });
  await sender.send({ to: "parent@example.com", subject: "Hi", text: "body" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://mail.example/send");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret-token");
  assert.equal(headers["content-type"], "application/json");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body, {
    from: "Ajar <no-reply@ajar.test>", to: "parent@example.com", subject: "Hi", text: "body",
  });
});

test("a provider failure never propagates into the caller", async () => {
  const boom = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const sender = new FetchMailSender({ endpoint: "https://x/y", token: "t", fetchImpl: boom });
  // A provider outage must not turn a child's access request into a 500.
  await sender.send({ to: "a@b.com", subject: "s", text: "t" });
});

test("EmailNotifier sends EMAIL endpoints and delegates everything else", async () => {
  const mail = new InMemoryMailSender();
  const base = new InMemoryNotifier();
  const notifier = new EmailNotifier(mail, base);

  await notifier.send(ep("EMAIL", "parent@example.com"), { title: "Jane asked", body: "youtube.com" });
  await notifier.send(ep("WEBSOCKET", "device-1"), { title: "policy_update", body: "sync" });

  assert.equal(mail.sent.length, 1, "the email endpoint went to the mail sender");
  assert.equal(mail.sent[0]!.to, "parent@example.com");
  assert.equal(mail.sent[0]!.subject, "Jane asked");
  assert.match(mail.sent[0]!.text, /youtube\.com/);
  assert.equal(base.sent.length, 1, "the websocket nudge fell through to the base notifier");
  assert.equal(base.sent[0]!.endpoint.kind, "WEBSOCKET");
});

test("a malformed address is never handed to the provider", async () => {
  const mail = new InMemoryMailSender();
  await new EmailNotifier(mail, new InMemoryNotifier()).send(ep("EMAIL", "not-an-address"), { title: "t", body: "b" });
  assert.equal(mail.sent.length, 0);
});

test("an ask does NOT go by email — the medium has to match the message", async () => {
  const mail = new InMemoryMailSender();
  const app = await App.create({ mail, config: { authSecret: "test" } });

  // Register through the real auth path (what POST /v1/auth/register calls).
  const owner = await app.auth.register("owner@example.com", "correct-horse", "Owner");
  const endpoints = await app.repo.listNotificationEndpoints(owner.id);
  assert.deepEqual(
    endpoints.map((e) => [e.kind, e.token]),
    [["EMAIL", "owner@example.com"]],
    "registration still creates the endpoint — it carries the ACCOUNT lifecycle",
  );

  const fam = await app.family.createFamily("F", owner.id);
  const child = await app.family.addChild(fam.id, owner.id, "Jane");
  const tok = await app.enrollment.createToken(fam.id, owner.id, child.id, "IOS");
  const device = await app.enrollment.redeem(tok.code, "pk", "iPhone");

  await app.approvals.createRequest({
    familyId: fam.id, childId: child.id, deviceId: device.id,
    targetType: "YOUTUBE_VIDEO", targetValue: "9bZkp7q19f0", title: "Photosynthesis",
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
  });

  // This test used to assert the opposite, and the product is better for the
  // change. "Say yes faster" is measured in seconds; email lands in a pile, has
  // no receipt, and arrives whenever the provider gets to it. One message per
  // ask is also how an inbox becomes something a parent stops opening — the same
  // as no notification, only noisier.
  //
  // It also decouples the core loop from mail entirely. An unverified sending
  // domain made a child's "Ask to open it" return 500; a path that never touches
  // mail cannot fail that way at all.
  assert.equal(mail.sent.length, 0, "an ask must not be emailed");

  // The ask is still delivered — by the channel built for it. Every parent
  // client long-polls this feed, which is what makes an approval feel instant.
  const pending = await app.repo.listAccessRequests(fam.id, "PENDING");
  assert.equal(pending.length, 1, "the ask is in the feed the console long-polls");
  assert.match(pending[0]!.title ?? "", /Photosynthesis/);
});

test("registering twice is idempotent for the email endpoint", async () => {
  const app = await App.create({ config: { authSecret: "test" } });
  const user = await app.auth.register("dup@example.com", "correct-horse", "D");
  await app.auth.registerEmailEndpoint(user);
  await app.auth.registerEmailEndpoint(user);
  assert.equal((await app.repo.listNotificationEndpoints(user.id)).length, 1);
});

test("NullMailSender is the safe default and does not throw", async () => {
  await new NullMailSender().send({ to: "a@b.com", subject: "s", text: "t" });
});
