# PoC D — Apple `NEURLFilter` Bloom + PIR blocklist (SUPPLEMENTARY)

> This is a **supplementary** Phase-0 proof. It validates the **large-scale
> blocklist** layer from `ARCHITECTURE.md §3.1` / ADR-002: a privacy-preserving,
> on-device **Bloom prefilter** backed by vendor-hosted **PIR** that can block
> adult / malware / known-proxy / category URLs (and specific bad videos) at
> scale, system-wide across WebKit + URLSession, with neither Apple nor the
> vendor learning what was browsed.
>
> **`NEURLFilter` is NOT the per-video-approval engine.** It is **blocklist-only**
> — the dataset means "block these", every value is the placeholder `1`, there is
> no author-able allow verdict, no exceptions, no per-rule priority, one dataset
> per app. "Default-deny host X **except** URL Y" is **not expressible.** The
> per-video allow-one workflow (§0 of `ARCHITECTURE.md`) is **PoC A**
> (`docs/APPLE_CONTENT_FILTER_POC.md`, `NEFilterDataProvider` + FamilyControls
> `.child`). Do not conflate the two, and do not over-invest PIR/OHTTP here
> (ADR-002).
>
> **This environment (Linux, no Xcode, no Apple SDK, no iOS 26 hardware) cannot
> compile or run the Swift or exercise a device.** The scaffold under
> `apple/poc-urlfilter/` is written to be opened in **Xcode 26** and run on real
> iOS/iPadOS/macOS **26** hardware by a human, who records results in the
> **Observed Results** table below and in `docs/DECISIONS.md` (ADR-002). The
> Python Bloom builder (`apple/poc-urlfilter/tools/build-bloom/build_bloom.py`)
> *does* run in this environment and its hashes are self-tested against known
> vectors.

## Goals

1. **Block one exact URL.** With `youtube.com/watch?v=9bZkp7q19f0` present in the
   blocklist dataset, that URL is denied in Safari and to `URLSession`.
2. **Allow another URL on the same host by ABSENCE.** With
   `youtube.com/watch?v=dQw4w9WgXcQ` **absent** from the dataset, it loads
   normally — proving same-host discrimination comes purely from dataset
   membership, since there is no allow verdict to author. (This is the *only*
   "allow" `NEURLFilter` has: not being in the set.)
3. **Measure propagation: Bloom floor vs. PIR fast path.** Confirm the on-device
   **Bloom prefilter** cannot refresh faster than the **2700 s (45 min)** floor
   (default 86400 s, no push/force-reload), and contrast it with the faster
   **PIR** path (`resetPIRCache()` + `refreshPIRParameters()` + server hot-reload),
   which changes verdicts sooner — **but only when the app runs to call it**;
   there is no server→device trigger.
4. **Exercise the Bloom-only-ancestor trick.** Deliberately seed the Bloom filter
   with a coarse **ancestor** key (e.g. the bare host `youtube.com`) so that
   *every* URL under that host produces a Bloom **hit** and therefore always
   escalates to a **PIR** lookup, while the PIR database holds only the exact
   URLs to block. This decouples the two layers: the Bloom answers "consult the
   server for anything on this host", and the fast-updating PIR database answers
   "is this exact URL blocked?" — buying near-PIR-speed updates for hosts you
   watch, at the cost of a PIR round-trip on every request to those hosts.
5. **Resolve the supervision contradiction.** Determine empirically whether a
   URL-filter provider requires a **supervised** device or works unsupervised
   (the sources disagree — see "Key unresolved").
6. **Pin the iOS-27 dataset-key shape.** Determine the exact dataset key shape
   `ParsingConfiguration.QueryOptions(parameters: ["v"])` expects on iOS 27, so
   the Bloom builder emits keys the device will actually match for `v=`-only
   query filtering.

## Background the PoC assumes (from research; do not re-derive)

- **Types**: `NEURLFilterManager` (app-side control singleton, `.shared`);
  `NEURLFilterControlProvider` protocol (implemented in an **app extension** on
  both iOS and macOS — never a system extension) with
  `func fetchPrefilter(existingPrefilterTag: String?) async throws -> NEURLFilterPrefilter?`,
  `func start() async throws`, `func stop(reason:) async throws`;
  `NEURLFilterPrefilter(data:tag:bitCount:hashCount:murmurSeed:)` (the Bloom blob);
  `NEURLFilter.verdict(for: URL) async -> NEURLFilter.Verdict` (`.allow`/`.deny`/
  `.unknown`) — the "participation API" for non-WebKit/URLSession apps.
