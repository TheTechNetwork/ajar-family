# PoC A scaffold — iOS content filter + FamilyControls `.child`

On-device-runnable proof for `docs/APPLE_CONTENT_FILTER_POC.md`.

> **Status of this pass.** The `Shared/` policy engine was substantially extended
> to close audit findings 1–5 (CATEGORY rules, snapshot signature verification,
> the Bloom querier, the safety floor, CNAME chains). **None of that new code has
> been compiled or run** — it was written in a Linux container with no macOS, no
> Xcode, and no Swift toolchain. The "BUILD SUCCEEDED" note below refers to the
> *previous* state of the tree and no longer applies. Treat every Swift file
> under `Shared/` as unverified until a Mac engineer works through
> [What a Mac engineer must verify first](#what-a-mac-engineer-must-verify-first).

## Build

The Xcode project is generated from `project.yml` — it is not checked in.

```sh
brew install xcodegen
cd apple/poc-contentfilter
xcodegen generate

# compile/link check — needs no signing identity, no device
xcodebuild -project ParentFilterPoC.xcodeproj -scheme ParentFilterPoC \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO clean build

# real device build — needs an Apple Developer team whose profile carries
# com.apple.developer.family-controls and content-filter-provider
xcodebuild -project ParentFilterPoC.xcodeproj -scheme ParentFilterPoC \
  -destination 'generic/platform=iOS' DEVELOPMENT_TEAM=<TEAMID> build
```

Verified 2026-08-27 **on the previous revision** of this tree: BUILD SUCCEEDED,
arm64, 0 warnings, Xcode 27.0 (iPhoneOS 27.0 SDK), deployment target iOS 26.0.
That result does **not** cover the files added or rewritten since. Running the
PoC still requires an **iOS 26 device** signed in with a child Apple ID in a
Family Sharing group — the Simulator cannot run content filters or FamilyControls
`.child`. Tests A1–A6 have **not** been executed; see ADR-012.

Three SDK corrections were applied to the original scaffold (ADR-011):
`remediateVerdict(withRemediationURLMapKey:…)`, `remediationMap` values must be
`NSObject` (bridge with `as NSString`), and `handleReport(_:)` → `handle(_:)`.

## Targets (XcodeGen: one app + two extensions; `Shared/` is compiled into each)

```
ParentFilterPoC.xcodeproj          (generated — see project.yml)
├── App/                      (iOS app target — SwiftUI harness)
│   ├── ParentFilterPoCApp.swift
│   ├── ContentView.swift
│   ├── FilterController.swift          // NEFilterManager + FamilyControls auth,
│   │                                   // snapshot install, self-test runner
│   └── ParentFilterPoC.entitlements
├── FilterDataProvider/       (Network Extension — Content Filter, data provider)
│   ├── FilterDataProvider.swift        // evaluates flows; NO network, NO DNS
│   └── FilterDataProvider.entitlements
├── FilterControlProvider/    (Network Extension — Content Filter, control provider)
│   ├── FilterControlProvider.swift     // remediationMap + CNAME resolution
│   └── FilterControlProvider.entitlements
└── Shared/                   (sources compiled into all three targets)
    ├── YouTubeNormalize.swift          // mirror of shared/youtube/*
    ├── HostNormalize.swift             // mirror of shared/categories/category-data.ts
    ├── SafetyFloor.swift               // port of shared/safety/safety-floor.ts
    ├── CategoryBloom.swift             // QUERY-side port of shared/categories/bloom.ts
    ├── CategoryFilterStore.swift       // signed filter asset cache
    ├── CanonicalJSON.swift             // mirror of backend/src/util/canonical.ts
    ├── SnapshotVerifier.swift          // Ed25519 (CryptoKit), SPKI DER → raw key
    ├── PolicyModel.swift               // mirror of shared/policy/*
    ├── URLNormalize.swift              // mirror of normalizeExactUrl/matchesPattern
    ├── PolicyStore.swift               // verified snapshot cache + the evaluator
    ├── CnameResolver.swift             // CNAME chain + App-Group chain cache
    └── SelfTest.swift                  // cross-platform compatibility vectors
```

The `Shared/` Swift MUST reproduce the semantics of the TypeScript in `/shared`
(and `backend/src/util/canonical.ts`). The TypeScript is the authoritative spec.

## What is now implemented

| Area | Before | Now | Proven? |
|---|---|---|---|
| CATEGORY rules | `case .category: return nil` — the tier was a no-op, so "block all social media" enforced **nothing** on iOS | Evaluated over the snapshot's inline `categories` map **unioned with** the downloaded Bloom filter set, across the request host *and* every CNAME-resolved name | Logic mirrors the TS; **never compiled or run** |
| `DevicePolicySnapshot.categories` | absent from the Swift model | present, optional, signed with the rest of the snapshot | as above |
| Snapshot signatures | explicit "verify later" TODO; any App-Group writer could plant an allow-all policy | Ed25519 verified with CryptoKit on **every read** (memoized by SHA-256), over the canonical JSON of the snapshot minus `signature`; **fails closed** | end-to-end vector against a real backend signature exists in `SelfTest.swift`, **not yet executed** |
| Anti-replay | none | monotonic version high-water mark; a validly-signed *older* snapshot is refused | not executed |
| Signing key | none | build-time pin (`PolicyStore.pinnedSigningKeySPKIB64`, currently empty) with a **write-once** enrolled fallback | not executed |
| Bloom querier | absent | FNV-1a/32 with both seeds, enhanced double hashing, base64 bit array, `hostCandidates` suffix probing | hand-computed vectors in `SelfTest.swift`, **not yet executed** |
| Safety floor | absent | ALLOW above every tier — above device rules, temporary blocks, default-deny, **and** above the fail-closed tamper posture; never logged (`EvalResult.isReportable`) | not executed |
| CNAME chain | `getaddrinfo(AI_CANONNAME)` → at most the **final** name, so intermediate blocked aliases were invisible | per-step `DNSServiceQueryRecord(kDNSServiceType_CNAME)` walk with loop guard + depth cap (mirrors `shared/net/cname.ts`), `getaddrinfo` kept as a terminal-name fallback | not executed; see the honest limitations below |
| Where CNAME resolution runs | in the data provider, whose sandbox forbids network access | in the **control provider** (which is permitted network), reached via `NEFilterNewFlowVerdict.needRules()`; the data provider reads an App-Group chain cache | **architectural change, entirely unverified** |
| `resolvedHosts` into evaluation | browser + socket flows | browser + socket flows, plus the control-provider path | not executed |
| Trailing-root-dot bug | `YouTube.stripWww` did not strip `.`, so `https://youtube.com./…` bypassed every YouTube rule | fixed; `Host.normalize` is the single mirror of the TS `normalizeHost` | vector in `SelfTest.swift` |
| ISO-8601 dates | `JSONDecoder.dateDecodingStrategy = .iso8601` rejects the milliseconds every `toISOString()` payload carries | `PolicyDates` accepts both forms | not executed |

## What is still NOT implemented

* **Trusted clock (ADR-009).** `PolicyStore.nowUTC()` is still `Date()`. A device
  clock rollback can still extend a temporary grant. Unchanged by this pass.
* **Backend transport.** Nothing here fetches `/v1/policy`, `/v1/signing-key`, or
  `/v1/categories/filters`. `FilterController.installSignedSnapshot(_:)`,
  `enrollSigningKey(_:)`, and `installCategoryFilters(_:)` are the seams; the
  HTTP client is not written.
* **`APPLICATION` rules.** `appId` is never populated — `NEFilterFlow` exposes
  `sourceAppIdentifier` on some platforms/versions; not wired.
* **Reporting pipeline.** `handle(_ report:)` is deliberately empty. Anything
  added there must consult `EvalResult.isReportable` so safety-floor hits are
  never reported.
* **Keychain-backed provisioning state.** The "device was provisioned" marker and
  the version high-water mark live in the same App Group they defend (see below).

## What a Mac engineer must verify first

Work top to bottom. The first two are all-or-nothing and will silently break the
product in opposite directions.

**Step 0 — run the vectors.** Build, launch, tap *"Run cross-platform vectors"*
(section 0 of the harness), or call `PolicySelfTest.runAll()` from an XCTest
target. Every failure it prints is a real incompatibility, not a flaky test.

1. **Canonical-JSON parity (highest risk — fails CLOSED, bricks policy).**
   `CanonicalJSON.swift` must produce byte-identical output to
   `backend/src/util/canonical.ts`. If it does not, **every** snapshot is
   rejected and the device blocks the whole web. `SelfTest.signatureVector()`
   pins this against `expectedCanonicalSnapshot` and then verifies a **real**
   Ed25519 signature the backend produced, so a mismatch shows you the exact
   diverging bytes. Specific things to confirm:
   * Keys sort by **UTF-16 code unit** ("Z" before "a"). Foundation's
     `JSONEncoder.OutputFormatting.sortedKeys` uses a case- and
     diacritic-insensitive collation and is *not* usable here; the sort is
     hand-written for that reason.
   * The snapshot is canonicalized from the **raw delivered bytes**, never from a
     re-encoded `Codable` model.
   * Non-integer numbers deliberately **throw**. If a real snapshot ever carries
     one, verification will fail closed and you must implement JS
     `Number::toString` properly rather than removing the guard.

2. **Bloom vector parity (fails OPEN — silently enforces nothing).**
   `SelfTest.bloomIndexVectors()` / `bloomFilterVector()` carry hand-computed
   values with the arithmetic written out. The dangerous spot is the enhanced
   double hashing: JS does the additions in float64 and truncates with `>>> 0`,
   which is UInt32 wrap-around; Swift needs `&+`. A port that used `+` traps in
   debug, and one that used `Int64` never wraps — either way category blocking
   goes quiet. Cross-check against `shared/categories/bloom.test.ts` with a real
   backend-built filter as soon as one is available.

3. **CryptoKit key handling.** `Curve25519.Signing.PublicKey(rawRepresentation:)`
   wants 32 raw bytes; the backend publishes 44 bytes of base64 SPKI DER. The
   unwrap checks the 12-byte prefix `302a300506032b657003210 0` rather than
   blindly slicing. Vector (b) in the self-test asserts it.

4. **`needRules()` → control provider round trip (architectural, unverified).**
   `FilterDataProvider` returns `.needRules()` when a host's CNAME chain is
   unknown *and* the current decision is ALLOW. If that stalls flows on a real
   device, set `FilterDataProvider.askControlProviderForUnknownHosts = false`;
   the filter then behaves like the browser extensions (first sighting of a host
   is decided without a chain, later flows are covered).

5. **DNS-SD CNAME decoding.** `CnameResolver.decodeDNSName` assumes
   mDNSResponder returns **uncompressed** rdata and *rejects* a 0xC0 compression
   pointer rather than guessing. Confirm against a real multi-hop chain (test
   C1). Also confirm `import dnssd` resolves in the iOS SDK — the call site is
   wrapped in `#if canImport(dnssd)` and degrades to the `getaddrinfo` terminal
   name if not.

6. **`NEFilterControlVerdict` has no remediate case.** A flow blocked in the
   control provider is dropped, not shown the Request-Access page; it returns
   `withUpdateRules: true` so the *next* flow to that host is remediated
   properly by the data provider. Check how that reads in Safari (test A3).

7. **Exact-URL normalization parity (medium risk).** `URLNormalize.normalizeExact`
   reproduces WHATWG `URL.toString()` behavior (lowercase scheme/host, default
   port dropped, empty path → "/", stable query sort) on top of
   `URLComponents`, which does less. Exotic URLs — userinfo, punycode/IDN,
   unusual percent-encoding — may normalize differently from the TS. The failure
   mode is a URL-tier rule that does not match on iOS, which loses a URL-level
   ALLOW exception and falls through to DOMAIN/CATEGORY/default.

## Trust model of the App Group (read before relying on the fail-closed posture)

The evaluator's posture when the cached policy is not trustworthy:

| state | posture |
|---|---|
| verified snapshot | evaluate normally |
| present but signature invalid, or version rolled back | BLOCK everything except the safety floor |
| absent **and** the device was provisioned | BLOCK everything except the safety floor |
| absent **and** never provisioned | ALLOW (an unenrolled device stays usable) |

Falling back to "no policy ⇒ allow" would have made *deleting* the snapshot a
complete bypass, so it is not done. The honest limit: the provisioned marker and
the version high-water mark live in the same App Group they defend, so an
attacker who can write there can also clear them and get back to "never
provisioned". Raising that bar means moving both into the Keychain or requiring a
server round trip at launch; neither is implemented. On a non-jailbroken device
the App Group is reachable only by this app and its own extensions, which is what
makes the posture worth having at all.

## Wiring notes

- **App Group** (`group.com.example.parentfilterpoc`) is the only channel between
  the containing app and the sandboxed extensions — the data-provider sandbox
  blocks network, IPC, and disk writes, so the app writes the signed policy
  snapshot into the App Group container and the providers read it. Only the app
  sets `PolicyStore.recordsDiagnostics = true`; extensions must not write.
- **FamilyControls**: the app calls
  `AuthorizationCenter.shared.requestAuthorization(for: .child)`; a parent must
  approve on the child device. Only then does the content filter load on an
  unsupervised device (TN3134).
- **Enable the filter**: `NEFilterManager.shared().providerConfiguration` set to
  an `NEFilterProviderConfiguration` with `filterBrowsers = true` (WebKit flow
  URLs) and `filterSockets = true`; `isEnabled = true`; `saveToPreferences`.
- **Remediation**: the control provider sets `remediationMap` and the data
  provider returns `.remediateVerdict(...)` for a blocked WebKit flow.
- **Fast update**: after the app writes a new snapshot, it pings the control
  provider which calls `notifyRulesChanged()`.
- **Category filters** are a *separate* signed asset
  (`GET /v1/categories/filters`), fetched by the app, verified by
  `CategoryFilterStore`, and queried by the providers. Not to be confused with
  the unrelated `NEURLFilter` Bloom format in `apple/poc-urlfilter/` — different
  hash functions, different file layout, different purpose.

## Notes on the TypeScript spec found while porting

* `hostCandidates()` in `shared/categories/category-data.ts` does **not** emit the
  bare public suffix, but its doc comment claims it does
  (`"m.old.reddit.com" → [… , "com"]`). The code is what the SQL store and the
  Bloom builder agree on, so the Swift mirrors the code; the TS **comment** should
  be corrected.
* `isSafetyFloorHost()` strips a leading `www.` but not a trailing root dot,
  relying on callers to have run `normalizeHost` first. `evaluate()` does. Any
  new caller that does not would let `988lifeline.org.` slip past the floor.

## What to measure

Follow `docs/APPLE_CONTENT_FILTER_POC.md` tests A1–A6 and fill the Observed
Results tables there, then update `docs/DECISIONS.md` ADR-001. Add a test for
CATEGORY enforcement and one for the safety floor; neither was covered.
