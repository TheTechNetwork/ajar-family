# PoC B — macOS Safari Web Extension (+ native tamper controls)

> **Status: UNRESOLVED direction, framed as an experiment.** This document is a
> protocol, not a settled design. It records what we intend to test on real
> macOS hardware, why a Safari Web Extension is the primary per-URL mechanism on
> macOS, and — honestly — the open questions (especially whether a consumer app
> can force-enable or lock the extension) that must be answered before this
> direction is accepted. Nothing here is proven yet; the Observed Results table
> is empty and the "Key unresolved" list is the point of the exercise.
>
> **This environment (Linux, no macOS, no Xcode, no Safari) cannot build, sign,
> notarize, or run any of this.** The scaffold under `apple/AjarSafari/`
> is written to be opened in **Xcode** on macOS by a human, who records results
> in the **Observed Results** table below and in `docs/DECISIONS.md` (ADR-004).

## Why a Safari Web Extension is the primary per-URL mechanism on macOS

The two native NetworkExtension paths cannot do per-video control of Safari on
macOS (established in `ARCHITECTURE.md §3`, §5, and ADR-004):

- **Native-macOS `NEFilterDataProvider` is effectively hostname-only.** The
  full-URL WebKit flow (`NEFilterBrowserFlow`), `NEFilterFlow.url`, and the
  remediation "Request Access" block page are **not annotated for native
  macOS** — they are the iOS surface. On native macOS the control provider sees
  socket flows (hostname / SNI), not the path + query of a Safari navigation.
  Docs: <https://developer.apple.com/documentation/networkextension/nefilterflow/url>,
  <https://developer.apple.com/documentation/networkextension/nefilterdataprovider>.
- **`NEURLFilter` (macOS 26) is blocklist-only and cannot default-deny.** Its
  dataset means "block these URLs"; there is no allow verdict, no exceptions,
  and putting `youtube.com` in it blocks all of YouTube irreversibly. It is the
  right tool for large category blocklists, the wrong tool for allow-one-video.
  Docs: <https://developer.apple.com/documentation/networkextension/url-filters>.

A **Safari Web Extension** runs **inside Safari**, so it sees the **full URL**
of every navigation and every in-page (SPA) route change, can evaluate the
shared policy model per canonical video id, and can **redirect a blocked
navigation to its own Request-Access page** — all without touching the network
layer and, crucially, **without ever blocking Safari** (ADR-004). That is why it
is the candidate primary mechanism on macOS.

- Safari Web Extensions are **WebExtension-API based** (the same
  `browser.declarativeNetRequest` / `browser.webRequest` / content-script model
  as Chrome/Edge/Firefox), built with **Xcode** (the "Safari Web Extension"
  template, or `xcrun safari-web-extension-converter` to convert an existing
  MV3 extension), and shipped as a **macOS app that contains the extension**.
  Docs: <https://developer.apple.com/documentation/safariservices/safari-web-extensions>,
  <https://developer.apple.com/documentation/safariservices/converting-a-web-extension-for-safari>,
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions>.
- Distribution is via the **Mac App Store** or **Developer ID + notarization**;
  the extension is then **enabled by the user in Safari Settings → Extensions**.
  Docs: <https://developer.apple.com/documentation/safariservices/distributing-your-containing-app-and-safari-web-extension>,
  <https://support.apple.com/guide/safari/get-extensions-sfri32508/mac>.

Because macOS has **no FamilyControls** (ADR-004, ARCHITECTURE §4), there is no
app-deletion / iCloud-signout lock as on iOS. Tamper resistance on macOS rests
on a **standard (non-admin) child account** (ADR-006) plus a **notarized system
extension**; an **admin child defeats it** and the product must say so, not gloss
it. This PoC therefore also probes the coexistence of the extension with the
native layers (`NEURLFilter` blocklist + a `NEFilterDataProvider` system
extension for socket/hostname enforcement and `NEFilterManager`
`disableEncryptedDNSSettings` on macOS 15+, an anti-DoH lever).
Docs: <https://developer.apple.com/documentation/networkextension/nefiltermanager/3131058-disableencrypteddnssettings>.

## Relationship to the other PoCs (one shared policy model)

