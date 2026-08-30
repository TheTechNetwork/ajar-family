/**
 * Push/notification delivery.
 *
 * The alpha shipped only `ConsoleNotifier`, which means the headline promise —
 * "a parent hears about a request in seconds" — was satisfied by a line in the
 * server's stdout that no parent will ever read. `EmailNotifier` is the first
 * transport that actually reaches a human; APNs and Web Push are documented
 * adapters below (the credential/protocol work is real and is NOT faked here).
 *
 * Everything stays behind the `Notifier` interface, so the approval flow does
 * not care which transport delivers the nudge, and a `DispatchNotifier` fans one
 * message out to whichever transport an endpoint's `kind` names.
 */
import type { NotificationEndpoint } from "../domain/model.js";
import type { EventHub } from "./hub.js";
import { NullMailSender, type MailSender } from "./mail.js";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface Notifier {
  send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void>;
}

/**
 * Composes a base notifier and, for device-targeted (WEBSOCKET) nudges, wakes the
 * device's long-poll waiter on the hub so the approved policy arrives in seconds.
 * `endpoint.token` for a device nudge is the deviceId (see ApprovalService.decide).
 */
export class HubNotifier implements Notifier {
  constructor(private base: Notifier, private hub: EventHub) {}
  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    await this.base.send(endpoint, msg);
    if (endpoint.kind === "WEBSOCKET") this.hub.notify(`device:${endpoint.token}`);
  }
}

/** Records sent messages; used by tests and local dev. */
export class InMemoryNotifier implements Notifier {
  public sent: Array<{ endpoint: NotificationEndpoint; msg: PushMessage }> = [];
  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    this.sent.push({ endpoint, msg });
  }
}

/** Logs to console. Still the fallback for endpoint kinds with no transport. */
export class ConsoleNotifier implements Notifier {
  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[push:${endpoint.kind}→${endpoint.userId}] ${msg.title}: ${msg.body}`, msg.data ?? {});
  }
}

/**
 * Delivers EMAIL endpoints through a `MailSender`; anything else falls through
 * to `base`. `endpoint.token` is the destination address.
 *
 * The body is deliberately terse. A notification about a blocked page is itself
 * sensitive — it says what a child tried to reach — so we name the child and the
 * ask, and keep the target on one line rather than quoting a full URL with query
 * parameters into an inbox that may be read on a shared screen.
 */
export class EmailNotifier implements Notifier {
  constructor(private mail: MailSender = new NullMailSender(), private base: Notifier = new ConsoleNotifier()) {}

  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    if (endpoint.kind !== "EMAIL") return this.base.send(endpoint, msg);
    const to = endpoint.token?.trim();
    if (!to || !to.includes("@")) return; // never hand a malformed address to a provider
    await this.mail.send({ to, subject: msg.title, text: renderBody(msg) });
  }
}

function renderBody(msg: PushMessage): string {
  const lines = [msg.body];
  const data = msg.data ?? {};
  if (typeof data.url === "string") lines.push("", data.url);
  if (typeof data.actionUrl === "string") lines.push("", data.actionUrl);
  lines.push("", "— Ajar");
  return lines.join("\n");
}

/**
 * Fans a message out by endpoint kind. Unknown/unconfigured kinds fall through
 * to `fallback` so nothing is silently dropped without a trace.
 */
export class DispatchNotifier implements Notifier {
  constructor(
    private routes: Partial<Record<NotificationEndpoint["kind"], Notifier>>,
    private fallback: Notifier = new ConsoleNotifier(),
  ) {}
  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    await (this.routes[endpoint.kind] ?? this.fallback).send(endpoint, msg);
  }
}

// ---------------------------------------------------------------------------
// Documented adapters: APNs and Web Push
// ---------------------------------------------------------------------------
//
// These are intentionally NOT implemented. Both need real credentials and real
// crypto that cannot be exercised or verified offline, and a stub that "sends"
// nothing while reporting success is exactly the failure mode this whole change
// set exists to remove. They therefore fail loudly and are never wired by
// default; `App` selects EmailNotifier when mail is configured, ConsoleNotifier
// otherwise.
//
// APNs (iOS/iPadOS/macOS parent app), when implemented here:
//   - Auth: ES256 JWT signed with the .p8 team key (`APNS_KEY_ID`, `APNS_TEAM_ID`,
//     `APNS_KEY_P8`), `iss`=team, `iat`=now; cache the JWT ~50 min. WebCrypto can
//     do ES256, so this stays dependency-free.
//   - Transport: POST https://api.push.apple.com/3/device/<token> with headers
//     apns-topic=<bundle id>, apns-push-type=alert, apns-priority=10,
//     apns-collapse-id=<requestId> (so N nudges about one request collapse).
//   - Payload: { aps: { alert: { title, body }, sound: "default" }, ...data }.
//   - Errors: 410 Unregistered ⇒ delete the NotificationEndpoint row.
//   - Node caveat: HTTP/2 is required; `fetch` is fine on Workers, Node needs
//     node:http2 (still no npm dependency).
//
// Web Push (parent console in a browser), when implemented here:
//   - `endpoint.token` holds the PushSubscription JSON ({ endpoint, keys.p256dh,
//     keys.auth }).
//   - Auth: VAPID — ES256 JWT over { aud: origin, exp, sub: mailto:… } signed
//     with `VAPID_PRIVATE_KEY`; send `Authorization: vapid t=<jwt>, k=<pubkey>`.
//   - Body: RFC 8291 aes128gcm — ECDH P-256 against the subscription key, HKDF,
//     AES-GCM. All available in WebCrypto; still no dependency.
//   - Errors: 404/410 ⇒ delete the endpoint row; 413 ⇒ payload too large.
//
// Until then, registering an APNS/WEBPUSH endpoint is accepted and stored, and
// delivery to it degrades to the fallback notifier rather than pretending.

class UnimplementedAdapter implements Notifier {
  constructor(private what: string) {}
  async send(): Promise<void> {
    throw Object.assign(new Error(`${this.what} delivery is not configured on this deployment`), { code: "DISABLED" });
  }
}

/** Placeholder that fails loudly if someone wires it without implementing it. */
export const ApnsNotifier = () => new UnimplementedAdapter("APNs");
/** Placeholder that fails loudly if someone wires it without implementing it. */
export const WebPushNotifier = () => new UnimplementedAdapter("Web Push");
