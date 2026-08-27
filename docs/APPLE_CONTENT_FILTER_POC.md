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

### A6 — What the child can/can't disable under `.child`
With `.child` active, attempt as the child: delete the app; sign out of iCloud;
disable the filter in Settings; install a configuration profile / third-party DoH
app; add a VPN. Record which are blocked vs. allowed. (Expected: app-delete and
iCloud-signout blocked; DNS/VPN behavior undocumented → this is the empirical
point.)

## Build status (verified 2026-08-27)

| Item | Result |
|---|---|
| `xcodegen generate` → `ParentFilterPoC.xcodeproj` | OK (XcodeGen 2.46.0) |
| App + 2 extensions compile/link, `-destination generic/platform=iOS` | **BUILD SUCCEEDED**, arm64, 0 warnings |
| `FilterDataProvider.appex` `NSExtensionPointIdentifier` | `com.apple.networkextension.filter-data` |
| `FilterControlProvider.appex` `NSExtensionPointIdentifier` | `com.apple.networkextension.filter-control` |
| Both `.appex` embedded in `ParentFilterPoC.app/PlugIns/` | OK |
| SDK API corrections needed | 3 — see ADR-011 |
| Code-signed / installed / launched on a device | **NO — blocked, see ADR-012** |

Reproduce (compile check, no signing identity needed):

```sh
cd apple/poc-contentfilter && xcodegen generate
xcodebuild -project ParentFilterPoC.xcodeproj -scheme ParentFilterPoC \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO clean build
```

For a real device build, drop `CODE_SIGNING_ALLOWED=NO` and pass
`DEVELOPMENT_TEAM=<your team id>`.

## Observed Results (NOT YET RUN — requires hardware, see ADR-012)

| Test | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| A1 block BLOCKED_VIDEO (all URL forms) | Block page | | | |
| A1 allow ALLOWED_VIDEO plays + streams | Plays | | | |
| A2 full URL+query visible (Safari) | Full URL | | | |
| A2 bare URLSession exposure | (hostname only?) | | | |
| A3 remediation page + Request Access | Renders, round-trips | | | |
| A4 add-allow propagation time | ≤ few seconds | | | ___ s |
| A4 remove-allow propagation time | ≤ few seconds | | | ___ s |
| A5 temp grant plays then auto-expires | Blocks at expiry | | | |
| A5 offline expiry (airplane mode) | Blocks at expiry | | | |
| A5 clock/timezone tamper does not extend | No extension | | | |
| A6 app delete under `.child` | Blocked | | | |
| A6 iCloud sign-out under `.child` | Blocked | | | |
| A6 disable filter in Settings | ? | | | **key unknown** |
| A6 DNS/VPN/profile bypass | ? | | | **key unknown** |

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
