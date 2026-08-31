/**
 * CNAME resolution for categorization. A first-party hostname is often a CNAME
 * onto a third-party target ("CNAME cloaking" — e.g. metrics.site.com →
 * some-tracker.net, or a vanity CDN subdomain → a blocked category's domain), so
 * classifying only the literal hostname misses the real destination. Resolving
 * the chain and classifying every canonical name closes that bypass.
 *
 * Two impls behind one interface: node:dns on a Node host, DNS-over-HTTPS on
 * Workers (no raw DNS there). Both share the loop-guarded chain follower in
 * @ajar/shared/net and are best-effort — resolution never blocks or fails a
 * decision. NullResolver is the default (tests / when resolution is off).
 */
import { followCnameChain } from "@ajar/shared/net";

export interface CnameResolver {
  /** Canonical names `host` resolves to via its CNAME chain (excluding `host`
   *  itself), normalized. Best-effort; [] on error. */
  resolveChain(host: string): Promise<string[]>;
}

export class NullResolver implements CnameResolver {
  async resolveChain(): Promise<string[]> { return []; }
}

/** node:dns/promises. Follows the CNAME chain via resolveCname (one hop each). */
export class NodeCnameResolver implements CnameResolver {
  async resolveChain(host: string): Promise<string[]> {
    let dns: typeof import("node:dns/promises");
    try { dns = await import("node:dns/promises"); } catch { return []; }
    return followCnameChain(host, async (name) => {
      const recs = await dns.resolveCname(name); // throws on NODATA/NXDOMAIN → chain ends
      return recs[0] ?? null;
    });
  }
}

/** DNS-over-HTTPS (RFC 8484 JSON) for Workers / any fetch-only runtime. */
export class DohCnameResolver implements CnameResolver {
  constructor(private endpoint = "https://cloudflare-dns.com/dns-query", private timeoutMs = 1500) {}
  async resolveChain(host: string): Promise<string[]> {
    return followCnameChain(host, async (name) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.endpoint}?name=${encodeURIComponent(name)}&type=CNAME`,
          { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
        if (!res.ok) return null;
        const body = await res.json() as { Answer?: { type: number; data: string }[] };
        const ans = (body.Answer ?? []).find((a) => a.type === 5); // 5 = CNAME
        return ans?.data ?? null;
      } finally {
        clearTimeout(t);
      }
    });
  }
}
