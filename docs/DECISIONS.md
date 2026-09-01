# Architecture Decision Record (ADR)

Running log of load-bearing decisions and the empirical results that confirm or
overturn them. Each ADR has a status: **Proposed** (design-time, unproven),
**Accepted** (proven on hardware or firmly settled), **Superseded**.

Phase-0 ADRs are mostly **Proposed** — they encode the research conclusion and
name the PoC that must confirm them. Update the status + "Evidence" line when a
PoC produces a result.

---

### ADR-001 — The per-video-approval engine on iOS is `NEFilterDataProvider`, not `NEURLFilter`
**Status:** ACCEPTED — confirmed on hardware 2026-08-31, with the qualification
below. (This said "Proposed (confirm in PoC A)" directly above its own Evidence
block recording that PoC A had been run, which is the one line a reader checks
to know whether the product's central premise is settled.)
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
**Evidence:** _runtime, on hardware, 2026-08-31._ Tests A1-A3 were run on an
iPhone 16 Pro Max (iOS 27.0) with a development-signed build (team
`2BPX4R682U`, App Group `group.family.ajar.filter`). **The central claim holds,
with one qualification that matters.**

Confirmed:

- **Per-video enforcement on the same host works.** `watch?v=9bZkp7q19f0` shows
  the block page; `watch?v=dQw4w9WgXcQ` plays. Same host, opposite verdicts, on
  unmodified iOS with no VPN and no TLS interception.
- **`NEFilterBrowserFlow.url` carries the full URL including the query string.**
  This is the load-bearing fact the whole design rests on, and it is now
  observed rather than inferred: the ALLOW rule matched by video id, and the
  system's own block page rendered the complete
  `https://www.youtube.com/watch?v=9bZkp7q19f0`.
- **The remediation block page renders** with a working Request Access link
  (A3). The round trip back into the app was not exercised.
- **Socket flows expose a hostname and nothing else**, as the scaffold assumed.

**The qualification — per-video control applies only to top-level navigation.**
YouTube is a single-page app. Entering a blocked URL directly is enforced, but
once the child is *inside* YouTube, tapping through to another video swaps it in
over XHR — socket flows, no new WebKit top-level flow — so the filter never sees
the new video id and **other videos play**. Observed directly. This is a property
of the mechanism, not a defect in the scaffold: nothing that only sees browser
flows can enforce per-video policy across in-app navigation. Any product claim
of the form "your child can only watch videos you approved" is **false on iOS
today** for a child who browses within YouTube rather than following links.
Resolving it needs a different lever — blocking the YouTube web app outright and
approving videos through an owned surface, or app-level policy — and that
belongs in a follow-up ADR before anything ships.

**GENERALISED 2026-09-01, after the same behaviour was reported again from a
device.** Everything above was written about YouTube, and reads as a YouTube
qualification. It is not one. The sentence that matters — *nothing that only
sees browser flows can enforce per-URL policy across in-app navigation* — has
nothing to do with YouTube in it, and the limitation applies to **every site
that loads content without a page change**: Reddit, X, Instagram, TikTok, Google
Search, and most modern news sites. Approve one page on any of them and the
site's own in-page navigation moves on without the filter being asked again.

Stated without the YouTube framing, so nobody has to rediscover it a third time:

> On iOS, per-URL enforcement applies to **top-level navigations** — typing an
> address, opening a link in a new tab, following a link that causes a real page
> load. Content a page fetches for itself arrives as socket flows carrying a
> hostname and nothing else, so within a single-page app the product enforces at
> HOST level, not URL level.

The browser extensions on Windows and macOS do not share this limitation: they
see every request with its full URL and a `requestType`, and a content script
catches in-page route changes. So the product's defining capability is
materially weaker on iOS than on the other two platforms, for every SPA rather
than for one site — which is a claim question as much as an engineering one.

A second decision falls out of the same experiment. `youTubeDefault: BLOCK`
cannot be applied to socket flows: they carry no video id, so enforcing it there
made `www.youtube.com` unreachable at connection level and an ALLOWED video
would not stream — it returned no block page and hung. The provider now enforces
the YouTube default on the browser flow only
(`applyYouTubeDefaultToSocketFlows = false`). The cost is explicit: the YouTube
**native app** is socket-only, so it is no longer default-denied by this
provider and must be controlled separately.

**Status stays Proposed, not Accepted.** A4 (propagation timing), A5 (temporary
approval and expiry) and A6 (tamper resistance) have still not been run, and the
`.child` posture itself was never exercised — see below.

**Unexpected, and worth its own investigation:** all of the above was measured
with FamilyControls authorization **`Not Determined`**.
`requestAuthorization(for: .child)` fails on this device because the Apple
Account signed into it is an adult one, yet `NEFilterManager` still enabled and
the filter still enforced. So on iOS 27, holding the
`com.apple.developer.family-controls` **entitlement** was sufficient to run a
content filter; obtaining `.child` **authorization** was not required for
enforcement. This contradicts the reading of TN3134 that this ADR was built on
("under FamilyControls `.child`, sees the full URL"). It does NOT make `.child`
unnecessary — the tamper-resistance the product depends on (A6) is exactly what
`.child` is for — but the dependency is narrower than assumed and should be
re-derived rather than carried forward.

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
present under corrected names. `apple/AjarFilter` now compiles as written.

### ADR-012 — PoC A is build-verified but **not** hardware-verified
**Status:** PARTIALLY CLOSED 2026-08-31 — A1-A3 ran on hardware; A4-A6 have not.
Still open, and still not a decision.

**Closed on 2026-08-31:** the app is development-signed, installed and enforcing
on an iPhone 16 Pro Max (iOS 27.0). A1, A2 and A3 produced real results — see
the Observed Results table in APPLE_CONTENT_FILTER_POC.md and the rewritten
Evidence in ADR-001. Two defects and one design limit were found by running it
that no amount of reading had surfaced: the extensions fail-closed on every flow
because the unsigned-development gate is a per-process static, `needRules()`
stalls browsing from a serial queue doing synchronous DNS, and per-video control
does not survive YouTube's in-app navigation.

**Still open:** A4 (propagation), A5 (temporary approval and expiry) and A6
(tamper resistance) have not run. A6 in particular needs the `.child` posture,
which needs a child or teen Apple Account — see below.
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
| Family Controls entitlement (distribution) | **Resolved (2026-09-01)** — granted. Proven, not just reported: `testflight.yml` run 8 archived `-configuration Release` from `7360050` and UPLOADED, with `com.apple.developer.family-controls` declared in `AjarFilter.entitlements`. codesign refuses an entitlement the profile does not carry, so a successful signed upload is itself the evidence the grant had landed and the distribution profiles carry it. |
| **A child/teen Apple ID on the test device** | **STILL BLOCKED — the new critical path** (see below) |

**The app is signed, installed and running on hardware (2026-08-31).** Xcode
automatic signing against team `2BPX4R682U` registered the device, created all
three App IDs and the `group.family.ajar.filter` App Group, and minted three
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
---

## ADR-016 — An ask is a push, not an email

**Status:** accepted, 2026-09-01.

**Context.** `createRequest` fanned a child's access request out to every
notification endpoint the parent had, and the only endpoint kind with a real
transport is EMAIL. So in practice "your child asked for something" was an email.

Three things are wrong with that, and they compound:

1. **It misses the promise.** The product is "say yes faster", measured in
   seconds, before the impulse wins (`docs/BRAND.md` §5). Email lands in a pile,
   carries no receipt, and arrives whenever the provider gets to it.
2. **It does not survive use.** One message per ask is how an inbox becomes
   something a parent stops opening — which is the same as no notification at
   all, only noisier. A blocked page that retries its sub-resources made this
   concrete enough that request DEDUPE already exists to protect the inbox.
3. **It coupled the core loop to a mail provider.** Not hypothetical: an
   unverified sending domain made a child pressing "Ask to unlock" return a 500
   in production.

**Decision.** Requests do not go by email. `createRequest` skips EMAIL endpoints
— the exact inverse of the rule the password-reset path already applied, and for
the same reason: *a reset link belongs in an inbox, not a push banner*, so an ask
belongs in a push, not an inbox.

Email keeps the account lifecycle, which genuinely wants an inbox: confirming an
address, and resetting a password. Those are one-off, credential-adjacent, and
not measured in seconds.

**What this costs, stated plainly.** The real-time channel is the hub notify that
every parent client long-polls, and it is implemented and fast. APNs and Web Push
are the transports that would reach a parent whose client is closed, and they are
documented adapters rather than implementations (`docs/SECURITY.md`). Until they
land, **a parent is reached while a client is open and not otherwise.**

That is a real gap and it is smaller than it looks — the parent iOS app long-polls
in the background — but it is a gap, and naming it is better than filling it with
a channel that does not fit. Implementing APNs is the work that closes it.

**Consequence for the mail-outage work.** `BestEffortNotifier` stays as defence in
depth, but it is no longer what protects the core loop. A request path that never
touches mail cannot fail because mail is down, which is a better property than
catching the error.

## ADR-017 — The second factor is a passkey, and there is no email way around it

**Status.** Accepted. Implemented in `backend/src/domain/passkeys.ts`,
`backend/src/http/api.ts`, `web/parent/webauthn.js`.

**Context.** A parent's password was the whole of the security on an account
that decides what their children can reach. `docs/ARCHITECTURE.md` §7 had listed
"parent MFA" as part of the design since Phase 0, `docs/SECURITY.md` had not
mentioned its absence at all, and nothing was built. That is the same defect
class this project has now hit four times: *a documented safety that nothing
implements*.

The threat model is what makes the choice, not the checklist. **The adversary
lives in the house.** A child can watch the password being typed, try the ones a
parent reuses across sites, and reach a shared computer where a session may still
be open. And the account is not a mailbox: it approves what a child may reach,
and it can approve silently, with the audit log recording a parent doing it.

**Decision.** A passkey (WebAuthn), required at sign-up, verified as a second
step at sign-in.

- **Not TOTP.** A six-digit code can be read out to whoever asks for it, and the
  person most likely to ask lives in the same house and is good at asking. An
  assertion is bound by the browser to `ajar.family`; there is nothing to say out
  loud and nothing for a lookalike domain to collect.
- **Not "sign in with" anything.** The constraint that has held since Phase 0
  stands: parent authentication is self-contained, no external identity provider.
- **Not hand-rolled.** `@simplewebauthn/server`, pinned exact, is the first and
  only runtime dependency in this repository — see the note at the top of
  `domain/passkeys.ts`. The primitives were never the risk; CBOR over
  attacker-controlled bytes, COSE key marshalling and DER-to-raw conversion are.
- **Its own token kind.** The half-finished sign-in is an `mfa` token, not a user
  token with a flag. A flag makes every route that forgets to check it a way to
  sign in with a password alone; a kind means a route that does nothing special
  refuses it by default.

**And no email fallback.** This is the part worth writing down, because it is the
one that will be argued with the first time a parent is locked out. A recovery
path of "click the link we sent you" makes the second factor exactly as strong as
the parent's inbox — which is to say it stops being a second factor, while
letting this document claim one. A password reset therefore changes the password
and nothing else.

**What it costs, plainly.** Losing every passkey means losing the account.
Synced passkeys (iCloud Keychain, Google Password Manager) survive a lost phone
and are the common case, which is why the console shows `backedUp` per key and
pushes for a second one — but a device-bound passkey on a single lost device is
an account with no way in. **Recovery codes are the intended answer and are not
built yet.** Naming that is better than shipping the email fallback and calling
the problem solved.

Two further gaps are deliberate rather than overlooked: an account created before
this existed still signs in with a password alone (flagged `passkeyRequired`),
and a browser that cannot do WebAuthn can skip enrolment at sign-up. Refusing
either would lock people out with no way in to fix it. Both are stated in
`docs/SECURITY.md` rather than papered over — "every parent has a second factor"
is not a claim this project makes.

## ADR-018 — Per-request enforcement on iOS needs a Safari Web Extension, not data inspection

**Status:** Proposed. This is the follow-up ADR that ADR-001 said was required
"before anything ships", written after the same behaviour was reported from a
device on 2026-09-01.

**The standard, stated by the product owner:** *if we don't handle each request
it's not a real filter*, and *the goal of this product is to handle the
decisions on device*. Both are right, and together they rule out most of the
options.

### What is true today

`NEFilterDataProvider` is asked once per FLOW. A top-level navigation arrives as
a `NEFilterBrowserFlow` carrying the full URL and is enforced per-URL. Everything
a page fetches for itself arrives as a socket flow carrying a hostname and
nothing else (ADR-001, measured on hardware). So inside any single-page app —
Reddit, X, Instagram, TikTok, Google Search, YouTube — the product enforces at
**host** level. That is not URL filtering, and calling it that would be a claim
the code does not support.

### The fix that does NOT work, and was proposed twice before being checked

Returning `.filterDataVerdict(...)` from `handleNewFlow` and implementing
`handleOutboundData` to inspect each request **cannot recover a URL from a
socket flow**. Those bytes are TLS ciphertext. Reading them requires TLS
interception, and this architecture rules that out unconditionally
(ARCHITECTURE.md: "**No TLS interception** anywhere on Apple") — a commitment
worth keeping, because the alternative is installing a root CA on a child's
device and becoming a man in the middle of their entire life online.

Data inspection is therefore not a smaller version of the right answer. It is
the wrong answer, and proposing it twice without checking what those bytes
contain is the mistake this entry exists to stop being repeated.

### The mechanism that can

**A Safari Web Extension on iOS.** Supported since iOS 15. The repository had
the web resources for one — and, it turned out, no packaging on EITHER platform:
no Xcode project, no `Info.plist`, no `SFSafariWebExtensionHandler`, so nothing
was installable anywhere. `docs/APPLE_ACCOUNT_SETUP.md` had recorded that gap
and it had simply never been closed. It is now `apple/AjarSafari`, one target
across both platforms, doing exactly this job:
`webNavigation.onBeforeNavigate` for navigations, a content script for
`pushState` route changes, `tabs.update` to redirect a blocked navigation to our
own block page. It evaluates **locally**, against the cached signed snapshot,
with no per-request network call — which is the on-device requirement, not a
compromise against it.

ARCHITECTURE.md considers Safari Web Extensions **only for macOS**. iOS was
never considered, and that omission is why the iOS design has no mechanism that
can meet the standard. The content filter is not that mechanism and cannot be
made into one.

### What this still does not give, stated plainly

A Safari Web Extension covers **Safari**. A native app — the YouTube app, any
app with its own network stack — produces socket flows only and stays
host-level. There is no mechanism on iOS that gives per-request enforcement
inside a native app without a VPN or TLS interception, both of which this
architecture excludes.

So the coherent iOS design is three layers, and two of them do not exist:

| Layer | Gives | Status |
|---|---|---|
| Safari Web Extension | per-request, on-device, in Safari | **BUILT** — `apple/AjarSafari`, one target for iOS + macOS |
| ManagedSettings application policy | a native app blocked outright, so "host-level inside it" stops mattering | **missing** — named as the answer in FilterDataProvider.swift and ADR-014, never built |
| `NEFilterDataProvider` | host-level backstop for everything else, plus the safety floor | exists |

The content filter is the backstop, not the product. Today it is being asked to
be the product, which is why it keeps coming up short.

### Consequences

- The claim "URL-level filtering" is true on iOS **for top-level navigations**
  and inside Safari once the extension exists. It is not true inside a native
  app, and the marketing must keep saying so.
- PoC B (macOS Safari Web Extension) should be re-scoped to cover iOS as well,
  since one extension target can serve both.
- Nothing here changes the on-device posture: every layer above evaluates the
  signed snapshot locally. No design in this ADR sends a URL anywhere.

### Amendment (2026-09-01) — packaged is not installed, and installed is not working

Two corrections after the target existed:

**The extension had no way to get policy.** `SafariWebExtensionHandler` answered
every message with `native-host-not-implemented`, and `background.js` reached for
`runtime.connectNative("com.example.youtubeguard.host")` — a Chrome/Firefox
long-lived port, aimed at a placeholder id, **in a browser that does not
implement `connectNative` at all**. The only working policy source was the
options-page backend enrollment, which on a real install would mean enrolling one
device twice and holding two device identities for one child. So the extension
would install, hold no policy, and answer every request from the no-policy
fallback. "Compiles and is installable" was not "working".

Fixed by making the containing app the policy source over Safari's one-shot
`sendNativeMessage`: the handler reads the signed snapshot `AjarFilter`'s app
already wrote to the shared App Group `group.family.ajar.filter`, and the
JavaScript re-verifies the Ed25519 signature before trusting a field of it. One
enrollment, one device identity, one snapshot, two enforcement surfaces. The
native side passes bytes; it does not vouch for them, and it cannot replace a
pinned key. `apple/check-app-group.mjs` runs in CI because the handler cannot
import `PolicyStore` and therefore duplicates the group name and four key names,
and every way of drifting them is silent — a drifted copy reads nothing and looks
exactly like a device nobody enrolled, which is the one state that allows
everything.

**The no-policy fallback was shaped like YouTube.** It failed CLOSED for YouTube
and OPEN for everything else, so on an enrolled device that had lost its policy
every site but one was wide open and deleting the cached snapshot was the bypass.
What the absence of policy means has nothing to do with which site is being
visited. It now mirrors `PolicyStore.state()`: never enrolled → allow (we do not
claim to filter this device); enrolled and policy missing or unverifiable →
block.

Still true, and still the honest limit: CI compiles this target, it does not run
Safari. Whether iOS Safari honours the `webNavigation` + content-script approach
is unmeasured and needs a device.

### Amendment 2 (2026-09-01) — one app on iOS, and it now has a way to ship

The extension began as a separate app on both platforms. On iOS that was the
wrong shape: a parent installed two apps, enrolled the same device twice, and the
child carried two device identities. It also forced the duplication above — the
shim could not import `PolicyStore` across Xcode projects, so it kept string
copies of the App Group name and four storage keys.

The extension sources now live at `apple/SafariExtension/` and are compiled by
two hosts:

| Platform | Container |
|---|---|
| iOS / iPadOS | the filter app itself, as its `SafariExtension` target |
| macOS | `apple/AjarSafari`, its own app |

macOS cannot join the iOS host: there is no FamilyControls there, and a macOS
content filter is a system extension with a different container, entitlement and
distribution channel. One copy of the extension, two containers, no second
enrolment on the platform that matters most.

Consequences:

- The shim reads policy through `PolicyStore`. `apple/check-app-group.mjs` now
  enforces the *absence* of the old string copies rather than their agreement.
- The extension ships in the app `testflight.yml` already uploads, so it inherits
  a distribution path instead of needing one. It had none: CI compiled it and
  nothing archived, signed or uploaded it.
- **It needs no restricted entitlement of its own** — only the App Group. Family
  Controls gates the app's distribution, not this target's compilation.
- The filter app's main screen now links to the enable steps and says plainly
  that without the extension Ajar can close a whole site but not one page of it.
  iOS gives an app no way to *check* whether its Safari extension is enabled
  (`SFSafariExtensionManager` is macOS-only), so that is a standing prompt, never
  a status tick.

