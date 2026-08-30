/**
 * Category lookup, behind an interface so the *source* of categorization is
 * swappable without touching the policy engine. The domain→category data is no
 * longer hardcoded into enforcement: it lives in the datastore, seeded from a
 * bundled list and replaceable from a maintained feed via the import path.
 *
 * `RepositoryCategoryProvider` is the default (data in our own store). A future
 * `ExternalCategoryProvider` can implement this same interface against a hosted
 * categorization feed/API (with caching) — the backend and every client stay
 * unchanged because they only depend on `CategoryProvider`.
 */
import type { Repository } from "../store/repository.js";
import {
  DEFAULT_CATEGORY_DOMAINS, normalizeHost, buildBloom, type CategoryFilterSet,
} from "@ajar/shared/categories";
import { isSafetyFloorHost } from "@ajar/shared/safety";

/**
 * Categories we refuse to classify automatically, ever.
 *
 * Filter vendors have a measured, documented history here: at maximum
 * restrictiveness they block ~50% of sexual-health sites to gain 4 points of
 * adult coverage (KFF / University of Michigan), and the ACLU documented vendors
 * shipping a dedicated LGBT category that blocked the Trevor Project while
 * leaving anti-LGBT sites reachable. For a product used by children, that is not
 * a tuning error — it is the mechanism by which a kid stops looking for help.
 *
 * So these are not "off by default": they cannot exist. Rejected at the dataset
 * API, absent from the taxonomy, and never offered to a classifier as an output
 * label. A parent who wants a specific site blocked can still block that site.
 */
export const FORBIDDEN_CATEGORY_SLUGS = new Set([
  "lgbt", "lgbtq", "lgbtqia", "gay", "trans", "transgender", "sexuality",
  "sexual-health", "sexualhealth", "reproductive-health", "abortion",
  "news", "politics", "political", "religion", "religious",
]);

/** Per-navigation spurious-block budget across ALL shipped filters. */
export const TARGET_AGGREGATE_FP = 0.001;
/** Host probes per navigation (registrable candidates) — see hostCandidates. */
const PROBES_PER_HOST = 3;

export interface CategoryProvider {
  /** Categories a single host belongs to (indexed lookup; hot path + console). */
  lookup(host: string): Promise<string[]>;
  /** category → domain[] for the given categories (all if omitted). Used to
   *  compile the set inlined into a signed device snapshot. */
  categoryMap(categories?: string[]): Promise<Record<string, string[]>>;
  /** Category slugs with their domain counts (console / ops visibility). */
  listCategories(): Promise<{ category: string; domainCount: number }[]>;
  /** Monotonic dataset version — bumps on every replace, for change detection. */
  version(): Promise<number>;
  /** Replace the whole dataset (feed import). Returns the new version. */
  replace(map: Record<string, string[]>): Promise<number>;
  /** Compile per-category Bloom filters — the compact asset devices download +
   *  cache instead of the domain lists (see @ajar/shared/categories bloom). */
  compileFilters(categories?: string[]): Promise<CategoryFilterSet>;
}

export class RepositoryCategoryProvider implements CategoryProvider {
  constructor(private repo: Repository) {}

  lookup(host: string) { return this.repo.categoriesForHost(host); }

  async categoryMap(categories?: string[]) {
    const rows = await this.repo.listCategoryDomains(categories);
    const map: Record<string, string[]> = {};
    for (const { category, domain } of rows) (map[category] ??= []).push(domain);
    return map;
  }

  listCategories() { return this.repo.categoryStats(); }
  version() { return this.repo.getCategoryDatasetVersion(); }

  async compileFilters(categories?: string[]): Promise<CategoryFilterSet> {
    const map = await this.categoryMap(categories);
    const names = Object.keys(map);

    // A Bloom false positive is a spurious BLOCK the child has to ask their way
    // out of, and the risk COMPOUNDS: every shipped category is tested against
    // every host candidate. At a naive p=0.001 with 12 categories that is ~3.5%
    // of navigations — one in 28 — which would read to a family as "this thing
    // blocks random websites". Budget the per-filter rate so the AGGREGATE
    // per-navigation rate stays at target instead. Costs ~34% more bytes for a
    // 10x better experience, and shipping fewer categories makes each tighter.
    const trials = Math.max(1, names.length * PROBES_PER_HOST);
    const perFilterFp = 1 - Math.pow(1 - TARGET_AGGREGATE_FP, 1 / trials);

    const filters: CategoryFilterSet["filters"] = {};
    for (const [category, domains] of Object.entries(map)) {
      const hosts = domains.map(normalizeHost);
      // A safety-floor host inside a category filter would let a false positive
      // block a crisis line — the exact ACLU failure. Refuse to build it.
      const leaked = hosts.filter(isSafetyFloorHost);
      if (leaked.length > 0) {
        throw new Error(
          `category "${category}" contains safety-floor hosts (${leaked.join(", ")}); ` +
          "a crisis resource must never be classifiable");
      }
      filters[category] = buildBloom(hosts, perFilterFp);
    }
    return { version: await this.version(), filters };
  }

  async replace(map: Record<string, string[]>) {
    // async so a refusal surfaces as a rejected promise, matching the
    // CategoryProvider contract, rather than throwing synchronously past callers
    // that only await.
    for (const category of Object.keys(map)) {
      if (FORBIDDEN_CATEGORY_SLUGS.has(category.toLowerCase().trim())) {
        throw new Error(
          `refusing category "${category}": identity, sexual-health, news, politics and ` +
          "religion are never auto-classified (see FORBIDDEN_CATEGORY_SLUGS)");
      }
    }
    const entries = Object.entries(map).flatMap(([category, domains]) =>
      domains.map((domain) => ({ category, domain })));
    return this.repo.replaceCategoryDomains(entries);
  }
}

/**
 * Load the bundled starter list into the store on first boot, so the seed is
 * DATA (swappable via import) rather than compiled-in enforcement. No-op once a
 * dataset exists, so an imported feed is never clobbered on restart.
 */
export async function seedCategoriesIfEmpty(provider: CategoryProvider): Promise<void> {
  const stats = await provider.listCategories();
  if (stats.length > 0) return;
  await provider.replace(DEFAULT_CATEGORY_DOMAINS);
}
