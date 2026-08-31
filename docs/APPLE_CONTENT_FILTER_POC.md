# PoC A — iOS `NEFilterDataProvider` + FamilyControls `.child` (PRIMARY)

> This is the **primary** Phase-0 proof. It answers §0 of `ARCHITECTURE.md`:
> can a child hit a blocked YouTube video, request it, have a parent approve
> only that canonical video for a chosen duration, refresh within seconds, and
> play it while every other unapproved video stays blocked — **on an
> unsupervised consumer iPhone, no VPN, no TLS interception, no MDM**?
>
> **Status (2026-08-27): BUILD-GREEN, TESTS NOT RUN.**
> `apple/poc-contentfilter/project.yml` (XcodeGen) now produces a real
> `ParentFilterPoC.xcodeproj` whose three targets — app, filter-**data** `.appex`,
> filter-**control** `.appex` — compile and link clean for `arm64` device against
> the Xcode 27.0 iPhoneOS SDK at deployment target iOS 26.0. Three SDK API
> corrections were required; see ADR-011.
>
> **A1–A6 have not been executed.** They need a physical iOS 26 device (the
> Simulator cannot run a content filter, `NEURLFilter`, or FamilyControls
> `.child`) plus an Apple Developer team that can issue the Family Controls and
> `content-filter-provider` entitlements. Neither was available: the build host is
> an Apple VM with no paired device and zero code-signing identities (ADR-012).
> **The Observed Results table below is intentionally left empty.** Do not fill it
> with the Expected column — the point of this PoC is measurement, not
> restatement.

## What this PoC proves (and why it's the right first test)