- **PoC A** (`docs/APPLE_CONTENT_FILTER_POC.md`) is the **iOS native** path —
  `NEFilterDataProvider` + FamilyControls `.child`, which on iOS *does* see the
  full WebKit-flow URL and *does* have a native remediation page. iOS uses
  native enforcement; **macOS (this PoC) and Windows (PoC C) may use browser
  extensions instead**. That divergence is acceptable **only** because every
  adapter consumes the **same shared policy model** (`shared/policy/policy-model.ts`)
  and the **same YouTube canonicalization** (`shared/youtube/youtube-normalize.ts`)
  and must produce identical decisions (ADR-007, ADR-008).
- The Safari extension here and the Windows MV3 extension (PoC C) share the same
  WebExtension engine and should share the JS evaluation/normalization code; a
  Swift port in a native macOS system-extension layer (if used for the
  socket/hostname tier) must match the TypeScript spec exactly, exactly as the
  iOS Swift port does.

## Prerequisites (on real hardware)

- A Mac on a current macOS (Safari 26 target; note macOS-version caveats per
  test), **Xcode**, an Apple Developer account for signing + notarization.
- A **standard (non-admin) child account** on the Mac (ADR-006). Also run the
  admin-child case to document the difference honestly.
- The extension built from `apple/AjarSafari/` (converted via
  `safari-web-extension-converter` or authored directly), signed, and **enabled
  by the user in Safari Settings → Extensions**.
- A **native messaging host** (a signed helper app / the child agent) reachable
  from the extension via `browser.runtime.connectNative` /
  `sendNativeMessage`, to deliver signed policy snapshots and receive access
  requests. Docs:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>,
  <https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension>.
- No MDM (this is the consumer posture). If MDM *were* present it would change
  the force-install / lock answers — noted where relevant.

## Experiment matrix

Two canonical YouTube video ids are used throughout (same as PoC A, so results
are comparable):

- **ALLOWED_VIDEO** = `dQw4w9WgXcQ` (the one the "parent" approves)
- **BLOCKED_VIDEO** = `9bZkp7q19f0` (must stay blocked the whole time)

Both reduce to `YOUTUBE_VIDEO:<id>` via `youtube-normalize` regardless of URL
form; the extension MUST call the same normalization (the JS port in
`apple/AjarSafari/Extension/youtube-normalize.js`, kept in lockstep with
the TypeScript spec).

### B1 — Block one canonical video, allow another, in Safari (never block Safari)
1. Policy snapshot (synced from the native host into extension `storage`):
   YouTube default = **deny**; standing allow for `YOUTUBE_VIDEO:dQw4w9WgXcQ`.
2. In Safari open `https://www.youtube.com/watch?v=9bZkp7q19f0` → expect the
   navigation is intercepted and **redirected to the extension block page**
   (`blocked.html`). Safari itself keeps working normally everywhere else.
