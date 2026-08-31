# Architecture Decision Record (ADR)

Running log of load-bearing decisions and the empirical results that confirm or
overturn them. Each ADR has a status: **Proposed** (design-time, unproven),
**Accepted** (proven on hardware or firmly settled), **Superseded**.

Phase-0 ADRs are mostly **Proposed** — they encode the research conclusion and
name the PoC that must confirm them. Update the status + "Evidence" line when a
PoC produces a result.

---

### ADR-001 — The per-video-approval engine on iOS is `NEFilterDataProvider`, not `NEURLFilter`
**Status:** Proposed (confirm in PoC A)
**Context:** The headline requirement is default-deny YouTube with per-video
approval in seconds. Research shows `NEURLFilter` is **blocklist-only** (dataset
values are always `1`; sub-URL enumeration blocks a whole domain with no
override) and has **no remediation/Request-Access UX**. The classic
`NEFilterDataProvider` content filter, under FamilyControls `.child`, sees the
**full URL** on WebKit/Safari flows, supports a **dynamic allowlist** with
`notifyRulesChanged()` (seconds), and provides a **remediation block page**.
**Decision:** iOS per-video enforcement = `NEFilterDataProvider` + FamilyControls
`.child`. `NEURLFilter` is relegated to the supplementary blocklist layer.
**Consequences:** iOS requires a genuine child Apple ID in Family Sharing; the
`.individual` posture is explicitly not marketed as parental control.
**Evidence:** _partial — compile-time only; the runtime claim is still unproven._
On 2026-08-27 the PoC A scaffold was assembled into a real Xcode project
(`apple/poc-contentfilter/project.yml`, XcodeGen 2.46.0) and **builds clean for
`arm64` device** against the iPhoneOS SDK shipped with Xcode 27.0, deployment
target iOS 26.0 (app + filter-data `.appex` + filter-control `.appex`, App Group
`group.com.example.parentfilterpoc`). That confirms the API surface the decision
rests on *exists and type-checks* — `NEFilterDataProvider.handleNewFlow`,
`NEFilterBrowserFlow`, `NEFilterNewFlowVerdict.remediateVerdict(...)`,
`NEFilterControlProvider.remediationMap` / `notifyRulesChanged()`,
`NEFilterManager` + `NEFilterProviderConfiguration.filterBrowsers`, and
`AuthorizationCenter.shared.requestAuthorization(for: .child)`.
It does **not** confirm any behavioural claim. Tests A1–A6 have **not been run**:
no iOS device and no signing identity were available (see ADR-012). The
propagation number, the A6 tamper findings, and the §0 workflow all remain
**unproven**. Do not treat this ADR as Accepted.

### ADR-002 — `NEURLFilter` is a supplementary large-scale blocklist, not the core
**Status:** Proposed (confirm in PoC D)
**Context:** `NEURLFilter` scales to millions of blocked URLs with a
privacy-preserving Bloom+PIR design, but cannot express allow-one-video and
cannot update the Bloom prefilter faster than 45 minutes.
**Decision:** Use `NEURLFilter` only for adult/malware/known-proxy/category
blocklists and specific bad videos. Do not over-invest PIR/OHTTP infrastructure
in Phase 0.
**Evidence:** _pending PoC D._

### ADR-003 — No VPN and no TLS interception on Apple platforms
**Status:** Accepted (design principle)
**Context:** Older parental-control apps use a local VPN. The native
content-filter + URL-filter path meets the requirement without routing or
decrypting traffic.
**Decision:** No `NEVPNManager`/packet-tunnel and no TLS MITM on Apple. A VPN is a
documented fallback only, introduced solely if a PoC proves the native path
cannot meet a concrete requirement.
**Evidence:** native path covers the MVP flow by design; revisit only on a proven gap.

### ADR-004 — Never block Safari to gain enforcement on macOS
**Status:** Accepted (product constraint)
**Context:** Native-macOS content filter is hostname-only and `NEURLFilter` can't
default-deny, making Safari per-video hard.
**Decision:** macOS per-video enforcement is a **Safari Web Extension** (+
`NEURLFilter` blocklist + `NEFilterDataProvider` system extension for
socket/hostname). Safari stays fully functional; we never disable it.
**Evidence:** _direction set; feasibility of force-install + tamper resistance pending PoC B._

