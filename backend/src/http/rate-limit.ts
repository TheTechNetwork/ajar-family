/**
 * Tiny in-memory sliding-window rate limiter for the sensitive unauthenticated
 * endpoints (login, register, refresh, enrollment redeem) — blunts brute-force
 * and credential-stuffing. Per-process; back it with Redis / a Durable Object
 * for a multi-instance deployment (same `allow()` contract).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}

  /** Record an attempt for `key`; returns false once the window is over budget. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.sweep(cutoff); // bound memory under attack
    return arr.length <= this.limit;
  }

  private sweep(cutoff: number) {
    for (const [k, arr] of this.hits) {
      const live = arr.filter((t) => t > cutoff);
      if (live.length) this.hits.set(k, live); else this.hits.delete(k);
    }
  }
}

/** Best-effort client identifier from proxy headers; falls back to a shared key
 *  (so a limit still applies even when no IP is forwarded). */
export function clientKey(headers: Record<string, string>): string {
  const cf = headers["cf-connecting-ip"];
  const xff = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  const xr = headers["x-real-ip"];
  return cf || xff || xr || "shared";
}