Research already established that `NEURLFilter` is blocklist-only and cannot do
allow-one-video (see `ARCHITECTURE.md §3.1`, ADR-001). The classic content-filter
path is the one that can, because on WebKit/Safari flows the control provider
receives the **full URL** (`NEFilterFlow.url` is non-nil only for WebKit flows —
<https://developer.apple.com/documentation/networkextension/nefilterflow/url>)
and can render a **Request-Access** remediation page. So we prove the actual
product workflow before building anything else.

## Prerequisites (on real hardware)

- Xcode 26 or later (verified building under **Xcode 27.0**, iPhoneOS 27.0 SDK,
  deployment target iOS 26.0), an iPhone/iPad on **iOS/iPadOS 26**.
- A **child Apple ID** (under-18) that is a member of a **Family Sharing** group
  whose organizer is the test "parent" Apple ID, signed in on the test device.
  (This is the `.child` posture from `ARCHITECTURE.md §4`; `.individual` will not
  unlock the content filter.)
- **Family Controls** capability added to the app; **Network Extension** →
  Content Filter capability added to the extension. For development you run
  dev-signed (no App Review, no distribution entitlement needed yet). See TN3134:
  <https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment>.
- No MDM, no supervision, no VPN, no certificate installed.

## Experiment matrix

Two canonical YouTube video ids are used throughout:
- **ALLOWED_VIDEO** = `dQw4w9WgXcQ` (the one the "parent" approves)
- **BLOCKED_VIDEO** = `9bZkp7q19f0` (must stay blocked the whole time)

Both are reduced to `YOUTUBE_VIDEO:<id>` by `shared/youtube/youtube-normalize.ts`
regardless of URL form; the extension must call that same normalization.

### A1 — Block one exact video, allow another on the same host
1. Set policy: YouTube default = **deny**; standing allow for `YOUTUBE_VIDEO:dQw4w9WgXcQ`.
2. In Safari open `https://www.youtube.com/watch?v=9bZkp7q19f0` → expect **block page**.
3. Open `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → expect **plays**.
4. Repeat step 2 via `youtu.be/9bZkp7q19f0`, `m.youtube.com/watch?v=9bZkp7q19f0`,
   `/shorts/9bZkp7q19f0`, and a URL with extra params
   `…watch?v=9bZkp7q19f0&t=30s&pp=abc` → all must **block** (canonicalization).
5. Confirm the approved video actually **streams** (googlevideo.com reachable) —
   validates `YOUTUBE_PLAYBACK_SUPPORT_HOSTS`.

### A2 — Full URL / query visibility in Safari
Log `flow.url` in the data provider for each navigation; confirm the full path +
query is present for Safari flows (not just hostname), and record what a
non-WebKit app (a bare `URLSession` request) exposes for contrast.

### A3 — Remediation "Request Access" block page
On a blocked video, confirm the remediation page renders in Safari with a
tappable **Request Access** button (`NEFilterControlProvider.remediationMap` +
`remediateVerdict(...)`; handled by `handleRemediation(for:)`), and that tapping
it hands the blocked canonical id to the containing app to create a request.
Docs: <https://developer.apple.com/documentation/networkextension/nefilterdataprovider>.

### A4 — Dynamic allowlist update propagation (target: seconds)
With BLOCKED shown, add an allow for `YOUTUBE_VIDEO:9bZkp7q19f0` in the app →
call `notifyRulesChanged()` → refresh Safari → measure the time from
"rule written" to "video plays". Record the number; the product target is a few
seconds. Repeat with removal (allow → deny) and measure.

### A5 — Temporary approval + automatic expiry (incl. offline)
Grant a **30-second** (short, for test) temporary allow for BLOCKED_VIDEO with a
server-signed UTC `expiresAt`. Confirm it plays, then confirm it is **blocked
again automatically** at expiry. Repeat with the device in **airplane mode**
after the grant is cached, to prove local expiry without connectivity. Try to
extend by changing the device clock/timezone forward and confirm the grant does
**not** extend (UTC + monotonic + skew detection, ADR-009).
Then test the **stronger** answer (ADR-014): with a `ManagedSettingsStore`
asserting `DateAndTimeSettings.requireAutomaticDateAndTime`, confirm the child
**cannot change the clock at all** — prevention beats detection. Record both the
detection-only behavior and the prevention behavior.

### A6 — What the child can/can't disable under `.child` (test BOTH postures — ADR-014)
The point of A6 is to learn which protections are **inherent** to `.child` and
which the product must **assert** via ManagedSettings. Run each attempt in two
postures and record both columns:

- **Posture A — `.child` alone**: what the authorization gives you by default.
- **Posture B — `.child` + asserted `ManagedSettingsStore`**: `ApplicationSettings.denyAppRemoval`,
  `ApplicationSettings.denyAppInstallation`, `AccountSettings.lockAccounts`,
  `DateAndTimeSettings.requireAutomaticDateAndTime`.

As the child, attempt: delete the app; sign out of iCloud; change the clock/timezone;
disable the filter in Settings; install a configuration profile / third-party DoH
app; add a VPN. Record blocked vs. allowed **in each posture**.
**Known open question (SDK-confirmed, ADR-014):** there is **no** ManagedSettings
key that locks the content-filter/URL-filter toggle in Settings — so "disable the
filter in Settings" is the single most important A6 result and can only be answered
here, on hardware. (Expected elsewhere: app-delete and iCloud-signout blocked at
least in Posture B; DNS/VPN behavior undocumented → empirical.)

## Build status (verified 2026-08-27; re-verified 2026-08-31 on Apple silicon)

Re-verified on a physical Apple silicon Mac (M4 Pro, macOS 27.0) under Xcode
27.0 (build 27A5237l), Swift 6.4, XcodeGen 2.46.0 — the 2026-08-27 run was on an
Apple Virtual Machine. Every row below was re-measured, not carried forward.

| Item | Result |
|---|---|
| `xcodegen generate` → `ParentFilterPoC.xcodeproj` | OK (XcodeGen 2.46.0) |
| App + 2 extensions compile/link, `-destination generic/platform=iOS` | **BUILD SUCCEEDED**, arm64, 0 warnings |
| `FilterDataProvider.appex` `NSExtensionPointIdentifier` | `com.apple.networkextension.filter-data` |
| `FilterControlProvider.appex` `NSExtensionPointIdentifier` | `com.apple.networkextension.filter-control` |
| Both `.appex` embedded in `ParentFilterPoC.app/PlugIns/` | OK |
| SDK API corrections needed | 3 — see ADR-011 |
| **`PolicySelfTest.runAll()` cross-platform vectors** | **ALL PASSED** (2026-08-31) — see below |
| Builds for the iOS Simulator SDK | OK (compiles and installs; **does not run** — see below) |
| Code-signed / installed / launched on a device | **NO — blocked, see ADR-012** |

### The shared evaluator now has a compiler behind it (2026-08-31)

`Shared/` was written without a compiler, and `FilterController.runSelfTest()`
calls `PolicySelfTest.runAll()` as its acceptance gate for canonical-JSON parity,
FNV/Bloom parity, host normalization, the safety floor and Ed25519 snapshot
verification. Those vectors had never been executed. They have now, and they
**all pass**.

They do not need a device, an entitlement or a signing identity — `Shared/`
imports only Foundation, CryptoKit and dnssd, so it compiles and runs natively:

```sh
cd apple/poc-contentfilter
swiftc -o /tmp/selftest /tmp/main.swift Shared/*.swift   # main calls PolicySelfTest.runAll()
/tmp/selftest        # -> "SELF-TEST: ALL VECTORS PASSED", exit 0
```

This is parity evidence for the evaluator only. It says nothing about
enforcement, which still requires hardware.

### Why the Simulator cannot substitute for hardware (measured 2026-08-31)

ADR-012 asserted this; it is now measured. The project **builds, installs and
launches** on an iOS 26.5 Simulator, because the iPhoneSimulator SDK ships the
full `NEFilter*` header set. It cannot **run**: the Simulator has no
NetworkExtension session daemon and no FamilyControls agent. A probe app calling
the two APIs directly on the Simulator returns:

| Call | Simulator result |
|---|---|
| `NEFilterManager.loadFromPreferences()` | succeeds (returns an unbacked stub) |
| `NEFilterManager.saveToPreferences()` | **`NEFilterErrorDomain` Code=6 "IPC failed"** |
| `AuthorizationCenter.requestAuthorization(for: .child)` | **`NSCocoaErrorDomain` Code=4099** — connection to `com.apple.FamilyControlsAgent` invalidated |
| `launchctl list` inside the Simulator, grepped for the NE daemon | no match |

The `loadFromPreferences()` success is the trap: a smoke test that stops there
reads as "the filter works". The very next call fails. **No part of A1–A6 can be
run on a Simulator** — every one of them depends on a flow actually reaching a
provider, and no flow ever does.

Reproduce (compile check, no signing identity needed):

```sh
cd apple/poc-contentfilter && xcodegen generate
xcodebuild -project ParentFilterPoC.xcodeproj -scheme ParentFilterPoC \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO clean build
```

For a real device build, drop `CODE_SIGNING_ALLOWED=NO` and pass
`DEVELOPMENT_TEAM=<your team id>`.

## Observed Results (A1-A3 RUN 2026-08-31; A4-A6 not run)

Device: iPhone 16 Pro Max, iOS 27.0 (24A5418b), Developer Mode on.
Build: development-signed, team `2BPX4R682U`, App Group `group.family.ajar.child`.
FamilyControls authorization: **Not Determined** — see the note below, it matters.

| Test | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| A1 block BLOCKED_VIDEO (all URL forms) | Block page | Block page on direct top-level load | **PASS (direct nav only)** | not enforced on in-app navigation — see A1-bypass |
| A1 allow ALLOWED_VIDEO plays + streams | Plays | Plays | **PASS** | only after `applyYouTubeDefaultToSocketFlows = false` |
| **A1-bypass in-app navigation (new)** | — | Other videos play once inside YouTube | **FAIL** | SPA swaps video over XHR; no top-level flow, so no video id |
| A2 full URL+query visible (Safari) | Full URL | Full URL incl. `?v=` query | **PASS** | block page rendered the complete URL; ALLOW matched by id |
| A2 bare URLSession exposure | (hostname only?) | hostname only | **CONFIRMED** | socket flows carry `remoteHostname` and nothing more |
| A3 remediation page + Request Access | Renders, round-trips | Renders, with Request Access link | **PARTIAL** | render confirmed; round trip back into the app NOT exercised |
| A4 add-allow propagation time | ≤ few seconds | | not run | |
| A4 remove-allow propagation time | ≤ few seconds | | not run | |
| A5 temp grant plays then auto-expires | Blocks at expiry | | not run | |
| A5 offline expiry (airplane mode) | Blocks at expiry | | not run | |
| A5 clock tamper (detection only, ADR-009) | No extension | | not run | |
| A5 clock tamper (`requireAutomaticDateAndTime`, ADR-014) | Cannot change clock | | not run | |
| A6 app delete — Posture A (`.child` alone) | ? | | not run | needs `.child`; blocked on account |
| A6 app delete — Posture B (`denyAppRemoval`) | Blocked | | not run | needs `.child` |
| A6 iCloud sign-out — Posture A | ? | | not run | needs `.child` |
| A6 iCloud sign-out — Posture B (`lockAccounts`) | Blocked | | not run | needs `.child` |
| A6 disable filter in Settings (either posture) | ? | | not run | **still the key unknown (ADR-014)** |
| A6 DNS/VPN/profile bypass | ? | | not run | **key unknown** |

### Three findings that were not on the test list

**1. The filter enforced with FamilyControls authorization `Not Determined`.**
`requestAuthorization(for: .child)` fails on this device (`invalidAccountType` —
the Apple Account signed in is an adult one), yet `NEFilterManager` enabled and
every verdict above was produced anyway. On iOS 27 the
`com.apple.developer.family-controls` **entitlement** was enough to run a content
filter; `.child` **authorization** was not required for enforcement. `.child` is
still what A6 tamper-resistance depends on, but the dependency is narrower than
ADR-001 assumed.

**2. Applying `youTubeDefault` to socket flows makes YouTube unreachable.** A
socket flow has no video id, so the YouTube default blocked `www.youtube.com` at
connection level: the ALLOWED video returned no block page (its browser flow was
correctly allowed) and then hung, because the page's own API calls were dropped.
The default is now enforced on browser flows only. Cost: the YouTube **native
app** is socket-only and is no longer default-denied by this provider.

**3. `needRules()` stalls browsing.** With
`askControlProviderForUnknownHosts = true`, pages loaded partially or not at all
with no block page. Every such flow is answered from one **serial** queue doing a
synchronous CNAME walk with a 0.4 s budget, so the Nth host on a page waits
N x 0.4 s while the system's control-verdict timeout expires. Even a safety-floor
page failed — not because the floor was denied, but because its subresources took
that path. The switch is now off. Re-enabling it needs at minimum a concurrent
queue, and more likely CNAME resolution moved off the flow path entirely.

### What the extensions can and cannot write

`PolicyStore.recordsDiagnostics` states that the `NEFilterDataProvider` sandbox
forbids disk writes. Measured: **the data provider's writes to the App Group
never appeared** — `Shared/FlowLog.swift` recorded nothing across several
browsing runs — while `cname_chain_cache_v1`, written by the **control**
provider, did appear. The asymmetry is real: treat the App Group as read-only
from the data provider and write from the control provider or the app.

## Success criterion

PoC A passes when the full §0 workflow works end-to-end on an unsupervised
device in the `.child` posture: block → Request Access → parent approves one
canonical video for a duration → refresh within seconds → plays → other video
stays blocked → auto-expiry. Record the propagation number and the A6 findings in
`docs/DECISIONS.md` (ADR-001) before any further implementation.

## Scaffold map

`apple/poc-contentfilter/` — see its `README.md`:
- `App/` — SwiftUI harness: request `.child` authorization, show filter status,
  edit the local test policy (default deny + allow one id), trigger
  `notifyRulesChanged()`, grant a short temporary approval, and receive the
  blocked-id handoff from remediation.
- `FilterDataProvider/` — `NEFilterDataProvider` subclass: reads the shared
  App-Group policy, normalizes each WebKit flow URL to a canonical YouTube object,
  applies the shared evaluation order, returns allow / drop / **remediate**.
- `FilterControlProvider/` — `NEFilterControlProvider` subclass: owns the
  remediation map and `notifyRulesChanged()`.
- `Shared/` — Swift port of the evaluation order + YouTube normalization that
  mirrors `shared/` (the TypeScript is the spec; the Swift must match it).
- Entitlements + Info.plist for app, data provider, control provider, App Group.
