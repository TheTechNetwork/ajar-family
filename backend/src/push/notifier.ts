/**
 * Push abstraction. The alpha ships an in-memory/console Notifier; APNs and a
 * real WebSocket/SSE fan-out drop in behind the same interface. Keeping this an
 * interface means the approval flow doesn't care which transport delivers the
 * "you have a request" / "sync now" nudge.
 */
import type { NotificationEndpoint } from "../domain/model.js";
import type { EventHub } from "./hub.js";

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

/** Logs to console; a placeholder for APNs/WebSocket in the alpha. */
export class ConsoleNotifier implements Notifier {
  async send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[push:${endpoint.kind}→${endpoint.userId}] ${msg.title}: ${msg.body}`, msg.data ?? {});
  }
}
