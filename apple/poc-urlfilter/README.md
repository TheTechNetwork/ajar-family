# PoC D scaffold — iOS/macOS `NEURLFilter` Bloom+PIR blocklist

On-device-runnable proof for `docs/APPLE_URL_FILTER_POC.md`. This is the
**SUPPLEMENTARY large-scale blocklist** layer (adult / malware / known-proxy /
category domains and specific bad videos) — it is **NOT** the per-video-approval
engine. Per-video approval is **PoC A** (`apple/poc-contentfilter/`,
`NEFilterDataProvider` + FamilyControls `.child`). `NEURLFilter` is blocklist-only
and cannot express "default-deny host X except URL Y" (ARCHITECTURE.md §3.1,
ADR-002).

**Cannot be built in the CI/Linux environment.** Open in **Xcode 26**, run on an
**iOS/iPadOS 26** device. The Python bloom builder under `tools/build-bloom/`
*does* run here (stdlib only).

## Prerequisites (on real hardware)

- Xcode 26; an iPhone/iPad on iOS/iPadOS 26 (mechanism is also macOS 26).
- NetworkExtension capability with the new **`url-filter-provider`** entitlement
  value on both the app and the extension.
- A reachable **PIR server** (see `pir-server/`). **Development-signed builds
  skip Apple's OHTTP relay**, so a plain dev PIR endpoint works immediately — no
  Identity & Trust validation needed until non-development distribution.
- No MDM, no supervision required to *load* the URL filter (TN3134 lists no
  supervision restriction for URL-filter providers). Whether `.child` is needed to
  *lock the Settings toggle* is an open item — see the doc.

## Layout (create in Xcode as one app + one app-extension)

```
URLFilterPoC.xcodeproj
├── App/                                (iOS/macOS app target — SwiftUI harness)
│   ├── URLFilterPoCApp.swift
│   ├── ContentView.swift               // status, URL verdict probe, PIR reset
│   ├── URLFilterController.swift        // NEURLFilterManager: setConfiguration,
│   │                                    //   shouldFailClosed=true, enable/save,
│   │                                    //   NEURLFilter.verdict(for:), resetPIRCache()
│   └── URLFilterPoC.entitlements        // networking.networkextension = url-filter-provider
├── URLFilterControlProviderExtension/  (App Extension — URL-filter control)
│   ├── URLFilterControlProvider.swift   // NEURLFilterControlProvider: fetchPrefilter()
│   │                                    //   returns NEURLFilterPrefilter from bundled blob
│   ├── URLFilterControlProviderExtension.entitlements
│   └── (Info.plist) EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control
├── tools/build-bloom/
│   └── build_bloom.py                   // offline Bloom + input.txtpb builder (runs in CI)
└── pir-server/                          // vendor PIR backend config + seed dataset (example)
    ├── README.md · service-config.json · url-config.json · data/input.txtpb
```

## How the scaffold maps to the doc

| Doc concern | Where |
|---|---|
| Build the on-device Bloom prefilter (FNV-1a + Murmur3, double hashing) | `tools/build-bloom/build_bloom.py` → `bloom.bin` + `bloom.meta.json` |
| Hand the prefilter to the system | `URLFilterControlProvider.fetchPrefilter(existingPrefilterTag:)` → `NEURLFilterPrefilter(...)` |
| Configure PIR + fail-closed + enable | `URLFilterController.configureAndEnable()` |
| ≥45-min Bloom propagation floor | `prefilterFetchInterval = 2700`; no push/force-reload |
| Faster PIR path | `URLFilterController.resetPIRCache()` + `refreshPIRParameters()` |
| Block one URL, allow another on same host by absence | dataset presence/absence (`pir-server/data/input.txtpb`) |
| Verdict probe (participation API) | `URLFilterController.testVerdict(for:)` → `NEURLFilter.verdict(for:)` |
| Vendor PIR backend | `pir-server/` (Apple `PIRProcessDatabase` + `PIRService`) |

## Build the Bloom dataset (works in CI)

```sh
python3 tools/build-bloom/build_bloom.py --selftest         # known-answer hash tests
python3 tools/build-bloom/build_bloom.py blocklist.txt \
    --p 0.001 --out-dir ./out
# → out/bloom.bin  (bundle into the extension)
#   out/bloom.meta.json  (bitCount/hashCount/murmurSeed/tag — the extension reads these)
#   out/input.txtpb  (feed to PIRProcessDatabase; see pir-server/)
```

The Bloom builder and the on-device matcher must agree on `bitCount`,
`hashCount`, `murmurSeed`, bit packing, **and URL canonicalization** — the last is
an unresolved item flagged in the doc and in `build_bloom.py`.

## What to measure

Follow `docs/APPLE_URL_FILTER_POC.md` and fill its **Observed Results** table and
**Key unresolved** list; record outcomes in `docs/DECISIONS.md` ADR-002.
