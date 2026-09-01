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

/**
 * Client identifier for rate limiting.
 *
 * FORWARDING HEADERS ARE CLIENT INPUT unless something you trust sets them. This
 * used to read `cf-connecting-ip`, `x-forwarded-for` and `x-real-ip`
 * unconditionally, so on the self-hosted single binary — the documented install —
 * rotating `X-Forwarded-For` on each request gave every attempt a fresh bucket
 * and the limit simply was not there. Measured: 10 attempts then 429 from one
 * client; 30 attempts and no 429 with the header rotating. That is the only
 * brute-force control on login, register, forgot, reset and enrollment redeem,
 * and each login attempt costs 600,000 PBKDF2 iterations, so it is a CPU
 * amplifier as well as a credential one.
 *
 * `cf-connecting-ip` is set BY Cloudflare at the edge and cannot be forged by a
 * client reaching the Worker, so it is trusted where the runtime is Workers. The
 * two `x-` headers are trusted only when the operator says a proxy sets them,
 * via `trustProxyHeaders`. Untrusted input falls back to the shared key, which
 * limits everyone together — worse for a busy deployment behind an unconfigured
 * proxy, and the only answer that is not "no limit at all".
 *
 * @param trustProxyHeaders true when a reverse proxy the operator controls
 *   overwrites `x-forwarded-for` / `x-real-ip` on every inbound request. Never
 *   set it for a server reachable directly from the internet.
 */
export function clientKey(headers: Record<string, string>, trustProxyHeaders = false): string {
  // Cloudflare sets this itself and strips any client-supplied copy.
  const cf = headers["cf-connecting-ip"];
  if (cf) return cf;
  if (trustProxyHeaders) {
    const xff = headers["x-forwarded-for"]?.split(",")[0]?.trim();
    const xr = headers["x-real-ip"];
    if (xff || xr) return xff || xr!;
  }
  return "shared";
}
