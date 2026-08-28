/**
 * Host → candidate registrable-domain list for category lookups. A stored
 * category domain `d` matches host `h` exactly when `d` is one of `h`'s
 * candidates (i.e. `h === d` or `h` ends with `.d`). Returning the finite
 * candidate list lets the SQL store resolve a host with a single indexed
 * `WHERE domain IN (...)` query instead of scanning the dataset — the piece
 * that makes the lookup scale past a hardcoded list.
 */
export function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

export function hostCandidates(host: string): string[] {
  const h = normalizeHost(host);
  if (!h) return [];
  const parts = h.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out; // e.g. "m.old.reddit.com" → [m.old.reddit.com, old.reddit.com, reddit.com, com]
}
