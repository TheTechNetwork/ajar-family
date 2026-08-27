# PIR server — NEURLFilter blocklist backend (PoC D)

> **Example only, not production.** This is the vendor-hosted half of the
> `NEURLFilter` Bloom+PIR blocklist: an on-device Bloom prefilter clears URLs
> that are definitely not blocked (no network); a Bloom **hit** triggers a
> **Private Information Retrieval (PIR)** query against this server, tunneled
> through Apple's Oblivious HTTP relay so neither Apple nor the vendor sees the
> URL or client IP. See `docs/APPLE_URL_FILTER_POC.md` and `ARCHITECTURE.md §3.1`.
>
> This directory holds the **config + seed dataset**. It does **not** vendor the
> Apple tools — you build/run them from the two Apple repos below. Nothing here
> can be built or run in the CI/Linux environment against a real device; it is a
> reference so a human can stand the server up.

## The two Apple repos (Apache-2.0)

- **`apple/swift-homomorphic-encryption`** — provides `PIRProcessDatabase`, which
  turns `data/input.txtpb` (a Keyword-PIR database) into a sharded PIR database +
  PIR parameters. <https://github.com/apple/swift-homomorphic-encryption>
- **`apple/pir-service-example`** — provides `PIRService` (the HTTP server) and a
  Privacy Pass issuer. <https://github.com/apple/pir-service-example>

Same stack Apple uses for Live Caller ID Lookup.

## Files here

| File | Role |
|---|---|
| `data/input.txtpb` | Seed Keyword-PIR database. Blocklist-only (`value: "1"`). Blocks `youtube.com/watch?v=9bZkp7q19f0`; deliberately omits `…v=dQw4w9WgXcQ` (allowed by absence) + one malware placeholder. |
| `url-config.json` | `PIRProcessDatabase` config (RLWE params, sharding, keyword DB). |
| `service-config.json` | `PIRService` config: users/tokens + the use case whose `name` = `<app bundle id>.url.filtering`. |

The dataset can instead be generated from a URL list with
`../tools/build-bloom/build_bloom.py`, which emits an identical `input.txtpb`
(and the matching Bloom blob + tag the control provider bundles).

## Commands (run on a machine with the Apple toolchain, not in CI)

```sh
# 1. Process the keyword database into a sharded PIR database + parameters.
#    (from a checkout of apple/swift-homomorphic-encryption)
swift run PIRProcessDatabase path/to/url-config.json

#    Produces, per url-config.json:
#      data/url-0.bin              (shard 0 database; SHARD_ID expands per shard)
#      data/url-0.params.txtpb     (PIR parameters for shard 0)

# 2. Serve it with PIRService + Privacy Pass issuer.
#    (from a checkout of apple/pir-service-example)
swift run PIRService \
  --service-config path/to/service-config.json \
  --hostname 0.0.0.0 --port 8443
```

Point the app's `NEURLFilterManager.setConfiguration(pirServerURL:…)` at this
server (and `pirPrivacyPassIssuerURL:` at the issuer). See
`../App/URLFilterController.swift`.

## OHTTP relay vs. development

- **Production**: the vendor runs an **OHTTP gateway** (HTTP/2, RFC 9458 binary
  key config) in front of `PIRService` and a **PIR server**; Apple runs the OHTTP
  **relay**. Onboarding is via **CloudKit Console → Identity & Trust**, which
  validates the relay/PIR endpoints before any non-development distribution.
- **Development**: **development-signed builds skip the relay**, so a directly
  reachable dev `PIRService` endpoint is enough to test the mechanism on a device
  immediately (`ARCHITECTURE.md §3.1`).

## PoC caveats (see the doc's "Key unresolved")

- **Keyword canonical form** must match the on-device enumerator's sub-URL keys
  or the Bloom hit never leads to a matching PIR row. Unresolved; verify on
  device and adjust `build_bloom.py` + this dataset together.
- **PIR operational cost** (per-query CPU/bandwidth, server sizing, refresh
  cadence) is unmeasured — a Phase-0 open item, deliberately not over-invested
  (ADR-002).
