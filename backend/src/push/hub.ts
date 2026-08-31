/**
 * In-memory event hub for near-real-time delivery: a long-poll `wait` endpoint
 * parks on a device key and is woken the instant an approval nudges that device,
 * so the child refreshes within a second or two instead of on a poll interval.
 *
 * Scope: within a single process/isolate. On a multi-instance Node deployment or
 * across Cloudflare isolates, back this with Redis pub/sub or a Durable Object —
 * the `EventHub` interface stays the same. The long-poll design itself is
 * cross-runtime (no streaming), so only the fan-out needs swapping at scale.
 */
export class EventHub {
  private waiters = new Map<string, Set<() => void>>();

  /** Wake everyone waiting on `key`. */
  notify(key: string): void {
    const set = this.waiters.get(key);
    if (!set) return;
    for (const resolve of [...set]) resolve();
  }

  /**
   * Resolve when `key` is notified, or after `timeoutMs`. Returns true if woken
   * by a notify, false on timeout.
   */
  wait(key: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const set = this.waiters.get(key) ?? new Set<() => void>();
      this.waiters.set(key, set);

      const finish = (woken: boolean) => {
        if (done) return;
        done = true;
        set.delete(wake);
        if (set.size === 0) this.waiters.delete(key);
        clearTimeout(timer);
        resolve(woken);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      set.add(wake);
    });
  }
}
