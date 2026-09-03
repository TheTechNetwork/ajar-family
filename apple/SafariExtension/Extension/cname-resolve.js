/**
 * On-device CNAME resolver for the extension. CNAME cloaking (a first-party
 * subdomain CNAME'd onto a blocked target) bypasses DOMAIN/CATEGORY blocks if we
 * only look at the literal host, so we resolve the chain and hand the canonical
 * names to evaluate() as ctx.resolvedHosts.
 *
 * The blocking webRequest listener is SYNCHRONOUS and Chrome has no DNS API, so
 * resolution is async + cached: prime(host) resolves in the background (on
 * navigation and on first sighting), chainFor(host) returns the cached chain the
 * sync listener reads. Coverage is therefore effective from the first cached
 * result onward; the very first hit to a brand-new host may miss until primed —
 * the companion network-layer enforcer closes that residual window.
 *
 * Resolution source, in order: a browser DNS API when present (Firefox
 * `browser.dns.resolve` → canonical name, uses the system resolver, no third
 * party), else DNS-over-HTTPS (works on Chrome/Edge/Safari). DoH sends the
 * hostname to the DoH provider — the browser is about to resolve it anyway, but
 * it is a real third-party exposure, so the endpoint is configurable and can be
 * turned off. Best-effort throughout: any failure yields an empty chain and the
 * literal host is still enforced.
 */

const MAX_DEPTH = 10;
const norm = (n) => (n || "").replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();

export class CnameResolver {
  /**
   * @param {object} o
   * @param {(host:string)=>Promise<string[]>} [o.browserDnsCanonical] resolves final canonical name(s)
   * @param {string|null} [o.dohEndpoint] DoH JSON endpoint (null disables DoH)
   * @param {number} [o.ttlMs]
   * @param {number} [o.negTtlMs] cache TTL for empty results (avoid re-querying every hit)
   */
  constructor({ browserDnsCanonical = null, dohEndpoint = "https://cloudflare-dns.com/dns-query",
                ttlMs = 10 * 60 * 1000, negTtlMs = 60 * 1000, maxDepth = MAX_DEPTH } = {}) {
    this._bd = browserDnsCanonical;
    this._doh = dohEndpoint;
    this._ttl = ttlMs;
    this._negTtl = negTtlMs;
    this._max = maxDepth;
    this._cache = new Map();     // host -> { chain, exp }
    this._inflight = new Map();  // host -> Promise<chain>
  }

  /** Synchronous: the cached chain for `host`, or [] if not yet resolved/expired. */
  chainFor(host) {
    const e = this._cache.get(norm(host));
    return e && e.exp > Date.now() ? e.chain : [];
  }

  /** Async: resolve + cache `host`'s chain (deduped while in flight). */
  prime(host) {
    const h = norm(host);
    if (!h) return Promise.resolve([]);
    const e = this._cache.get(h);
    if (e && e.exp > Date.now()) return Promise.resolve(e.chain);
    if (this._inflight.has(h)) return this._inflight.get(h);
    const p = this._resolve(h)
      .then((chain) => {
        this._cache.set(h, { chain, exp: Date.now() + (chain.length ? this._ttl : this._negTtl) });
        this._inflight.delete(h);
        return chain;
      })
      .catch(() => { this._inflight.delete(h); return []; });
    this._inflight.set(h, p);
    return p;
  }

  async _resolve(h) {
    if (this._bd) {
      try {
        const canon = await this._bd(h);
        return (canon || []).map(norm).filter((c) => c && c !== h);
      } catch { /* fall back to DoH */ }
    }
    return this._doh ? this._followDoh(h) : [];
  }

  async _followDoh(host) {
    const out = [];
    const seen = new Set([host]);
    let cur = host;
    for (let i = 0; i < this._max; i++) {
      let next = null;
      try {
        const res = await fetch(`${this._doh}?name=${encodeURIComponent(cur)}&type=CNAME`,
          { headers: { accept: "application/dns-json" } });
        if (!res.ok) break;
        const body = await res.json();
        const ans = (body.Answer || []).find((a) => a.type === 5); // 5 = CNAME
        next = ans ? norm(ans.data) : null;
      } catch { break; }
      if (!next || seen.has(next)) break;
      out.push(next);
      seen.add(next);
      cur = next;
    }
    return out;
  }
}

/** Wire a resolver to whatever DNS facility this browser exposes. */
export function makeResolver(opts = {}) {
  const dnsApi = (typeof browser !== "undefined" && browser.dns) ||
                 (typeof chrome !== "undefined" && chrome.dns) || null;
  const browserDnsCanonical = dnsApi
    ? async (host) => {
        const r = await dnsApi.resolve(host, ["canonical_name"]);
        return r && r.canonicalName ? [r.canonicalName] : [];
      }
    : null;
  return new CnameResolver({ browserDnsCanonical, ...opts });
}
