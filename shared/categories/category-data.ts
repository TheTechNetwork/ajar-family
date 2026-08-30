/**
 * Category → domain STARTER SEED for CATEGORY policy rules. This is the lever
 * that makes the product general: "block all social media" (or adult / gaming /
 * …) is ONE rule whose action applies to every domain in the category, with
 * narrower tiers (URL / DOMAIN / YOUTUBE_*) still able to carve out exceptions.
 *
 * IMPORTANT: this list is NOT the categorization system — it is only the initial
 * seed the backend loads into its datastore on first boot. The live source of
 * truth is the store, queried through a `CategoryProvider` (see
 * `backend/src/categories/provider.ts`) and replaceable from a maintained feed
 * via `PUT /v1/categories/dataset` with no code change. The backend inlines only
 * the categories a given policy enforces into the signed DevicePolicySnapshot,
 * so every platform's evaluator still enforces offline. Domains are registrable
 * roots; matching also covers subdomains. Scaling to millions of domains is the
 * provider's job (indexed lookup today; a hosted feed / Apple NEURLFilter
 * Bloom/PIR path next — see docs/ARCHITECTURE.md).
 */
export const DEFAULT_CATEGORY_DOMAINS: Record<string, string[]> = {
  social: [
    "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
    "reddit.com", "snapchat.com", "threads.net", "pinterest.com", "tumblr.com",
    "linkedin.com", "bsky.app", "mastodon.social", "vk.com", "weibo.com",
  ],
  messaging: ["discord.com", "whatsapp.com", "telegram.org", "messenger.com", "kik.com"],
  adult: ["pornhub.com", "xvideos.com", "xnxx.com", "onlyfans.com", "redtube.com"],
  gambling: ["bet365.com", "draftkings.com", "fanduel.com", "stake.com"],
  gaming: ["roblox.com", "epicgames.com", "steampowered.com", "miniclip.com", "poki.com", "crazygames.com"],
  streaming: ["netflix.com", "hulu.com", "twitch.tv", "disneyplus.com", "max.com"],
  shopping: ["amazon.com", "ebay.com", "temu.com", "shein.com", "aliexpress.com"],
};

/** Lowercase a host and drop a leading `www.` (the canonical form domains are
 *  stored and compared in). */
export function normalizeHost(host: string): string {
  // The trailing root dot is legal in a URL ("reddit.com.") and resolves to the
  // same site, so it MUST be stripped or one character defeats every DOMAIN and
  // CATEGORY rule. Also drop a leading "www.".
  return host.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
}

/**
 * A host's registrable-domain candidates: the finite set of suffixes a stored
 * category domain could equal. `d` matches host `h` iff `d` is one of these —
 * i.e. `h === d` or `h` ends with `.d`. Returning the finite list is what lets
 * both the SQL store (`WHERE domain IN (...)`) and the Bloom filter resolve a
 * host with O(labels) exact probes instead of scanning the dataset.
 */
export function hostCandidates(host: string): string[] {
  const h = normalizeHost(host);
  if (!h) return [];
  const parts = h.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out; // "m.old.reddit.com" → [m.old.reddit.com, old.reddit.com, reddit.com, com]
}

/** Categories whose domain set contains `host` (host already lowercased, no
 *  leading `www.`). Matches the registrable root and any subdomain. This is the
 *  small-deployment / inline-map path; large datasets use Bloom filters
 *  (see `./bloom`). */
export function categoriesForHost(
  categories: Record<string, string[]> | undefined,
  host: string,
): Set<string> {
  const out = new Set<string>();
  if (!categories || !host) return out;
  const cands = new Set(hostCandidates(host));
  for (const [cat, domains] of Object.entries(categories)) {
    if (domains.some((d) => cands.has(normalizeHost(d)))) out.add(cat);
  }
  return out;
}