- **Configuration**: `NEURLFilterManager.setConfiguration(pirServerURL:
  pirPrivacyPassIssuerURL: pirAuthenticationToken:
  controlProviderBundleIdentifier:)`; `shouldFailClosed` (default **false** /
  fail-open; set **true** for parental control); `prefilterFetchInterval`
  (default 86400 s, **min 2700 s**); `resetPIRCache()` / `refreshPIRParameters()`.
- **Entitlement**: existing `com.apple.developer.networking.networkextension`
  with the new value **`url-filter-provider`**; extension Info.plist
  `EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control`;
  iOS/macOS **26.0**.
  <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension>
- **How it decides** (WWDC25 session 234,
  <https://developer.apple.com/videos/play/wwdc2025/234/>): on-device **Bloom
  filter** clears URLs not in the set (no network); on a Bloom **hit**, a **PIR**
  query to *your* vendor PIR server, tunneled through **Apple's Oblivious HTTP
  relay** so neither Apple nor you sees the URL or client IP. URL requests are
  expanded by **sub-URL enumeration** (~48 keys: domain hierarchy × path
  hierarchy × trailing slash × `:443` × fragment) and each is matched.
- **Bloom construction**: `FNV-1a 32-bit` (h1) + `MurmurHash3 x86_32` (h2, seeded
  with `murmurSeed`), **double hashing** `hashes[i] = (h1 + i*h2) mod bitCount`;
  `bitCount = ceil(-n*ln(p)/(ln2)^2)`; `hashCount = round((bitCount/n)*ln2)`.
  Dataset URLs are **Punycoded, scheme stripped**. Implemented and self-tested in
  `build_bloom.py`.
- **Reference server stack** (Apache-2.0): `apple/swift-homomorphic-encryption`
  (`PIRProcessDatabase`) + `apple/pir-service-example` (`PIRService` + Privacy
  Pass). Use case name = `<app bundle id>.url.filtering`. Vendor runs an **OHTTP
  gateway** (HTTP/2, RFC 9458 binary key config) + PIR server; **Apple runs the
  OHTTP relay**; onboarding via **CloudKit Console → Identity & Trust**.
  **Dev-signed builds skip the relay.**
- **Docs**: <https://developer.apple.com/documentation/networkextension/url-filters>,
  <https://developer.apple.com/documentation/networkextension/neurlfiltermanager>,
  sample <https://developer.apple.com/documentation/networkextension/filtering-traffic-by-url>,
  Apple Platform Deployment "Filter content"
  <https://support.apple.com/guide/deployment/filter-content-dep1129ff8d2/web>,
  TN3134 <https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment>.

## Prerequisites (on real hardware)

- Xcode 26; a device on iOS/iPadOS/macOS **26**.
- App + app-extension both signed with the `url-filter-provider` entitlement.
- A reachable dev **PIR server** (`apple/poc-urlfilter/pir-server/`). Dev-signed
  builds skip Apple's OHTTP relay, so no Identity & Trust validation is needed to
  test the mechanism.
- No MDM assumed. **Whether supervision is required is exactly what D5 tests.**

## Experiment matrix

Two canonical PoC URLs (mirror PoC A's ids, opposite roles here):
- **BLOCKED_URL** = `https://www.youtube.com/watch?v=9bZkp7q19f0` — present in the
  dataset.
- **ALLOWED_URL** = `https://www.youtube.com/watch?v=dQw4w9WgXcQ` — **absent** from
  the dataset (allowed by absence).

Build the dataset with `build_bloom.py` (emits `bloom.bin` + `bloom.meta.json`
for the extension and `input.txtpb` for the PIR DB), then run `PIRProcessDatabase`
+ `PIRService` per `pir-server/README.md`.

### D1 — Block one exact URL
Enable the filter (fail-closed). In Safari open **BLOCKED_URL** → expect the load
to **fail/deny**. Also probe it from the harness via `NEURLFilter.verdict(for:)`
→ expect **`.deny`**. (`NEURLFilter` has **no block page / remediation API**, and
by privacy design the app is **never told what was blocked** — so the failure is
a bare load failure, not a Request-Access page. That UX is PoC A.)

### D2 — Allow another URL on the same host by absence
In Safari open **ALLOWED_URL** → expect it **loads**. Probe via
`verdict(for:)` → expect **`.allow`** (or `.unknown` → allowed under fail-open;
note which). Confirms same-host discrimination is purely dataset membership.

### D3 — Query-string precision + iOS-27 key shape
On **iOS 26**, open BLOCKED_URL with extra params
(`…watch?v=9bZkp7q19f0&t=30s&pp=abc`, which YouTube always adds). Record whether
it still blocks. Expectation (research): iOS 26 treats the whole query as one
unit, so an exact `?v=…`-only dataset entry will **miss** a real navigation with
extra params. On **iOS 27 (beta)**, set the provider's
`ParsingConfiguration.QueryOptions(parameters: ["v"])` and rebuild the dataset so
keys carry only the `v` parameter; record the **exact key shape** that matches
(e.g. `www.youtube.com/watch?v=9bZkp7q19f0` vs. some normalized form) and feed it
back into `build_bloom.py`'s `canonicalize_url()`.

### D4 — Bloom propagation floor vs. PIR fast path
1. **Bloom floor**: change the dataset (add a new blocked URL), rebuild the
   prefilter, and measure how long until the device honors it with **no app
   intervention**. Expect ≥ `prefilterFetchInterval` (floor 2700 s / 45 min); no
   push/force-reload exists for the prefilter.
2. **PIR fast path**: with the Bloom-only-ancestor trick in place (D6), change the
   **PIR database** server-side (hot-reload), then call `resetPIRCache()` +
   `refreshPIRParameters()` from the running app and measure time-to-effect.
   Record both numbers.

### D5 — Supervision requirement (resolve the contradiction)
On an **unsupervised** consumer device, attempt to enable the URL-filter provider
(`isEnabled = true; saveToPreferences()`). Record whether it succeeds or is
rejected as supervised-only. Repeat on a **supervised** device for contrast.
Separately, with the filter enabled, check whether the child can **toggle it off**
in Settings, and whether FamilyControls `.child` (if added) **locks** that toggle.
(See "Key unresolved" — TN3134/WWDC25 vs. the Apple Platform Deployment guide
disagree.)

### D6 — Bloom-only-ancestor trick (force PIR lookups)
Seed the Bloom filter with a coarse **ancestor** key (bare host `youtube.com`,
built into `bloom.bin` but **not** necessarily in the PIR DB), so every request to
that host is a Bloom hit and always escalates to PIR. Keep the PIR database
holding only exact blocked URLs. Confirm: (a) ALLOWED_URL still loads (PIR returns
no match → allow), (b) BLOCKED_URL is denied via PIR, (c) a PIR-side change now
propagates on the D4.2 fast-path timescale rather than the 45-min Bloom floor.
Record the per-request latency cost of always hitting PIR for that host.

### D7 — Coverage + fail mode
Confirm WebKit (Safari) and `URLSession` are filtered automatically. Note that a
non-WebKit browser (Chrome/Firefox on macOS, own socket stack) is **not** filtered
unless it voluntarily calls `NEURLFilter.verdict(for:)` — record whether any
shipping build does. Then kill connectivity to the PIR server and, with
`shouldFailClosed = true`, confirm a **Bloom-hit cache-miss denies** (fail-closed);
with it false, confirm it allows (fail-open).

## Observed Results (fill on hardware)

| Test | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| D1 BLOCKED_URL denied (Safari) | Load fails | | | no block page by design |
| D1 `verdict(for:)` on BLOCKED_URL | `.deny` | | | |
| D2 ALLOWED_URL loads (absence) | Loads | | | |
| D2 `verdict(for:)` on ALLOWED_URL | `.allow`/`.unknown` | | | which? |
| D3 iOS 26 block with extra params | (likely miss) | | | whole-query unit |
| D3 iOS 27 `QueryOptions(["v"])` key shape | Matches `v=`-only | | | **record exact key** |
| D4.1 Bloom-only propagation | ≥ 2700 s | | | ___ s |
| D4.2 PIR reset propagation | seconds–minutes | | | ___ s |
| D5 enable on UNSUPERVISED device | ? | | | **key unknown** |
| D5 enable on supervised device | Succeeds | | | |
| D5 child can toggle filter off in Settings | ? | | | **key unknown** |
| D5 `.child` locks the toggle | ? | | | **key unknown** |
| D6 ancestor trick forces PIR | PIR consulted | | | latency ___ ms |
| D7 WebKit + URLSession filtered | Yes | | | |
| D7 non-WebKit browser filtered | No (unless opts in) | | | |
| D7 fail-closed on PIR unreachable | Deny | | | |

## Key unresolved

1. **Does FamilyControls `.child` lock the URL-filter Settings toggle?** For PoC A
   the `.child` posture blocks app-deletion and iCloud sign-out; it is unknown
   whether it also prevents a child from disabling the *URL filter* in Settings.
   If it does not, the blocklist is trivially removable and only useful layered
   under the PoC A content filter. (D5.)
2. **Supervision requirement — the sources contradict.** TN3134 / WWDC25 session
   234 imply a URL-filter provider is enableable without supervision (no
   supervision restriction listed), but the **Apple Platform Deployment** "Filter
   content" guide frames URL filtering under supervised/managed contexts. This
   must be resolved on hardware (D5): if supervision is required, `NEURLFilter` is
   **not** a consumer-unsupervised mechanism and drops to MDM-only scope.
   - TN3134: <https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment>
   - Deployment guide: <https://support.apple.com/guide/deployment/filter-content-dep1129ff8d2/web>
3. **Chromium/Firefox participation via `NEURLFilter.verdict(for:)`.** Non-WebKit
   browsers use their own socket stacks and are unfiltered unless they call the
   participation API. No evidence Chromium/Mozilla have adopted it; confirm (D7).
   Until then, the blocklist covers Safari + URLSession only on macOS.
4. **Realistic propagation.** The 45-min Bloom floor is a documented minimum; the
   *actual* observed refresh cadence (and whether the PIR fast path is truly
   seconds) is unmeasured (D4). Standing category blocklist changes ride the Bloom
   rebuild; time-critical changes must not depend on this layer (ARCHITECTURE.md
   §8).
5. **PIR operational cost.** Per-query CPU/bandwidth, server sizing, OHTTP gateway
   operation, Privacy Pass issuance load, and the extra cost of the D6
   ancestor-trick (a PIR round-trip on *every* request to a watched host) are
   unmeasured. Deliberately not over-invested in Phase 0 (ADR-002).
6. **Exact URL canonicalization / sub-URL enumeration.** The device expands each
   request into ~48 sub-URL keys; the Bloom builder and PIR dataset must emit keys
   in the identical canonical form or a Bloom hit never lands on a matching PIR
   row. `build_bloom.py` implements a conservative scheme-stripped + Punycoded
   form and flags this as open; reconcile against observed device keys (D3/D6).

## Success criterion

PoC D "passes" (as a supplementary layer) when, on the target posture determined
in D5: BLOCKED_URL is denied and ALLOWED_URL loads purely by dataset
membership (D1/D2); the propagation floor vs. PIR fast path are both measured
(D4); and the supervision/toggle-lock questions (D5) are answered well enough to
decide whether `NEURLFilter` is a consumer-unsupervised layer or an MDM-only one.
Record the numbers and the D5 verdict in `docs/DECISIONS.md` **ADR-002**. Nothing
here changes the primary conclusion that per-video approval is **PoC A**, not this
layer (ADR-001).

## Scaffold map

`apple/poc-urlfilter/` — see its `README.md`:
- `App/` — SwiftUI harness: `NEURLFilterManager.setConfiguration(...)`,
  `shouldFailClosed = true`, enable/save, a URL field driving
  `NEURLFilter.verdict(for:)`, and a `resetPIRCache()` button.
- `URLFilterControlProviderExtension/` — `NEURLFilterControlProvider`:
  `fetchPrefilter(existingPrefilterTag:)` returns an `NEURLFilterPrefilter` built
  from the bundled `bloom.bin` + `bloom.meta.json`.
- `tools/build-bloom/build_bloom.py` — dependency-free Bloom + `input.txtpb`
  builder implementing Apple's exact hash spec, self-tested against known vectors.
- `pir-server/` — vendor PIR backend config + seed dataset (example only) for
  `PIRProcessDatabase` + `PIRService`.
- Entitlements (`url-filter-provider`) for app + extension.
