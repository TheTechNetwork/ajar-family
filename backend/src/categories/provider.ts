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
import { DEFAULT_CATEGORY_DOMAINS } from "@ajar/shared/categories";

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

  replace(map: Record<string, string[]>) {
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