3. Open `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → expect it **plays**.
4. Repeat step 2 via `youtu.be/9bZkp7q19f0`, `m.youtube.com/watch?v=9bZkp7q19f0`,
   `/shorts/9bZkp7q19f0`, `/embed/9bZkp7q19f0`, `youtube-nocookie.com/embed/9bZkp7q19f0`,
   and a URL with extra params `…watch?v=9bZkp7q19f0&t=30s&pp=abc` → all must
   **block** (canonicalization parity with the TS).
5. Confirm the approved video actually **streams** end-to-end — i.e. the
   playback-support hosts, including `*.googlevideo.com`, stay allowed (B7).

### B2 — Request-Access block page + round-trip the blocked id to the app/backend
On a blocked navigation, confirm `blocked.html` renders with the blocked title /
URL and a prominent **Request Access** button (+ optional reason field), and that
submitting it hands the **blocked canonical id** to the containing app / backend
— via the native messaging host (`connectNative`) or a stubbed `fetch` to the
backend — creating an `AccessRequest` keyed by `YOUTUBE_VIDEO:9bZkp7q19f0`.
Confirm the redirect preserves the original URL (passed as `?u=<encoded>`) so the
page can display and re-request the exact resource.

### B3 — SPA / in-page navigation interception
YouTube is a single-page app: clicking a recommendation, a Short, or "next video"
changes the URL via `history.pushState`/`replaceState` **without a network
navigation**, so `webNavigation.onBeforeNavigate` / `declarativeNetRequest` may
never fire. Confirm the **content script** (`content.js`) patches
`history.pushState`/`replaceState` and listens for `popstate`, messages the
background worker to re-evaluate the new URL, and that a blocked in-page
transition is gated (redirect to `blocked.html`, or hard-stop the player)
just like a full navigation. Test: from the allowed video, click into
BLOCKED_VIDEO and into a Short → both must be gated.

### B4 — Dynamic policy update propagation from the native messaging host
With BLOCKED shown, have the native host push an updated snapshot (add an allow
for `YOUTUBE_VIDEO:9bZkp7q19f0`) → measure time from "host sent update" to
"video plays" after a reload. Repeat removal (allow → deny). Record the numbers;
the product target is a few seconds. Note whether Safari throttles or unloads the
background service worker (which would delay delivery) and whether the content
script must poll `storage` as a fallback.

### B5 — Can the extension be force-enabled / locked so a standard child can't disable it?
**This is the crux and is expected to be a NEGATIVE finding.** On consumer macOS
without MDM, a Safari extension is **enabled by the user** in Safari Settings →
Extensions and can be **toggled off** there. Attempt, as the standard child:
disable the extension; quit/kill the native host; remove the containing app.
Record what is and isn't possible. Our strong prior (state it plainly if
confirmed): **a consumer app cannot force-enable or lock a Safari Web Extension
without MDM** — the parent must be told the child can disable it, and the native
system-extension layer (which *is* harder to remove without admin) plus
tamper-detection ("extension turned off" alert to the parent) is the honest
mitigation, not a claim of lock. Contrast with the MDM path
(`com.apple.Safari.extensions` managed config / Configuration Profiles) which is
explicitly out of scope for the consumer MVP.

### B6 — Coexistence with a NEURLFilter blocklist + NEFilterDataProvider system extension
Run the extension **alongside** (a) a `NEURLFilter` control-provider app
extension carrying a category blocklist, and (b) a `NEFilterDataProvider`
**system** extension doing socket/hostname enforcement + `disableEncryptedDNSSettings`.
Confirm they do not conflict: the extension gates per-video in Safari, the native
layers handle categories/hostnames, an approved video still streams (the native
layers must not block `*.googlevideo.com` while a video is approved), and Safari
stays fully functional. Record any double-block or race where the native layer
blocks a host the extension has approved.

### B7 — Playback-support hosts must stay allowed
Confirm `YOUTUBE_PLAYBACK_SUPPORT_HOSTS` (from `youtube-normalize`) — especially
**`*.googlevideo.com`** (opaque per-session media CDN), plus `www.youtube.com`
InnerTube, `s.ytimg.com`/`i.ytimg.com`, `youtubei.googleapis.com`,
`jnn-pa.googleapis.com`, `fonts.gstatic.com` — are **never** blocked by the
extension or the native layers while a video is approved. The extension gates at
the **watch page / SPA route** (which is per-video); it must not try to gate
`googlevideo.com` (which can't be tied to a video id from the URL). This is a
deliberate, documented limitation (ARCHITECTURE §6).

## Observed Results (fill on hardware)

| Test | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| B1 block BLOCKED_VIDEO (all URL forms), Safari stays functional | Block page, Safari OK | | | |
| B1 allow ALLOWED_VIDEO plays + streams | Plays | | | |
| B2 block page renders + Request Access round-trips blocked id | Renders, round-trips | | | |
| B3 SPA pushState/replaceState/popstate gated (recs, Shorts, next) | Gated | | | |
| B4 add-allow propagation time (native host → plays) | ≤ few seconds | | | ___ s |
| B4 remove-allow propagation time | ≤ few seconds | | | ___ s |
| B4 background worker unload / throttle behavior | No stalled updates | | | |
| B5 standard child can disable extension? | (expected: YES, can) | | | **key unknown / likely no lock** |
| B5 force-enable / lock without MDM | (expected: NOT possible) | | | **crux finding** |
| B5 standard child remove app / kill native host | (expected: app removable) | | | |
| B6 coexist with NEURLFilter + NEFilterDataProvider sys-ext, no conflict | No conflict | | | |
| B6 approved video still streams under all layers | Streams | | | |
| B7 googlevideo.com + support hosts stay allowed | Allowed | | | |
| Admin-child contrast (everything above) | Defeated | | | ADR-006 |

## Key unresolved (the point of this experiment)

1. **Can a consumer app force-enable or lock a Safari Web Extension so a
   standard-account child can't disable it — without MDM?** Strong prior: **no.**
   Safari extensions are user-enabled in Settings → Extensions and user-toggleable.
   If confirmed, the product must (a) not claim a lock, (b) alert the parent when
   the extension is disabled, and (c) lean on the native system-extension layer +
   standard-account restrictions for what tamper resistance is achievable.
2. **Tamper resistance on standard vs. admin account.** A standard child can at
   least toggle the extension; an admin child can remove the app, the system
   extension, and the native host outright (ADR-006). Quantify what survives on
   a standard account (system extension harder to remove; app in `/Applications`
   removable? native host removable?).
3. **Native-messaging reliability.** Does `connectNative` stay connected across
   Safari background-worker unloads? What is realistic update latency (B4)? Does
   the extension need a `storage`-poll fallback? Does the native host relaunch
   reliably as a login item under a standard account?
4. **App Review posture for a parental-control Safari extension.** Broad host
   permissions on YouTube hosts, redirecting navigations, native messaging, and
   a "request access" flow may draw scrutiny (data-handling 5.1.2, and
   parental-controls expectations). Confirm what Apple requires for the Mac App
   Store vs. Developer ID + notarization, and whether any entitlement or review
   note is needed.
5. **Non-Safari browsers on macOS.** Chrome/Edge/Firefox are **not** covered by
   any native Apple filter and not by this Safari extension. They need their own
   force-installed extensions (same engine as Windows PoC C) where policy install
   is possible, or are documented as a gap (optionally handled by app-availability
   controls). Out of scope for B1–B7 but a known coverage hole.

## Success / kill criteria

This direction is **viable** if B1–B4, B6, B7 pass on a standard account and the
Request-Access round-trip works — i.e. per-video enforcement in Safari without
ever blocking Safari, consuming the shared policy model. It is **not** thereby
"tamper-proof": B5 is expected to show the child can disable the extension, so
viability is conditional on documenting that limit and pairing the extension
with the native system-extension layer and parent-facing tamper alerts. If B5
turns out worse than expected (e.g. the extension can't even be reliably kept
enabled, or native messaging is unreliable), that is a signal to reconsider the
macOS direction. Record all numbers and the B5 finding in `docs/DECISIONS.md`
(ADR-004) before any production commitment.

## Scaffold map

`apple/AjarSafari/` — see its `README.md`:
- `Extension/manifest.json` — MV3 manifest for the Safari Web Extension.
- `Extension/background.js` — service worker: loads the synced policy snapshot,
  normalizes + evaluates each navigation, redirects blocked ones to `blocked.html`.
- `Extension/content.js` — content script: catches SPA route changes and asks the
  background worker to re-evaluate.
- `Extension/youtube-normalize.js` — JS port of `shared/youtube/youtube-normalize.ts`,
  kept in lockstep.
- `Extension/blocked.html` — self-contained Request-Access block page.
- The Xcode app + extension wrapper, native messaging host, and (optional) native
  `NEURLFilter` / `NEFilterDataProvider` system-extension layers are described in
  the README; only the WebExtension assets are checked in here.

## Primary sources

- Safari Web Extensions — <https://developer.apple.com/documentation/safariservices/safari-web-extensions>
- Converting a web extension for Safari (`safari-web-extension-converter`) — <https://developer.apple.com/documentation/safariservices/converting-a-web-extension-for-safari>
- Messaging between the app and JS in a Safari Web Extension — <https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension>
- Distributing the containing app + extension — <https://developer.apple.com/documentation/safariservices/distributing-your-containing-app-and-safari-web-extension>
- Enable extensions in Safari (user step) — <https://support.apple.com/guide/safari/get-extensions-sfri32508/mac>
- WebExtensions API (MDN) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions>
- `declarativeNetRequest` (MDN) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest>
- `webNavigation` (MDN) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation>
- Native messaging (MDN) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>
- `NEFilterFlow.url` (iOS-annotated; note macOS gap) — <https://developer.apple.com/documentation/networkextension/nefilterflow/url>
- `NEFilterDataProvider` — <https://developer.apple.com/documentation/networkextension/nefilterdataprovider>
- `NEURLFilter` — <https://developer.apple.com/documentation/networkextension/url-filters>
- `NEFilterManager.disableEncryptedDNSSettings` (macOS 15+) — <https://developer.apple.com/documentation/networkextension/nefiltermanager/3131058-disableencrypteddnssettings>
