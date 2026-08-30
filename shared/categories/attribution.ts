/**
 * Where the categorization data comes from, and what that obliges us to do.
 *
 * DECISION (recorded in docs/DATA_LICENSES.md): proceed on the licence UT1
 * publishes LIVE — CC BY-SA 4.0. Their page also contains a commented-out legacy
 * RDF block naming CC BY-NC-SA 4.0. That ambiguity is unresolved and sits under
 * the large majority of the corpus, so it must be settled with the maintainer
 * before public launch; until then we comply with the stricter *obligations* of
 * the live licence and avoid anything the NC variant would forbid (we do not
 * sell the dataset or licence it onward as a product).
 *
 * WHY THIS IS CODE AND NOT A DOC. CC BY-SA is not just credit: it is ShareAlike.
 * Compiling domains into a Bloom filter produces adapted material, so the asset
 * we serve inherits the licence, and the attribution has to travel with it.
 * Anyone who receives the filter set may redistribute it under the same terms —
 * that is a deliberate, accepted consequence of using this source.
 */
import type { DatasetAttribution } from "./bloom.js";

export const CATEGORY_DATA_ATTRIBUTION: DatasetAttribution = {
  license: "CC-BY-SA-4.0",
  sources: [
    {
      name: "Université Toulouse Capitole — blacklists (UT1)",
      url: "https://dsi.ut-capitole.fr/blacklists/",
      license: "CC-BY-SA-4.0",
    },
    {
      name: "The Blocklist Project",
      url: "https://github.com/blocklistproject/Lists",
      license: "Unlicense",
    },
  ],
  notice:
    "Category membership is compiled from third-party datasets. This filter set is " +
    "adapted material offered under CC BY-SA 4.0: you may redistribute it, including " +
    "modified, provided you credit the sources above and license your version alike. " +
    "It is a probabilistic filter — membership answers may be false positives — and it " +
    "is not a statement about any site beyond the stated category.",
};