### ADR-005 — Windows starts without TLS interception
**Status:** Proposed (confirm in PoC C)
**Context:** No Windows OS layer sees an HTTPS path. Per-URL control comes from a
**policy-installed browser extension** (`webRequestBlocking` survives policy
install) or a local MITM proxy. MITM is invasive (root CA, pinning breakage,
QUIC handling).
**Decision:** Ship first with hardened service + policy-installed Chrome/Edge/
Firefox extensions doing full-URL enforcement + anti-tamper/browser-policy +
block unsupported browsers. Introduce TLS interception only if a concrete
required case cannot be covered this way.
**Evidence:** _pending PoC C (esp. force-install + webRequestBlocking on Win 11 Home, non-domain-joined)._

### ADR-006 — Child must be a standard (non-admin) account on macOS and Windows
**Status:** Accepted (product constraint)
**Context:** An admin child can delete apps, remove system extensions/CAs,
uninstall the service, and edit policy on both OSes; PPL/ELAM (the only
admin-resistant Windows mechanism) is out of reach for a small vendor.
**Decision:** Require a standard child account; the agent detects admin-child and
alerts the parent instead of claiming protection it cannot provide.
**Evidence:** research-confirmed; agent enforcement is an implementation task.

### ADR-007 — YouTube resources are first-class policy objects keyed by canonical id
**Status:** Accepted
**Context:** The same video appears under many URL forms; approving a URL string
would be brittle and could leak into the channel/recommendations.
**Decision:** All adapters call `shared/youtube/youtube-normalize.ts` to reduce a
URL to `YOUTUBE_VIDEO|CHANNEL|PLAYLIST:<id>` before consulting policy; the policy
engine operates on ids; approving a video never widens scope.
**Evidence:** implemented in `shared/`; adapters must reuse it (enforced by review).

