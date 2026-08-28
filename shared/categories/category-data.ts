/**
 * Category → domain seed for CATEGORY policy rules. This is the lever that makes
 * the product general: "block all social media" (or adult / gaming / …) is ONE
 * rule whose action applies to every domain in the category, with narrower tiers
 * (URL / DOMAIN / YOUTUBE_*) still able to carve out exceptions above it.
 *
 * The map travels inside the signed DevicePolicySnapshot, so every platform's
 * evaluator enforces it offline and adding a site is a data-only change (no code
 * on any client). This bundled list is a STARTER SEED — a production deployment
 * swaps in a maintained categorization feed (millions of domains; on Apple that
 * is the NEURLFilter Bloom/PIR path, see docs/ARCHITECTURE.md). Domains are
 * registrable roots; matching also covers subdomains.
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

/** Categories whose domain set contains `host` (host already lowercased, no
 *  leading `www.`). Matches the registrable root and any subdomain. */
export function categoriesForHost(
  categories: Record<string, string[]> | undefined,
  host: string,
): Set<string> {
  const out = new Set<string>();
  if (!categories || !host) return out;
  for (const [cat, domains] of Object.entries(categories)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) out.add(cat);
  }
  return out;
}
