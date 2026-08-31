/**
 * CNAME chain following — one algorithm, reused by the backend resolver, the
 * browser extensions, and any future adapter. `resolveOne` returns the immediate
 * CNAME target of a name (or null when there is none); the platform supplies it
 * (node:dns, DNS-over-HTTPS, browser.dns). The chain is normalized, loop-guarded,
 * and depth-capped so a hostile or misconfigured DNS record can't spin us.
 */
export function normalizeDnsName(name: string): string {
  return (name || "").replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
}

export const DEFAULT_MAX_DEPTH = 10;

export async function followCnameChain(
  host: string,
  resolveOne: (name: string) => Promise<string | null>,
  opts: { maxDepth?: number } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = normalizeDnsName(host);
  if (!cur) return out;
  seen.add(cur);
  for (let i = 0; i < maxDepth; i++) {
    let next: string | null = null;
    try { next = await resolveOne(cur); } catch { break; } // NODATA/NXDOMAIN/error → chain ends
    const t = next ? normalizeDnsName(next) : "";
    if (!t || seen.has(t)) break; // no CNAME, self-reference, or a loop
    out.push(t);
    seen.add(t);
    cur = t;
  }
  return out;
}