### ADR-008 — One shared policy model + evaluation order; platforms only differ in enforcement
**Status:** Accepted
**Context:** Five enforcement engines must behave identically.
**Decision:** `shared/policy/policy-model.ts` defines targets/actions/scopes,
the evaluation order, temporary-rule expiry, and the reference `evaluate()`.
Adapters reproduce these semantics or compile a documented subset (e.g.
`NEURLFilter`'s blocklist).
**Evidence:** implemented; conformance is a per-adapter test obligation.

### ADR-009 — Temporary approvals: server-signed UTC expiry + monotonic clock + rollback detection
**Status:** Accepted (design principle)
**Context:** A child can change the system clock (admin) or time zone (standard
user, on Windows) to extend a grant.
**Decision:** Store/compare expiries in **UTC**; track durations with a
**monotonic** clock; detect clock/timezone skew vs. server time as a tamper
signal; grants are server-authoritative and signed. Fail closed on protected
categories, fail open on ordinary network errors.
**Evidence:** encoded in `shared/policy/policy-model.ts` (`TemporaryRule`,
`EvalContext.nowMs`); adapter enforcement pending per-platform PoCs.

### ADR-010 — Approvals are server-authoritative and cryptographically signed
**Status:** Accepted
**Context:** A child must never fabricate a parent approval.
**Decision:** `ApprovalDecision` + `TemporaryRule` originate server-side, are
delivered inside an Ed25519-signed `DevicePolicySnapshot`, and adapters reject
unsigned/altered snapshots (fail closed).
**Evidence:** snapshot signature field defined in `shared/`; backend + adapter
verification is a Phase-1 task.

### ADR-011 — iOS 26/27 SDK corrections to the PoC A scaffold
**Status:** Accepted (compiler-verified against the Xcode 27.0 iPhoneOS SDK)
**Context:** The Phase-0 scaffold was written from documentation without an SDK
to compile against. Building it for real surfaced three places where the SDK
disagrees with what was written. Recorded here because two of them are load-
bearing for the remediation ("Request Access") design, not cosmetic.
**Corrections applied:**
1. `NEFilterNewFlowVerdict.remediateVerdict(remediationURLMapKey:remediationButtonTextMapKey:)`
   does not exist. The Swift label is **`withRemediationURLMapKey:`**
   (from ObjC `+remediateVerdictWithRemediationURLMapKey:remediationButtonTextMapKey:`).
2. `NEFilterControlProvider.remediationMap` is typed
   `[String: [String: NSObject]]?`, **not** `[String: [String: String]]`. The
   inner values must be bridged explicitly (`... as NSString`); a plain Swift
   `String` literal is a type error.
3. `NEFilterProvider.handleReport(_:)` was **obsoleted in Swift 3** and is
   renamed to **`handle(_:)`**. Overriding `handleReport` fails to compile.
**Consequence:** none architectural — the capabilities ADR-001 depends on are all
present under corrected names. `apple/poc-contentfilter` now compiles as written.

### ADR-012 — PoC A is build-verified but **not** hardware-verified
**Status:** Open blocker (not a decision — a gap that must be closed)
**Context:** PoC A is the load-bearing proof for the whole iOS story. Executing
it requires a physical iOS 26 device: the Simulator cannot run a content filter,
`NEURLFilter`, or FamilyControls `.child`, and `.child` itself requires a real
child Apple ID inside a Family Sharing group.
**What was blocked (2026-08-27):** the development host was an Apple Virtual
Machine (`VirtualMac2,1`) with **no paired iOS device**
(`xcrun devicectl list devices` → none), **zero code-signing identities**
(`security find-identity -p codesigning` → 0), no provisioning profiles, and no
Apple Developer team configured in Xcode.

**What is blocked now (2026-08-31, re-measured on a physical M4 Pro Mac).** Most
of the 2026-08-27 blockers are gone; the ADR stays open because the ones that
matter are not:

| Was blocked | Now |
|---|---|
| Apple VM host | **Resolved** — physical Apple silicon Mac, macOS 27.0, Xcode 27.0 |
| Zero signing identities | **Resolved** — 3 valid identities, incl. an Apple Distribution cert |
| Compiler never run on `Shared/` | **Resolved** — `PolicySelfTest.runAll()` passes every cross-platform vector |
| No paired iOS device | **Resolved** — iPhone 16 Pro Max, iOS 27.0, Developer Mode on |
| No App IDs / App Group registered | **Resolved** — all three App IDs + the App Group exist in `2BPX4R682U` |
| Family Controls entitlement (development) | **Resolved** — see below; granted without Apple review |
| Family Controls entitlement (distribution) | **STILL BLOCKED** — not requested; TestFlight impossible until granted |
| **A child/teen Apple ID on the test device** | **STILL BLOCKED — the new critical path** (see below) |

**The app is signed, installed and running on hardware (2026-08-31).** Xcode
automatic signing against team `2BPX4R682U` registered the device, created all
three App IDs and the `group.family.ajar.child` App Group, and minted three
development profiles. `xcodebuild -allowProvisioningUpdates` from the command
line will NOT do this — it silently falls back to a cached wildcard profile and
emits no authentication diagnostic; the portal writes only happen through the
Xcode GUI (or an App Store Connect API key).

**`com.apple.developer.family-controls` is available for DEVELOPMENT without
Apple's review.** Confirmed by reading the minted profile, which carries
`com.apple.developer.family-controls => true` plus
`com.apple.developer.family-controls.app-and-website-usage`. This is direct
evidence for the split the runbook and the TestFlight workflow both assert:
development signing needs no entitlement request, distribution does.

**What actually blocks A1–A6 now is the test account, not the toolchain.**
`AuthorizationCenter.requestAuthorization(for: .child)` fails on a device signed
in with an ADULT Apple ID — Family Controls is available only to child and teen
iCloud accounts (`FamilyControlsError.invalidAccountType`). The prerequisite in
APPLE_CONTENT_FILTER_POC.md was written as an assumption; it is now a measured
hard requirement. Since an unsupervised device grants the content filter only to
a Family-Controls-authorized app (TN3134), this gates the whole matrix, not just
the A6 tamper tests.

The team question is now decided: the `family.ajar.*` identifiers belong to
**Consultinc Group LLC, Team ID `2BPX4R682U`** (the Organization team, per
APPLE_ACCOUNT_SETUP §1). The Individual team `2X6C7C96PZ` holds the only
distribution certificate on the host but must **not** own these ids — the
entitlements are org-gated and an Individual account cannot be converted.

**The Simulator is not a fallback, and this is now measured rather than
asserted.** The project builds, installs and launches on an iOS 26.5 Simulator,
because the simulator SDK ships the full `NEFilter*` headers. It cannot run:
`NEFilterManager.saveToPreferences()` fails with `NEFilterErrorDomain` Code=6
("IPC failed") and `AuthorizationCenter.requestAuthorization(for: .child)` fails
with `NSCocoaErrorDomain` Code=4099 (connection to `com.apple.FamilyControlsAgent`
invalidated); the Simulator runs no NetworkExtension daemon at all. Note the
trap: `loadFromPreferences()` *succeeds* against an unbacked stub, so a smoke
test that stops one call early will report a working filter. See
APPLE_CONTENT_FILTER_POC.md.
**Decision:** record PoC A as **build-green / test-not-run**. The Observed
Results table in `docs/APPLE_CONTENT_FILTER_POC.md` is deliberately left empty
rather than filled with expected values — no number in this repo should be one
nobody measured.
**To close:** a Mac with USB access to an iOS 26 device, an Apple Developer team
with the Family Controls entitlement, and a child Apple ID in a Family Sharing
group. Then run A1–A6 verbatim and update ADR-001 and ARCHITECTURE.md §13.

### ADR-013 — iOS 26/27 SDK corrections to the PoC D scaffold, and the `NEURLFilter` API as it actually ships
**Status:** Accepted (compiler-verified against the Xcode 27.0 iPhoneOS SDK)
**Context:** The PoC D scaffold was written from WWDC/doc research. Compiling it
for the first time showed the shipped API differs in shape, and — more
importantly — that the capability split between iOS 26 and iOS 27 is load-bearing
for ADR-002.

**Where the API actually lives.** `NEURLFilter` is only *partly* Objective-C. The
header `NEURLFilter.h` declares nothing but the verdict enum and
`+verdictForURL:completionHandler:`. `NEURLFilterManager`,
`NEURLFilterControlProvider` and `NEURLFilterPrefilter` are **Swift-native** and
declared only in `NetworkExtension.swiftinterface`. Read that file, not the
headers, when checking this API.

**Corrections applied:**
1. `NEURLFilterControlProvider` is a **protocol refining ExtensionFoundation's
   `AppExtension`**, not a class to subclass. The provider is a `@main` struct
   conforming to it, with `init()`; `configuration` comes from the protocol's
   default implementation. It is an **ExtensionKit** extension — it lands in
   `MyApp.app/Extensions/`, not `PlugIns/`, which is consistent with the
   `EXExtensionPointIdentifier` key the scaffold already specified.
2. `NEURLFilterPrefilter.init(data:…)` takes an
   `NEURLFilterPrefilter.PrefilterData` enum — `.smallFilter(Data)` or
   `.temporaryFilepath(URL)` — **not** raw `Data`. The `.temporaryFilepath` case
   is the intended path for a blocklist too large to hold in memory.
3. `NEURLFilterManager.setConfiguration(pirServerURL:pirPrivacyPassIssuerURL:pirAuthenticationToken:controlProviderBundleIdentifier:)`
   **throws**.
4. `resetPIRCache()` and `refreshPIRParameters()` are **`async throws`**, not
   synchronous. `status` and `lastDisconnectError` are `async` getters.
5. `shouldFailClosed` and `prefilterFetchInterval` exist as assumed (iOS 26).

**The iOS 26 / iOS 27 split — this is the important part.** Every URL-parsing
control is gated `@available(iOS 27.0, macOS 27.0, *)`:
`ParsingConfiguration`, `urlParsingConfiguration`, `urlParsingRegularExpression`,
`setURLParsingRegularExpression` (also `reportEndpoint`/`reportInterval`/`reportFormat`).

- **On iOS 26 there is no way to influence the dataset-key shape at all.** The
  system's key derivation is fixed, with hierarchy enumeration on. That *is* the
  "blocking a sub-URL takes out the whole domain" behaviour ADR-002 describes.
- **On iOS 27** the shape is controllable and the §13 item-9 unknown is answered
  at the API level:
  `ParsingConfiguration.QueryOptions(excluded:parameters:)` can include named
  query parameters (so `parameters: ["v"]` keys on the YouTube video id), and
  `DomainOptions(excluded:stripWWW:levels:enumerateHierarchy:)` /
  `PathOptions(excluded:segments:enumerateHierarchy:)` can turn hierarchy
  enumeration **off**. So a key of the form `youtube.com/watch?v=<id>` is
  expressible and blocking one video need not escalate to the whole domain.

**Consequence for ADR-002: it stands, refined.** iOS 27 makes `NEURLFilter`
*precise*, but precision was never the blocker — `NEURLFilter` still has **no
allow verdict and no default-deny**, so it cannot express "deny all of YouTube
except this one video" on either OS version. It remains the supplementary
blocklist; PoC A remains the per-video engine. What changes is that on iOS 27 the
blocklist can name individual videos without collateral damage to the domain,
which makes the "specific bad videos" use in ADR-002 actually practical — on iOS
26 it is not.

**Also found:** `build_bloom.py` emits PIR keywords that keep the `www.` prefix
(`www.youtube.com/watch?v=…`), but `DomainOptions.stripWWW` defaults to **true**,
so on iOS 27 the device would look up `youtube.com/watch?v=…`. A Bloom hit would
then never land on a matching PIR row. Not changed yet because the iOS 26
behaviour is unobservable from the SDK — flagged as the concrete form of "Key
unresolved" item 6 and must be reconciled against observed device keys (D3/D6).

### ADR-014 — Tamper resistance should be enforced through ManagedSettings, not assumed from `.child`
**Status:** Proposed (API confirmed present; behaviour unverified on hardware)
**Context:** PoC A test A6 and ADR-009 currently *hope* that the `.child` posture
blocks app deletion, iCloud sign-out, and clock tampering. Reviewing the
ManagedSettings API in the Xcode 27 SDK shows these are not things to hope for —
they are settings the product can assert explicitly once it holds FamilyControls
authorization:
- `ApplicationSettings.denyAppRemoval` — blocks deleting the app.
- `ApplicationSettings.denyAppInstallation` — blocks installing a bypass app.
- `AccountSettings.lockAccounts` — blocks signing out of iCloud.
- `DateAndTimeSettings.requireAutomaticDateAndTime` — forces automatic date/time,
  which directly hardens the ADR-009 clock-rollback concern instead of merely
  detecting it. This is the strongest available answer to A5's "change the clock
  to extend a grant" test.
**Decision (proposed):** the product asserts these through a `ManagedSettingsStore`
rather than relying on defaults, and A6 tests both postures — `.child` alone, and
`.child` + explicit ManagedSettings — so we learn which protections are inherent
and which we must assert.
**Not solved by this:** there is **no** ManagedSettings key that locks the
content-filter or URL-filter toggle in Settings. That question is still open and
still cannot be answered from the SDK — only on hardware (A6 / D5).

## ADR-015 — Use UT1's live licence (CC BY-SA 4.0) for category data

**Status:** Accepted, with a required pre-launch confirmation.

**Context.** Domain categorization needs a corpus. The research established that
most commercial feeds' terms forbid our delivery model outright (we compile a
Bloom filter and serve it to devices, which is redistribution of adapted
material). UT1 is the viable backbone, but its page carries a live CC BY-SA 4.0
link **and** a commented-out legacy RDF block naming CC BY-NC-SA 4.0. NC would
disqualify it for a commercial product.

**Decision.** Proceed on the **live** licence — CC BY-SA 4.0 — treating the
commented-out block as superseded. Confirm with the maintainer before building
ingestion at scale, and until then avoid anything the NC variant would forbid
(we consume the data in a product; we do not sell or sub-licence it).

**Consequences.**
- ShareAlike is viral on the artifact: our compiled filter set is adapted
  material and is offered under CC BY-SA 4.0. The shipped set is not proprietary,
  and recipients may redistribute it alike. Accepted — the product is the
  enforcement engine and the family experience, not the list.
- Attribution must travel WITH the asset, so it lives inside the signed
  `CategoryFilterSet.attribution` rather than only in documentation. Stripping it
  invalidates the signature (tested).
- Keeping `CategoryProvider` source-agnostic is now load-bearing insurance, not
  just tidiness: if the licence resolves to NC, the corpus is swapped without
  touching the engine.

**Alternative rejected.** Licensing a commercial feed — verified terms from
multiple vendors bar redistribution, derivative works, or both, which is exactly
what shipping a compiled filter to a device is.

See `docs/DATA_LICENSES.md` for the full table and the standing rules.
\n