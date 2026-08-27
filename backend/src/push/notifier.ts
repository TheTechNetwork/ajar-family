/**
 * Push abstraction. The alpha ships an in-memory/console Notifier; APNs and a
 * real WebSocket/SSE fan-out drop in behind the same interface. Keeping this an
 * interface means the approval flow doesn't care which transport delivers the
 * "you have a request" / "sync now" nudge.
 */
import type { NotificationEndpoint } from "../domain/model.js";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface Notifier {
  send(endpoint: NotificationEndpoint, msg: PushMessage): Promise<void>;
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
