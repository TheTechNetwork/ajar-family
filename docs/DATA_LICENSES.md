# Data licences — where category data comes from, and what we owe for it

This is about **data**, not code. The repo's own licence does not cover the
domain-categorization corpus we compile filters from; that corpus has its own
terms, and some of them are viral.

## Decision: proceed on UT1's live licence (CC BY-SA 4.0)

**Status:** accepted, with a required follow-up before public launch.

The Université Toulouse Capitole blacklists are the backbone of the corpus
(millions of domains, most of the adult category). Their page presents a
conflict:

| Where | Licence |
|---|---|
| Live `rel="license"` link on the page | **CC BY-SA 4.0** |
| Commented-out legacy RDF block in the page source | CC BY-**NC**-SA 4.0 |

We proceed on the **live** licence — the one actually published and linked — and
treat the commented-out block as superseded. That is a reasonable reading, and it
is the decision on record.

**It is still a decision under uncertainty, so we hedge:**

1. Confirm with the maintainer (Fabrice Prigent) in writing **before** building
   ingestion at scale. This is one email and it retires the whole risk.
2. Until confirmed, do nothing the NC variant would forbid: we do not sell the
   dataset, sub-licence it as a product, or offer it as a standalone data feed.
   Ajar is a filtering product that consumes the data — not a data business.
3. Keep the corpus swappable. `CategoryProvider` already makes the source a
   configuration choice, so if the licence resolves to NC the adult category can
   be rebuilt from other sources without touching the engine. That is the
   architectural insurance policy; do not undermine it.

**If it resolves to NC**, the adult category must be rebuilt from scratch
(~10× cost, months of calendar time) or sourced elsewhere — and the research
established that most commercial feeds forbid our delivery model anyway. That is
why the email comes first.

## What CC BY-SA 4.0 actually obliges us to do

ShareAlike is the part that is easy to miss. It is not merely "give credit".

- **Attribution (BY).** Credit the source, link the licence, and note that we
  modified it.
- **ShareAlike (SA).** Compiling domains into a Bloom filter produces **adapted
  material**. Our filter set therefore inherits CC BY-SA 4.0: recipients may
  redistribute it, including modified, under the same terms. We cannot treat the
  shipped filter set as proprietary. This is accepted, not a problem — the
  product is the enforcement engine and the family experience, not the list.
- **It must travel with the artifact.** A notice that exists only in this file is
  lost the moment the asset is cached, mirrored, or inspected alone.

### How that is enforced in code, not prose

`CategoryFilterSet.attribution` (`shared/categories/bloom.ts`) carries the licence,
the source credits and a plain-language notice, and it is **inside the signed
set** — so it accompanies the adapted material everywhere the asset goes, and
stripping it is tamper-evident rather than free. The values live in
`shared/categories/attribution.ts`; a test asserts the shipped asset carries them.

## Other sources

| Source | Licence | Notes |
|---|---|---|
| The Blocklist Project | Unlicense (public domain) | No obligations. |
| Bundled seed in `category-data.ts` | Ours | Placeholder only; ~50 domains. |

## Standing rules

- **No source enters the corpus without an entry in this table**, checked against
  the licence text rather than a summary of it.
- **Anything non-commercial-only is disqualified**, full stop — this is a
  commercial product.
- **Re-verify every source's licence before public launch**, and record the date
  it was checked. Licences change; ours is already ambiguous once.

*This is engineering diligence, not legal advice. Have counsel review the corpus
and this file before public launch.*
