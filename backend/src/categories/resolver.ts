/**
 * CNAME resolution for categorization. A first-party hostname is often a CNAME
 * onto a third-party target ("CNAME cloaking" — e.g. metrics.site.com →
 * some-tracker.net, or a vanity CDN subdomain → a blocked category's domain), so
 * classifying only the literal hostname misses the real destination. Resolving
 * the chain and classifying every canonical name closes that bypass.
 *
 * Two impls behind one interface: node:dns on a Node host, DNS-over-HTTPS on
 * Workers (no raw DNS there). Both are best-effort and time-bounded — resolution
 * never blocks or fails a decision; an unresolved chain just means we classify
 * the literal host. NullResolver is the default (tests / when resolution is off).
 */
export interface CnameResolver {
  /** Canonical names `host` resolves to via its CNAME chain (excluding `host`
   *  itself), normalized (lowercased, no trailing dot). Best-effort; [] on error. */
  resolveChain(host: string): Promise<string[]>;
}

const MAX_DEPTH = 10;
const clean = (h: string) => h.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();

export class NullResolver implements CnameResolver {
  async resolveChain(): Promise<string[]> { return []; }
}

/** node:dns/promises. Follows the CNAME chain up to MAX_DEPTH with a visited set. */
export class NodeCnameResolver implements CnameResolver {
  async resolveChain(host: string): Promise<string[]> {
    let dns: typeof import("node:dns/promises");
    try { dns = await import("node:dns/promises"); } catch { return []; }
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = clean(host);
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      let next: string[];
      try { next = await dns.resolveCname(cur); } catch { break; } // NODATA/NXDOMAIN → chain ends
      const target = next[0] ? clean(next[0]) : "";
      if (!target || target === cur) break;
      out.push(target);
      cur = target;
    }
    return out;
  }
}

/** DNS-over-HTTPS (RFC 8484 JSON) for Workers / any fetch-only runtime. */
export class DohCnameResolver implements CnameResolver {
  constructor(private endpoint = "https://cloudflare-dns.com/dns-query", private timeoutMs = 1500) {}
  async resolveChain(host: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = clean(host);
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      let target = "";
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        const res = await fetch(`${this.endpoint}?name=${encodeURIComponent(cur)}&type=CNAME`,
          { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) break;
        const body = await res.json() as { Answer?: { type: number; data: string }[] };
        const ans = (body.Answer ?? []).find((a) => a.type === 5); // 5 = CNAME
        target = ans ? clean(ans.data) : "";
      } catch { break; }
      if (!target || target === cur) break;
      out.push(target);
      cur = target;
    }
    return out;
  }
}
