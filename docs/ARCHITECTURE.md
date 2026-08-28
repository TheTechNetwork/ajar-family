# ARCHITECTURE — Cross-Platform Parental URL Filtering Platform (Phase 0)

> Status: **Phase 0 research complete.** This document records what the current
> official platform APIs can and cannot do, the resulting architecture, and the
> empirical questions that must be answered by the proofs-of-concept **before**
> any production implementation. It deliberately does not hand-wave platform
> limits. Where a claim is load-bearing it carries an official-documentation
> citation; where a capability is unproven it is listed in
> [§13 Unresolved](#13-unresolved--must-be-proven-empirically) and the relevant
> `docs/*_POC.md`.

## 0. The one question Phase 0 must answer

> **Can a child hit a blocked YouTube video, request it, have a parent approve
> _only that canonical video_ for a chosen duration, refresh within seconds, and
> play it while every other unapproved YouTube video stays blocked — without a
> VPN or TLS interception on Apple platforms, and without enterprise device
> management (MDM)?**

Everything below is organized around proving that workflow first, on the
smallest surface (iOS Safari), then extending the _same shared policy model_ to
macOS and Windows with platform-appropriate enforcement.

---

## 1. Executive summary of findings

| Question | Answer |
|---|---|
| Is there a native Apple API that filters **full URLs** (path + query) without a VPN/MITM? | **Yes** — `NEURLFilter` (NetworkExtension URL Filter), iOS/macOS **26.0**. But it is **blocklist-only** and cannot express "default-deny a domain, allow specific URLs." |
| Can `NEURLFilter` implement the headline requirement (default-deny YouTube, approve one video)? | **No.** Its dataset means "block these." Putting `youtube.com` in it blocks _all_ of YouTube with no override. It is the right tool for large **blocklists** (adult/malware/category), the wrong tool for allow-one-video. |
| What Apple API _can_ do allow-one-video with a Request-Access UX and seconds-level propagation? | The **classic `NEFilterDataProvider` content filter** under **FamilyControls `.child`** authorization. WebKit/Safari flows expose the **full URL**; the control provider runs arbitrary allow/deny against a dynamic local allowlist; `notifyRulesChanged()` applies updates in seconds; it has a **remediation "Request Access" block page**. **This is PoC A and the core of the product on iOS.** |
| Does that work on an ordinary consumer iPhone? | Only on an **unsupervised device whose child is signed in with a real child Apple ID inside the parent's Family Sharing group**, with `requestAuthorization(for: .child)` approved by the parent. Not on a self-controlled adult account (`.individual` grants no protection). See [§4](#4-the-apple-child-account-requirement-read-this-carefully). |
| macOS Safari per-video? | Hardest Apple gap: native-macOS classic filter is **hostname-only**, and `NEURLFilter` can't default-deny. Primary mechanism is a **Safari Web Extension** (sees full URLs in Safari). **Unresolved — PoC B. Never block Safari to compensate.** |
| Windows per-video? | No OS layer sees an HTTPS path. **Start with a policy-installed browser extension** (Chrome/Edge/Firefox) doing full-URL enforcement + a hardened service for anti-tamper/policy. **TLS interception is a fallback requiring empirical justification, not the default.** PoC C. |
| Does anything survive a determined, technical child? | Only with the OS's own protections and a **standard (non-admin) child account**. We document honestly what is enforceable vs. bypassable per platform ([§9](#9-tamper-resistance--enforceable-vs-bypassable)). We do **not** claim tamper-proofing the OS doesn't provide, and we do **not** use stealth/rootkit techniques. |

---

## 2. Product-shaped architecture (the modular core)

The platforms differ in _enforcement_; they share _everything else_. The shared
core is the product; the per-platform enforcement engines are adapters.

```
                         ┌───────────────────────────────────────────┐
                         │                 CLOUD BACKEND               │
                         │  TypeScript · SQLite/D1 · REST + push       │
                         │                                             │
  Parent iOS app ◀──────▶│  Auth (SIWA/passkey/MFA) · Family graph     │
  (Requests/Approvals)   │  Policy + rules + temporary approvals       │
                         │  Access requests · Approval decisions       │
      APNs push ◀────────│  Policy versioning + signed snapshots       │
                         │  APNs abstraction · Audit log               │
                         └───────▲───────────────────────▲─────────────┘
                                 │ signed, versioned      │
                                 │ policy snapshots        │
        ┌────────────────────────┼─────────────────────────┼─────────────────────┐
        │                        │                          │                     │
 ┌──────▼───────┐        ┌───────▼────────┐         ┌───────▼───────┐     ┌───────▼────────┐
 │  iOS/iPadOS  │        │     macOS       │         │    Windows    │     │  (shared libs) │
 │ child agent  │        │  child agent    │         │  service +    │     │ policy-model   │
 │              │        │                 │         │  browser ext  │     │ youtube-norm   │
 │ NEFilterData │        │ Safari Web Ext  │         │ MV3 ext (URL) │     │ (source of     │
 │ Provider +   │        │ (per-URL) +     │         │ + hardened    │     │  truth for     │
 │ FamilyCtrls  │        │ NEFilterData    │         │ service +     │     │  evaluation &  │
 │ .child       │        │ (socket/host) + │         │ policy/anti-  │     │  canonical     │
 │ + NEURLFilter│        │ NEURLFilter     │         │ tamper. MITM  │     │  YT ids)       │
 │ (blocklist)  │        │ (blocklist)     │         │ = fallback    │     │                │
 └──────────────┘        └─────────────────┘         └───────────────┘     └────────────────┘
```

**Shared across all platforms (defined once, in `shared/`):**

- **Policy model & evaluation order** — `shared/policy/policy-model.ts`. Targets
  `DOMAIN | URL | URL_PATTERN | YOUTUBE_VIDEO | YOUTUBE_CHANNEL | YOUTUBE_PLAYLIST | CATEGORY | APPLICATION`;
  actions `ALLOW | BLOCK`; scopes `FAMILY | CHILD | DEVICE`. Supports both
  default-allow and default-deny, with an **independent YouTube default** so the
  family can run default-deny YouTube while the rest of the web is default-allow.
- **YouTube canonicalization** — `shared/youtube/youtube-normalize.ts`. Every
  adapter reduces an observed URL to a canonical `YOUTUBE_VIDEO:<id>` (or
  channel/playlist) object **before** consulting policy. See [§6](#6-youtube-is-a-first-class-content-type).
- **Family model, request workflow, approval system, sync protocol** — backend
  ([§7](#7-backend), [§8](#8-policy-synchronization)).

**Filtering philosophy — evaluation order (highest precedence first),
implemented in `evaluate()`:** device rule → child rule → **temporary
approval** → exact-URL allow → exact-URL block → YouTube video/playlist/channel
→ domain → category → global default. This is the ordering the brief mandates,
and it is the single source of truth every adapter must reproduce (or compile a
documented subset of).

**Categories make the engine general.** "Block all social media" (or adult /
gaming / gambling / streaming / shopping / messaging) is **one `CATEGORY` rule**
whose action applies to every domain in that category — the mechanism behind the
product's "restrict 90% of the internet, approve exceptions" posture. Because
`CATEGORY` sits below the URL / DOMAIN / YOUTUBE_* tiers, a parent can carve out
a single site, page, or video _above_ a blanket category block, and a temporary
approval overrides it for its window. The category → domain map travels **inside
the signed `DevicePolicySnapshot`** (`snapshot.categories`), so every platform
evaluator enforces it offline and adding a site is a data-only change — no code
ships to any client. The bundled `DEFAULT_CATEGORY_DOMAINS`
(`shared/categories/category-data.ts`) is a **starter seed**; a production
deployment swaps in a maintained categorization feed (millions of domains — on
Apple that is the NEURLFilter Bloom/PIR blocklist path, [§3](#3-apple-url-filtering--capabilities-and-hard-limits)).

---

## 3. Apple URL filtering — capabilities and hard limits

Two distinct NetworkExtension mechanisms matter, and they are **complementary,
not alternatives**.

### 3.1 `NEURLFilter` (NetworkExtension URL Filter) — iOS/macOS 26

- **Types**: `NEURLFilterManager` (app-side control singleton), the
  `NEURLFilterControlProvider` protocol (implemented in an **app extension** on
  _both_ iOS and macOS — never a system extension), `NEURLFilterPrefilter` (the
  Bloom-filter blob), and `NEURLFilter.verdict(for:)` (the "participation API"
  for non-WebKit/URLSession apps).
  Docs: <https://developer.apple.com/documentation/networkextension/url-filters>,
  <https://developer.apple.com/documentation/networkextension/neurlfiltermanager>.
  Entitlement: existing `com.apple.developer.networking.networkextension` with
  the new value **`url-filter-provider`**
  (<https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension>).
- **How it decides** (WWDC25 session 234, "Filter and tunnel network traffic
  with NetworkExtension", <https://developer.apple.com/videos/play/wwdc2025/234/>):
  1. On-device **Bloom filter** (you build it; FNV-1a 32 + MurmurHash3 32,
     double-hashing) quickly clears URLs not in the set — **no network**.
  2. On a Bloom **hit**, a **Private Information Retrieval (PIR)** query to
     _your_ vendor-hosted PIR server, tunneled through **Apple's Oblivious HTTP
     relay** so neither Apple nor you sees the URL or the client IP.
  - Reference server stack (Apple, open-source, Apache-2.0):
    `apple/swift-homomorphic-encryption` (BFV + Keyword PIR, `PIRProcessDatabase`)
    and `apple/pir-service-example` (`PIRService` + Privacy Pass). Same stack as
    Live Caller ID Lookup.
- **🔴 Blocklist-only.** The dataset is "URLs you want to **block**"; every value
  is the placeholder integer `1`. There is **no allow verdict you can author, no
  exceptions, no per-rule priority, and one dataset per app.** URL requests are
  expanded by **sub-URL enumeration** (~48 keys: domain hierarchy × path
  hierarchy × trailing slash × `:443` × fragment) and each is matched.
  **Consequence:** putting `youtube.com` in the set blocks _all_ of YouTube,
  irreversibly; you cannot carve out an allowed video. "Default-deny domain X
  except URL Y" is **not expressible.**
- **Query-string matching: yes** (Apple Platform Deployment marks path + query
  filtering "Supported": <https://support.apple.com/guide/deployment/filter-content-dep1129ff8d2/web>).
  It can distinguish `?v=ABC123` from `?v=XYZ456` **if the whole query string
  matches**. On **iOS 26** the enumerator treats the entire query as one unit,
  so a real navigation carrying extra params (`&t=30s&pp=…`, which YouTube always
  adds) will **not** match an exact `?v=ABC123` dataset entry. **iOS 27 (beta)**
  adds `ParsingConfiguration.QueryOptions(parameters: ["v"])` to extract only
  `v`, which is what makes robust per-video _blocklisting_ practical — but the
  Bloom builder must emit dataset keys in the exact same shape.
- **Propagation**: Bloom prefilter refresh floor is **2700 s (45 min)**, default
  24 h, with **no push/force-reload** for the prefilter. PIR verdicts change
  faster (`resetPIRCache()` + `refreshPIRParameters()` + server hot-reload) —
  **but your app must run to call `resetPIRCache()`**; there is no server→device
  trigger.
- **Coverage**: WebKit + URLSession are filtered automatically, system-wide.
  **Chrome/Edge/Firefox/Electron on macOS use their own socket stacks and are
  NOT filtered** unless they voluntarily call `NEURLFilter.verdict(for:)` (no
  evidence Chromium/Mozilla have adopted it). On iOS those browsers wrap
  `WKWebView` and inherit WebKit filtering.
- **Fail mode**: `shouldFailClosed` defaults to **false** (fail-open); set
  **true** for parental control. Bloom still works offline; only a Bloom-hit
  cache-miss reaches the fail branch.
- **No block-page/remediation API**, and by privacy design the app is **never
  told what was blocked** (iOS 27-beta `reportEndpoint` reports only the matched
  _dataset entry_, supervised-only, unattributable). So the Request-Access UX
  **cannot** be built on `NEURLFilter`.
- **Distribution gate**: the entitlement is enableable in Xcode (TN3134 lists no
  supervision restriction for URL-filter providers,
  <https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment>),
  but the **OHTTP relay / PIR server must be validated by Apple** via CloudKit
  Console → Identity & Trust before _any_ non-development distribution.
  **Development-signed builds skip the relay**, so the mechanism is testable on a
  device immediately.

**Role in our architecture:** `NEURLFilter` is the **supplementary large-scale
blocklist** engine (adult / malware / known-proxy / category domains and
specific bad videos). It is **not** the per-video-approval engine. Validated in
**PoC D** and deliberately not over-invested in during Phase 0.

### 3.2 Classic `NEFilterDataProvider` content filter — the per-video engine on iOS

- **Types**: `NEFilterDataProvider` (data path), `NEFilterControlProvider`
  (rules/remediation + `notifyRulesChanged()`), `NEFilterManager`.
  Docs: <https://developer.apple.com/documentation/networkextension/nefilterdataprovider>.
- **HTTPS visibility**: `NEFilterFlow.url` is **non-nil only for WebKit browser
  flows** (`NEFilterBrowserFlow`); socket flows expose hostname/SNI only.
  <https://developer.apple.com/documentation/networkextension/nefilterflow/url>.
  So on iOS **Safari (and every WKWebView-based browser) gives the control
  provider the full URL** — enough to allow one video and block another on the
  same host.
- **Deployment on unsupervised iOS** (TN3134): permitted for "apps using Screen
  Time APIs" — concretely, add the **Family Controls** capability, run on a
  device signed in as an **under-18 child** of an iCloud family, and request
  **`.child`** authorization. This is the consumer path; no MDM, no supervision.
- **Dynamic allowlist + seconds-level updates**: `NEFilterControlProvider`
  maintains rules and calls `notifyRulesChanged()`; the data provider consults
  the shared, signed policy cache (App Group) to allow/deny each flow.
- **Remediation "Request Access" page**: `NEFilterControlProvider.remediationMap`
  + `NEFilterNewFlowVerdict.remediateVerdict(withRemediationURLMapKey:remediationButtonTextMapKey:)`
  render a block page in the WebKit view. **SDK-header fact (`NEFilterProvider.h`,
  confirmed while building PoC A, ADR-011):** the remediation URL **must use the
  `http`/`https` scheme** — so the Request-Access page is a **remotely hosted page
  (served by our backend), not an app-local screen**, and the `NE_FLOW_URL`
  substitution token carries the blocked URL into it. Getting from that page back
  into the containing app to create the request needs a **universal link or custom
  URL scheme**. The block → Request-Access flow on iOS Safari must account for this
  hosting + return-path dependency; it is not a purely on-device hop. (`remediationMap`
  is also typed `[String:[String:NSObject]]`, so values are bridged `as NSString`.)
- **Anti-tamper anchor**: FamilyControls `.child` "prevents the child user from
  deleting the app that provides parental controls" and blocks iCloud sign-out
  (<https://developer.apple.com/documentation/familycontrols>). This is the only
  strong OS-provided anti-circumvention anchor available to a consumer app, and
  it exists **only on iOS/iPadOS**.

**Role:** **PoC A and the iOS core** — the mechanism that actually satisfies §0.

### 3.3 What is _not_ the answer on Apple

- **No VPN** (`NEVPNManager` / packet tunnel). App Review 5.4 permits parental
  control apps "from approved providers" to use it, but the native URL filter +
  content filter satisfy the requirement without routing traffic, so a VPN is a
  documented fallback only, never the default. We do not add a VPN on Apple
  unless a PoC proves the native path cannot meet a concrete requirement.
- **No TLS interception** anywhere on Apple.
- **Not ManagedSettings `WebContentSettings`** as the URL engine — it is
  domain-level and capped at **50 domains + 50 exceptions**
  (<https://developer.apple.com/documentation/managedsettings/webcontentsettings>).
  Useful as an auxiliary coarse layer (and it disables Safari private browsing),
  not as the per-URL engine.

---

## 4. The Apple child-account requirement (read this carefully)

Be precise with families; do not claim protection the OS does not provide. There
are **three distinct Apple postures**, and only one gives real anti-tamper:

| Posture | How it arises | Anti-tamper | Per-video filtering |
|---|---|---|---|
| **Unsupervised device + FamilyControls `.child`** | Child signed in with a **real child Apple ID** that is a member of the parent's **Family Sharing** group; parent approves `requestAuthorization(for: .child)` | **Yes** — app can't be deleted, iCloud can't be signed out (FamilyControls). Content filter is unlocked on unsupervised iOS (TN3134). | **Yes** on iOS Safari via `NEFilterDataProvider` (PoC A) |
| **Self-controlled / adult account (`.individual`)** | Any adult approves on their own device via Face/Touch ID | **No** — self-restriction only; the same person can revoke it | Filter works while enabled, but the user can disable it |
| **Supervised / MDM device** | Device enrolled in MDM (Apple Configurator / Apple Business/School Manager) | Strongest, but this is **not** the consumer product | Full content-filter + MDM URL-filter config; out of scope for MVP |

**Product rules that follow:**

- The consumer MVP targets the **`.child` posture** on iOS/iPadOS. The child
  agent must detect and clearly show whether `.child` authorization is active,
  and must **not** advertise tamper resistance in the `.individual` posture.
- **macOS has no FamilyControls.** There is no app-deletion/iCloud lock on macOS.
  The macOS posture relies on a **standard (non-admin) account** + a notarized
  system extension; an **admin** child defeats it. This must be stated to the
  parent, not glossed.
- We surface these distinctions in-product ("technically enforced" vs. "removable
  by the device owner" vs. "requires a managed device").

---

## 5. macOS — do not block Safari

**Constraints:** native-macOS `NEFilterDataProvider` is effectively hostname-only
(`NEFilterBrowserFlow`/full-URL/remediation are not annotated for native macOS),
and `NEURLFilter` cannot default-deny. So neither native NetworkExtension path
gives per-video control of Safari.

**Direction (unresolved — PoC B):** a **Safari Web Extension** is the primary
per-URL mechanism on macOS — it runs inside Safari, sees full URLs, and can
block/redirect to a Request-Access page, consuming the same shared policy model.
Layer `NEURLFilter` for the category blocklist and a `NEFilterDataProvider`
**system extension** for socket/hostname enforcement and
`disableEncryptedDNSSettings` (macOS 15+) as an anti-DoH lever.

**Non-negotiable:** **Safari must remain fully functional.** We never "solve"
macOS by blocking Safari. It is acceptable for macOS (and Windows) to enforce via
browser extensions while iOS uses native content filtering — as long as all
consume the same shared policy model and produce identical decisions.

Chrome/Edge/Firefox on macOS are not covered by any native Apple filter; they are
covered by their own force-installed extensions (same engine as Windows, §Windows)
where policy install is possible, and otherwise documented as a gap and optionally
handled by app-availability controls.

---

## 6. YouTube is a first-class content type

YouTube resources are **policy objects keyed by canonical id**, never raw URL
strings. `shared/youtube/youtube-normalize.ts` reduces every recognized form to a
canonical object:

| Input form | Canonical object |
|---|---|
| `youtube.com/watch?v=ABC123` (+ any extra query params) | `YOUTUBE_VIDEO: ABC123` |
| `youtu.be/ABC123` | `YOUTUBE_VIDEO: ABC123` |
| `youtube.com/shorts/ABC123` | `YOUTUBE_VIDEO: ABC123` (kind=shorts) |
| `youtube.com/embed/ABC123`, `/v/ABC123`, `youtube-nocookie.com/embed/…` | `YOUTUBE_VIDEO: ABC123` |
| `m.youtube.com/watch?v=ABC123` | `YOUTUBE_VIDEO: ABC123` |
| `youtube.com/watch?v=ABC123&list=PL…` | video + `YOUTUBE_PLAYLIST: PL…` |
| `youtube.com/playlist?list=PL…` | `YOUTUBE_PLAYLIST: PL…` |
| `youtube.com/channel/UC…`, `/@handle`, `/c/name`, `/user/name` | `YOUTUBE_CHANNEL: …` |

Parent rules operate on these objects: allow/block a **video**, **channel**, or
**playlist**, or allow/block YouTube **entirely**. The evaluation order guarantees
that **approving one video does not widen** to the channel, recommendations,
related videos, search, comments, Shorts, or arbitrary navigation — the video
rule matches only that canonical id; everything else falls through to the YouTube
default (deny).

**Minimum supporting resources for an approved video to play.** A default-deny
YouTube policy must still allow the resources the player needs, or an approved
video spins forever. Documented in `YOUTUBE_PLAYBACK_SUPPORT_HOSTS`:
`www.youtube.com` (InnerTube `/youtubei/v1/player`, base JS), `youtubei.googleapis.com`,
`s.ytimg.com` / `i.ytimg.com` (player JS/CSS, thumbnails), `yt3.ggpht.com`,
`jnn-pa.googleapis.com` (player attestation), `fonts.gstatic.com`, and crucially
**`*.googlevideo.com`** (the media CDN). `googlevideo.com` URLs are opaque and
per-session — they cannot be tied to a video id from the URL — so an adapter must
allow that host **while any video is currently approved on the device** and rely
on the **watch-page gate** (which _is_ per-video) to actually control access.
This is a deliberate, documented limitation; do **not** block `googlevideo.com`
for an otherwise-approved video.

The per-adapter mechanics of enforcing a canonical-id decision differ:
`NEFilterDataProvider` inspects the WebKit flow URL; the Safari/MV3 extensions
inspect the navigation URL and in-page SPA route changes (which never hit the
network) and redirect to a block page. All call the same `normalizeYouTube()`.

---

## 7. Backend

- **Stack**: TypeScript (Node + Cloudflare Workers). **Durable store: SQLite —
  `node:sqlite` on a Node host, Cloudflare **D1** on Workers** — behind one
  `Repository` interface (this supersedes the originally-sketched PostgreSQL:
  D1 fits Workers with no separate DB server, and the self-host ships as one
  binary with an embedded SQLite file). **REST** for CRUD + **long-poll** for
  immediate policy-change push (cross-runtime, no streaming); **Redis only** where
  a concrete need appears (rate-limit buckets, fan-out at scale) — not by default.
  Compose for local dev. No hard vendor lock-in; deployable to AWS/GCP/Azure/Fly/
  Cloudflare. The one exception is the Apple **PIR/OHTTP** infrastructure for
  `NEURLFilter`, which has Apple-specific hosting requirements (documented in
  `docs/APPLE_URL_FILTER_POC.md`) and is a separate, optional service.
- **Core data model** (per the brief): `User`, `Family`, `FamilyMembership`
  (role `OWNER | PARENT | LIMITED_GUARDIAN`), `Child`, `Device`, `Policy`,
  `PolicyRule`, `TemporaryRule`, `AccessRequest`, `ApprovalDecision`,
  `DevicePolicyVersion`, `AuditEvent`, `NotificationEndpoint`. Rule targets /
  actions / scopes exactly as in `shared/policy/policy-model.ts`. All timestamped
  UTC with audit history.
- **Roles**: `OWNER` (invite/remove parents, billing, devices, all policies);
  `PARENT` (approve requests, manage child policies, create temporary approvals);
  `LIMITED_GUARDIAN` (approve/deny requests + see assigned children only). Every
  `ApprovalDecision` records the deciding parent (server-authoritative).
- **Access-request workflow**: child device posts a signed request (child id,
  device id, canonical target, optional reason) → server notifies all authorized
  parents via APNs → parent approves with a **scope** and **duration** → server
  writes an `ApprovalDecision` + a `TemporaryRule`, bumps the policy version, and
  pushes the change. Approval scope choices default to the **narrowest useful**
  permission (this request / this exact URL / this video / this channel / this
  domain / this device / this child / whole family) and never auto-broaden.
- **Security**: Sign in with Apple / passkeys / email; parent MFA; per-device
  keypair generated at enrollment; short-lived access tokens + refresh rotation;
  signed device commands with replay protection; rate limiting; full audit log.
  **Approvals are server-authoritative and cryptographically signed** so a child
  device cannot fabricate one.

## 8. Policy synchronization

- **Versioned**: every policy change increments a monotonic version. Devices ask
  "what changed since vN" for **incremental** updates, with **full** sync as
  fallback. No full-database download on every change.
- **Signed offline cache**: each device holds an **Ed25519-signed
  `DevicePolicySnapshot`** (`shared/policy/policy-model.ts`). Rules and active
  temporary approvals keep working offline; temporary approvals expire locally
  against a **server-signed UTC `expiresAt`**, enforced with a **monotonic clock**
  for durations and **clock-rollback detection** (a child changing the clock —
  or, on Windows, the time zone — must not extend a grant; see §Offline/Time).
- **Immediate push on approval**: an approval triggers a WS/SSE notification so
  the child device refreshes within seconds. The device then applies the change
  via its adapter's fast path (`notifyRulesChanged()` on iOS; extension
  messaging on macOS/Windows; `resetPIRCache()` for the NEURLFilter layer).
- **Mapping to NEURLFilter Bloom/PIR**: standing category blocklist changes go
  into the next Bloom rebuild (≤45 min) + PIR hot-reload; time-critical
  per-video changes are handled by the content-filter/extension layer, **not** by
  the Bloom/PIR layer, precisely because the Bloom prefilter cannot update in
  seconds.

**Fail strategy**: fail-**closed** for protected categories and explicit blocks
where technically reasonable (`shouldFailClosed = true` on `NEURLFilter`; deny on
signature/verification failure in adapters); fail-**open** for ordinary network
errors so a flaky connection never bricks the computer. Documented per adapter.

---

## 9. Tamper-resistance — enforceable vs. bypassable

We use documented OS security mechanisms only; **no stealth persistence, no
rootkit/hooking, transparent parent/admin ownership.** Honest matrix:

| Mechanism | iOS `.child` (unsupervised) | iOS `.individual` | macOS standard acct | macOS admin acct | Windows standard acct | Windows admin acct |
|---|---|---|---|---|---|---|
| Remove/disable the filter | **Blocked** (app-delete blocked) | User can disable | Needs admin to remove app/ext | **Bypassable** | Service stop **blocked** (default SD) | **Bypassable** |
| Uninstall the agent | **Blocked** | User can | **Blocked** (needs admin) | Bypassable | **Blocked** | Bypassable |
| Change DNS to bypass | Soft (DNS is defense-in-depth only) | Soft | Soft; `disableEncryptedDNSSettings` on macOS 15+ | Bypassable | Policy-locked; block 3rd-party DoH | Bypassable |
| Change clock/timezone to extend grant | Blocked (no user clock change) | — | Blocked (clock); TZ change possible → use UTC+monotonic | Bypassable | Clock blocked; **TZ changeable** → use UTC+monotonic | Bypassable |
| Use another browser | Inherits WebKit filtering | — | Needs its own ext / app-control | Bypassable | Force-installed ext + AppLocker publisher deny | Bypassable |

**Conclusions:** the only strongly-enforced consumer posture is **iOS `.child`**.
**macOS and Windows require a standard (non-admin) child account**; an admin
child defeats consumer-grade protection on both, and the agent must detect
admin-child and alert the parent rather than pretend otherwise. (PPL/ELAM on
Windows is the only thing resisting a local admin and is out of reach for a small
vendor; documented in `docs/WINDOWS_FILTER_POC.md`.)

---

## 10. DNS, VPN, and privacy posture

- **DNS is complementary, never the URL mechanism.** Use encrypted DNS /
  DNS filtering as a first coarse layer for malware/adult/known-proxy/phishing
  domains and to **suppress ECH** on Windows (so SNI stays visible for the
  blocklist layer). Prevent trivial custom-DoH bypass where platform controls
  permit. It does not distinguish URLs and never gates per-video decisions.
- **VPN/local proxy**: avoided on Apple (native path suffices). On Windows a
  local MITM proxy is a **fallback** requiring justification (§Windows); if used,
  traffic stays **on-device** — we never route child traffic through our cloud to
  inspect URLs.
- **Privacy**: minimize collection. Store the **blocked request that needs
  approval** + **decision metadata**, not full browsing history. `NEURLFilter` is
  privacy-preserving by construction (PIR + OHTTP: neither Apple nor we see
  browsing). Activity reporting is opt-in. COPPA / GDPR-K / Apple child-safety
  considerations are tracked in [§12](#12-compliance-notes-not-legal-advice).

## 11. Anti-bypass checklist (documented, mitigated, non-invasive)

Changing DNS/DoH; installing another browser; incognito/private mode; alternate
YouTube domains (covered by canonicalization incl. `youtube-nocookie.com`,
`m.youtube.com`); embeds (covered); VPN/proxy apps; Tor; QUIC/HTTP-3; removing
the filter; killing the Windows service; changing the system proxy; editing the
hosts file; changing the clock/timezone (UTC + monotonic + skew detection).
Per-platform mitigations and their limits are enumerated in the PoC docs. Where a
vector cannot be closed on a given posture, we say so.

## 12. Compliance notes (not legal advice)

- **COPPA / GDPR-K**: data controller for children's data; parental consent;
  minimize collection; retention limits; the parent — not the child — is the
  account holder and buyer. Not the Apple **Kids Category** (its no-third-party-PII
  rules conflict with a server-side family model, and the buyer is the parent).
- **Apple App Store**: NetworkExtension capability + (for `NEURLFilter`
  distribution) OHTTP/PIR validation via Identity & Trust; org enrollment;
  guideline 5.1.2/5.5 data-handling commitments; FamilyControls distribution
  entitlement request (per extension). Sign in with Apple required only if we
  also offer Google/Facebook login (4.8).
- This section flags architectural implications; it is **not** legal advice.

---

## 13. Unresolved — must be proven empirically

These block production. Each is owned by a PoC doc; results get recorded there
and in `docs/DECISIONS.md`.

**PoC A — iOS `NEFilterDataProvider` + FamilyControls `.child` (PRIMARY):**
_Status 2026-08-27: the scaffold **builds clean for arm64 device** (Xcode 27.0 /
iPhoneOS 27 SDK, deployment target iOS 26.0) as app + filter-data `.appex` +
filter-control `.appex` — see `apple/poc-contentfilter/project.yml` and ADR-011.
**Every numbered item below is still unproven**: no test was executed, because no
iOS device and no signing identity were available (ADR-012). Compiling is not
evidence of behaviour._
1. Default-deny YouTube while allowing exactly one video (another stays blocked) in Safari. — **UNPROVEN**
2. Full URL/query visibility on WebKit flows in practice (incl. real YouTube URLs with extra params). — **UNPROVEN at runtime.** SDK-level support only: `NEFilterFlow.URL` is declared on the *base* `NEFilterFlow` class (`NEFilterFlow.h`, iOS 9.0+) documented as "The flow's HTTP request URL. Will be nil if the flow did not originate from WebKit." That matches the design assumption but says nothing about what YouTube's real navigations actually surface.
3. Remediation "Request Access" block page actually renders in Safari and round-trips to the app. — **UNPROVEN**, and note a constraint found in the SDK headers: the remediation URL "should follow the scheme http or https" (`NEFilterProvider.h`). The block page is therefore a **remotely hosted** page, not an app-local one; the `NE_FLOW_URL` substitution carries the blocked URL to it, and the hop back into the containing app must be a universal link or custom scheme from that page. This adds a hosting dependency to the Request-Access flow that the §0 workflow should account for.
4. Dynamic allowlist update via `notifyRulesChanged()` — measured propagation time (target: seconds). — **NOT MEASURED. No number exists yet.**
5. Temporary approval enforced and **auto-expires** locally, including offline. — **UNPROVEN**
6. Exactly what the child can/can't disable/uninstall/bypass under `.child` (DNS, VPN config, profile install). — **UNPROVEN.** This is the highest-risk unknown: if `.child` does *not* lock the filter toggle in Settings, the enforcement story changes materially and ADR-001 needs revisiting.

**PoC B — macOS Safari Web Extension (+ native tamper controls):**
7. Per-video allow/deny + Request-Access page in Safari without blocking Safari; force-install feasibility on consumer macOS; standard-account tamper resistance.

**PoC C — Windows policy-installed extension + hardened service (no MITM by default):**
8. `ExtensionInstallForcelist` + MV3 `webRequestBlocking` on clean, non-domain-joined Windows 11 Home; full-URL enforcement; service anti-tamper; block unsupported browsers; whether any concrete case forces the MITM fallback.

**PoC D — `NEURLFilter` Bloom/PIR (SUPPLEMENTARY):**
_Status 2026-08-27: scaffold **builds clean for arm64 device** (app + ExtensionKit
control-provider extension, Bloom blob bundled); `build_bloom.py --selftest`
passes. Four SDK corrections applied — see ADR-013. No test executed (ADR-012)._
9. Split into what the SDK settled and what it did not:
   - **`ParsingConfiguration` dataset-key shape — ANSWERED at the API level (ADR-013).** All URL-parsing control (`ParsingConfiguration`, `urlParsingConfiguration`, `setURLParsingRegularExpression`) is `@available(iOS 27.0, *)`. **On iOS 26 the key shape cannot be influenced at all**, which is precisely the "one sub-URL blocks the whole domain" behaviour. On iOS 27, `QueryOptions(parameters: ["v"])` plus `DomainOptions/PathOptions(enumerateHierarchy: false)` make `youtube.com/watch?v=<id>` expressible. This makes the blocklist *precise* on iOS 27 but does **not** give it an allow verdict or a default-deny — **ADR-002 stands**, and the "specific bad videos" use is practical on iOS 27 only.
   - **Supervision requirement — STILL UNRESOLVED.** The SDK does not break the TN3134-vs-Deployment-guide tie: NetworkExtension mentions supervision only in `NEAppPushManager.h` (unrelated), and the entitlement is plain `url-filter-provider` with no supervision qualifier. Hardware-only (D5). If supervision *is* required, `NEURLFilter` drops to MDM-only scope.
   - **`.child` lock on the URL-filter Settings toggle — STILL UNRESOLVED**, and now known to be unanswerable from the SDK: no ManagedSettings key locks a filter toggle (see ADR-014 for what *is* assertable).
   - **Realistic propagation and PIR operational cost — NOT MEASURED.**
   - **New, found statically:** `build_bloom.py` emits keywords keeping `www.`, but `DomainOptions.stripWWW` defaults to `true` — a canonicalization mismatch that would make Bloom hits miss their PIR row on iOS 27 (ADR-013).

**Cross-cutting, found while building (ADR-014):** app-deletion, iCloud sign-out
and clock tampering should not be *assumed* from the `.child` posture — they are
directly assertable via `ApplicationSettings.denyAppRemoval`,
`ApplicationSettings.denyAppInstallation`, `AccountSettings.lockAccounts`, and
`DateAndTimeSettings.requireAutomaticDateAndTime`. The last one hardens ADR-009's
clock-rollback concern rather than merely detecting it. A6 should test both
postures (`.child` alone vs. `.child` + asserted settings).

See `docs/APPLE_CONTENT_FILTER_POC.md` (A), `docs/MACOS_SAFARI_POC.md` (B),
`docs/WINDOWS_FILTER_POC.md` (C), `docs/APPLE_URL_FILTER_POC.md` (D), and
`docs/DECISIONS.md` for the running record.

## 14. Primary sources

- URL filters overview — <https://developer.apple.com/documentation/networkextension/url-filters>
- `NEURLFilterManager` — <https://developer.apple.com/documentation/networkextension/neurlfiltermanager>
- Filtering traffic by URL (SimpleURLFilter) — <https://developer.apple.com/documentation/networkextension/filtering-traffic-by-url>
- WWDC25 234 — <https://developer.apple.com/videos/play/wwdc2025/234/>
- `NEFilterDataProvider` — <https://developer.apple.com/documentation/networkextension/nefilterdataprovider>
- `NEFilterFlow.url` — <https://developer.apple.com/documentation/networkextension/nefilterflow/url>
- TN3134 provider deployment — <https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment>
- FamilyControls — <https://developer.apple.com/documentation/familycontrols>
- ManagedSettings `WebContentSettings` — <https://developer.apple.com/documentation/managedsettings/webcontentsettings>
- Apple Platform Deployment, Filter content — <https://support.apple.com/guide/deployment/filter-content-dep1129ff8d2/web>
- NetworkExtension entitlement — <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension>
- `apple/pir-service-example` — <https://github.com/apple/pir-service-example> · `apple/swift-homomorphic-encryption` — <https://github.com/apple/swift-homomorphic-encryption>
- Windows: WFP <https://learn.microsoft.com/windows/win32/fwp/> · declarativeNetRequest / MV3 blocking webRequest for policy-installed extensions <https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests> · `ExtensionInstallForcelist` <https://chromeenterprise.google/policies/extension-install-forcelist/> · service security <https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights> · ECH/QUIC/DoH policy (see `docs/WINDOWS_FILTER_POC.md`).
