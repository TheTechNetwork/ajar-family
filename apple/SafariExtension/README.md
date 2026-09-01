# Ajar for Safari — iPhone, iPad and Mac

The per-request enforcement surface. `AjarFilter`'s content filter is asked once
per **flow**: a top-level navigation arrives as a browser flow carrying the full
URL, and everything a page fetches for itself arrives as a socket flow carrying a
hostname and nothing else. So inside any single-page app — Reddit, X, Instagram,
TikTok, Google Search, YouTube — the content filter enforces at HOST level, and
that is not URL filtering. Reading the flow's bytes does not rescue it: they are
TLS ciphertext, and decrypting them means TLS interception, which this
architecture rules out unconditionally on Apple (ARCHITECTURE.md §5).

An extension inside Safari sees every navigation and every in-page route change,
and decides **locally** against the cached signed snapshot — no per-request
network call. See `docs/DECISIONS.md` ADR-018.

**This does not replace the content filter.** The filter covers every app on the
device and survives a Safari the child does not use; the extension covers what
happens inside Safari at URL granularity. Both read the same signed snapshot and
must reach the same decision.

---

## Where it ships

One copy of the extension, two hosts:

| Platform | Container | Project |
|---|---|---|
| iOS / iPadOS | **Ajar** — the filter app itself, target `SafariExtension` | `apple/AjarFilter/project.yml` |
| macOS | **Ajar for Safari** — its own app | `apple/AjarSafari/project.yml` |

iOS gets one app because it can: the filter app already enrols the device and
holds the signed snapshot, so a second app would have meant a second enrolment
and two device identities for one child. macOS cannot join it — there is no
FamilyControls there and a macOS content filter is a system extension with a
different container, entitlement and distribution channel — so it keeps its own
container around the same sources.

## Installing it on a device

The Xcode projects are **generated and gitignored**, so they do not arrive with
a pull and do not update when this folder changes.

```sh
brew install xcodegen
# iPhone / iPad
cd apple/AjarFilter && xcodegen generate && open AjarFilter.xcodeproj
# Mac
cd apple/AjarSafari && xcodegen generate && open AjarSafari.xcodeproj
```

Re-run `xcodegen generate` after any pull that touches `apple/SafariExtension/`
or either project folder. A file added upstream is simply absent from a stale
project, and Swift reports that as "cannot find <symbol> in scope" at every
*use* site rather than as a missing file. Close the project in Xcode before
regenerating.

Build the scheme to the device, then switch the extension on — it is off until
someone does, and no app can turn it on for them:

- **iPhone / iPad:** Settings → Apps → Safari → Extensions → **Ajar** → on. Then
  open it and set **All Websites → Allow**. "Ask" leaves a permission prompt
  between the child and every navigation, which is not a filter. The filter
  app's main screen links to these same steps.
- **Mac:** Safari → Settings → Extensions → tick **Ajar**, then Websites → Ajar →
  **Allow on Every Website**.

### It needs Ajar (the filter app) installed and enrolled

The extension has no enrolment of its own on a real install. `AjarFilter`'s app
enrols the device and writes the signed `DevicePolicySnapshot` into the App Group
`group.family.ajar.filter`; `SafariWebExtensionHandler` reads it back through
**`PolicyStore`** — the same type the content filter uses, compiled into this
target — and hands the bytes to the extension, which **re-verifies the Ed25519
signature itself** before trusting any of it.

On macOS the container is a different app, so it must be signed by the same team
and carry the same App Group. `node apple/check-app-group.mjs` (run in CI) checks
every entitlements file names the group `PolicyStore` defines, and that the shim
keeps **no string copies** of the group name or the storage keys — it used to,
back when it could not import `PolicyStore` across projects, and a drifted copy
compiles, reads nothing, and looks exactly like a device nobody ever enrolled,
which is the one state that allows everything.

### With no policy

Mirrors `PolicyStore.state()` exactly, and deliberately says nothing about which
site is being visited:

| State | Behaviour |
|---|---|
| Never enrolled | **Allow.** We do not claim to filter this device, and a browser that blocks everything before setup is broken, not safe. |
| Enrolled, snapshot missing or unverifiable | **Block.** Otherwise deleting the cached snapshot is the whole bypass. |

---

## Development without a device: backend mode

The options page (`options.html`) enrolls the extension straight against the
backend over HTTP, long-polling `GET /v1/devices/:id/policy/wait` and posting to
`POST /v1/requests`. This is the **development** path — it exists so the loop can
be exercised in a browser — and it is what runs in any browser with no native
messaging. `background.js` picks it when a backend config is present and the
native path otherwise.

1. Run the backend: `npm ci && npm run build && (cd backend && AUTH_SECRET=dev node dist/index.js)`.
2. Create a family/child and an enrollment code (`web/parent/` or the API).
3. Extension **Options** → the one-time code + a parent setup word → enroll. The
   address is fixed to the one in the bundle (`trust-anchor.js
   BUNDLED_BACKEND_URL`); to point it elsewhere, turn on dev mode from the
   options page console — `browser.storage.local.set({ ajarDevMode: "1" })` —
   and reload. The signing key is pinned at this first enrollment; see
   `docs/SECURITY.md`.
4. Open a blocked page → **Request Access** → approve from the parent console →
   the long-poll applies the signed policy within seconds; the exact URL opens,
   others stay blocked, and the grant auto-expires.

---

## Native messaging: what exists and what does not

**Safari does not implement `runtime.connectNative`.** There is no long-lived
port and nothing pushes; the channel is one-shot `sendNativeMessage`, routed to
the containing app's `SafariWebExtensionHandler`. This code used to open a port
to `com.example.youtubeguard.host` — a Chrome/Firefox idiom aimed at a
placeholder host id — and wait for `POLICY_SNAPSHOT` messages that could not
arrive.

So the extension **asks**, on worker start and every 5s. That is a local read of
a `UserDefaults` key, not a network call, and it is the only pull there is, so an
approval lands within a poll. Safari unloads the service worker aggressively
(B4/B5) and nothing is held open across an unload; `browser.storage` is the
durable cache in between.

Verification happens in the JavaScript, not natively (ADR-010): the App Group is
writable by anything holding that entitlement, so the native side passing bytes
along is not evidence about who produced them. The native side also cannot
*replace* a pinned signing key — it can only supply one where this profile has
none.

**`ACCESS_REQUEST` over native messaging is NOT built.** The containing app
serves `GET_POLICY` and nothing else. `sendAccessRequest` returns
`native-request-not-implemented` and the block page reports the failure rather
than telling a child their parent has been asked when no request went anywhere.

Docs:
<https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension>.

---

## Tamper posture (honest)

- **The extension is user-enabled and user-disableable, on both platforms.** On
  consumer hardware without MDM there is, to our strong prior, no way for an app
  to force-enable or lock a Safari Web Extension — PoC B's crux finding (B5).
  The parent must be **alerted when it is off**; do not advertise a lock we
  cannot deliver. On iOS, FamilyControls `.child` prevents deleting the *app*,
  which is not the same as preventing the extension being switched off in
  Settings.
- **No FamilyControls on macOS** (ARCHITECTURE §4, ADR-004). Tamper resistance
  there is a standard (non-admin) child account (ADR-006), a notarized system
  extension, and parent-facing "extension disabled" alerts. **An admin child
  defeats all of it** — detect admin-child and tell the parent rather than claim
  protection that is not there.
- **Never block Safari to gain enforcement** (ADR-004). Blocked navigations are
  redirected to our own block page; Safari itself stays fully functional.

## Parity obligation (lockstep with `shared/`)

`Extension/youtube-normalize.js` is a faithful port of
`shared/youtube/youtube-normalize.ts`, and `Extension/background.js` reproduces
the evaluation order of `shared/policy/policy-model.ts`. The TypeScript is the
authoritative spec (ADR-007, ADR-008). `tools/conformance/run-mirrors.mjs` runs
the shared corpus against this file and the Windows one on every push; treat a
divergence as a bug, not a platform difference.

## What is still unmeasured

`docs/MACOS_SAFARI_POC.md` tests B1–B7 are written and **not run on hardware**.
CI compiles this target for iOS and macOS; it does not run Safari. Whether
Safari on iOS honours this `webNavigation` + content-script approach, and how
fast a `tabs.update` redirect interrupts an in-page route change, are open
questions that need a device. Record findings there and in ADR-004/ADR-018.
