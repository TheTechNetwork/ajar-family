# PoC B scaffold — macOS Safari Web Extension (+ native tamper controls)

On-device-runnable proof for `docs/MACOS_SAFARI_POC.md`. **Cannot be built in the
CI/Linux environment** — a Safari Web Extension is built and signed with **Xcode
on macOS** and enabled in **Safari**. Open on a Mac, build, notarize, and run
following the experiment protocol.

> **This is an UNRESOLVED direction (ADR-004), not a settled design.** The
> headline open question is B5: **a consumer app very likely CANNOT force-enable
> or lock a Safari Web Extension without MDM.** Build this to *measure* that, not
> to assume it away. And the absolute rule: **never block Safari to gain
> enforcement — Safari must stay fully functional** (ARCHITECTURE §5, ADR-004).

## Two policy sources: native host (production) and backend HTTP (dev)

Like the Windows extension, the enforcement path only ever reads an in-memory
**signed** snapshot; two sources populate it, selected at startup:

- **Native-host mode (production macOS):** the child agent pushes signed snapshots
  through the containing app's `SafariWebExtensionHandler`.
- **Backend HTTP mode (dev):** enroll from the **options page** and the extension
  talks straight to the backend — `backend-client.js` long-polls
  `GET /v1/devices/:id/policy/wait` and posts access requests to `POST /v1/requests`.
  Every snapshot is **Ed25519-verified** in-extension (`policy-verify.js`) before
  it is trusted (fail closed). These three modules are kept **in lockstep** with
  `windows/extension/` — identical contract, `browser`/`chrome` namespace shim.

The Safari enforcement mechanism differs from Windows by necessity: **Safari has no
blocking `webRequest`**, so this extension gates via `webNavigation` + a
content-script SPA-route interceptor that redirects blocked YouTube navigations to
`blocked.html` (never touching non-YouTube browsing). The *policy source, signing,
and request flow are identical* to the Windows client — which was verified
end-to-end over HTTP (approval delivered to a parked long-poll in single-digit ms).

### Try the loop (on a Mac, no MDM, no Apple hardware entitlements)

1. Run the backend (`npm ci && npm run build && (cd backend && AUTH_SECRET=dev node dist/index.js)`).
2. In Xcode, wrap `Extension/` with a Safari Web Extension app target
   (`xcrun safari-web-extension-converter Extension/`), build, and enable it in
   **Safari → Settings → Extensions** (grant host access to YouTube + your backend).
3. Create a family/child + enrollment code (parent web console `web/parent/` or the API).
4. Extension **Options** → backend URL + six-digit code → enroll.
5. Open a YouTube video → blocked → **Request Access** → approve from the parent
   console → the extension's long-poll applies the signed policy within seconds and
   the exact video plays; others stay blocked; the grant auto-expires.

## Why a Safari Web Extension here

On native macOS neither native NetworkExtension path gives per-video control of
Safari: `NEFilterDataProvider` is effectively hostname-only (the full-URL
`NEFilterBrowserFlow` + remediation page are the iOS surface, not annotated for
native macOS), and `NEURLFilter` is blocklist-only and can't default-deny
(`ARCHITECTURE.md §3`, §5). A Safari Web Extension runs **inside Safari**, sees
the **full URL** and in-page SPA route changes, evaluates the shared policy
model per canonical video id, and redirects blocked navigations to its own
Request-Access page — all without blocking Safari.

## Layout (Xcode: one macOS app that contains the extension)

```
YouTubeGuardPoC.xcodeproj            (create in Xcode: "Safari Web Extension App")
├── App/                             (containing macOS app — the product surface)
│   ├── AppDelegate / SwiftUI        // onboarding: "enable the extension in Safari",
│   │                                //   shows extension-enabled status, account type
│   │                                //   (standard vs admin — ADR-006), tamper alerts
│   └── SafariWebExtensionHandler.swift  // NSExtensionRequestHandling — the bridge
│                                    //   between the extension JS and the native app
├── Extension/                       (the Safari Web Extension — the files checked in here)
│   ├── manifest.json                // MV3 manifest (Safari supports MV3)
│   ├── background.js                // service worker: load snapshot, normalize, evaluate, redirect
│   ├── content.js                   // content script: catch SPA route changes, re-evaluate
│   ├── youtube-normalize.js         // JS port of shared/youtube/youtube-normalize.ts (lockstep)
│   ├── blocked.html                 // self-contained Request-Access block page
│   └── _locales/ , images/          // (add in Xcode as needed)
├── NativeMessagingHost/             (signed helper / the child agent — NOT checked in here)
│   └── host binary + host manifest  // delivers signed policy snapshots, receives access requests
└── (optional) NativeFilters/        (native tamper/blocklist layers — NOT checked in here)
    ├── URLFilterProvider/           // NEURLFilter control provider (category blocklist)
    └── FilterDataProvider/          // NEFilterDataProvider SYSTEM extension:
                                     //   socket/hostname enforcement +
                                     //   NEFilterManager.disableEncryptedDNSSettings (macOS 15+)
```

Only the WebExtension assets under `Extension/` are checked into the repo. The
Xcode project, containing app, native messaging host, and optional native
system-extension layers are described here and stood up on macOS.

## Building it

- **Author directly** with the Xcode **"Safari Web Extension App"** template, or
  **convert** an existing MV3 extension:
  ```sh
  xcrun safari-web-extension-converter /path/to/Extension --macos-only --app-name YouTubeGuardPoC
  ```
  `safari-web-extension-converter` scaffolds the containing app + extension
  target around the WebExtension files and reports any manifest keys Safari does
  not honor. Docs:
  <https://developer.apple.com/documentation/safariservices/converting-a-web-extension-for-safari>.
- Safari **supports MV3** (background service worker, `declarativeNetRequest`,
  MV3 content scripts). Some WebExtension features differ from Chrome/Firefox —
  the converter and the runtime console flag unsupported keys; see the
  Safari-specific caveats in `Extension/manifest.json` comments.
- Sign with your Developer ID / Apple Developer team; **notarize** for
  distribution outside the Mac App Store, or submit to the **Mac App Store**.
  Docs: <https://developer.apple.com/documentation/safariservices/distributing-your-containing-app-and-safari-web-extension>.

## How the extension talks to the native host / child agent

- The extension uses **native messaging** (`browser.runtime.connectNative` /
  `browser.runtime.sendNativeMessage`) to reach a **signed native host** (the
  child agent). The host delivers the **Ed25519-signed `DevicePolicySnapshot`**
  (`shared/policy/policy-model.ts`); the extension verifies/stores it in
  `browser.storage` and the background worker evaluates against it. Access
  requests (B2) flow back to the host, which posts them to the backend.
  Docs: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>,
  <https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension>.
- The `SafariWebExtensionHandler` (`NSExtensionRequestHandling`) in the
  containing app is the in-process bridge for messages that stay on-device.
- **Reliability is an open question (B4/B5):** Safari may unload the background
  service worker; native-messaging connections may drop. The background worker
  should tolerate reconnects and can fall back to polling `browser.storage`.

## Distribution + user-enable flow

1. Ship the **containing app** (Mac App Store or Developer ID + notarized DMG).
2. The user installs it; the app onboards them to **Safari Settings → Extensions**
   and asks them to **enable** the extension and **allow** it on the YouTube
   hosts. Docs: <https://support.apple.com/guide/safari/get-extensions-sfri32508/mac>.
3. **The extension is user-enabled and user-disableable.** On consumer macOS
   (no MDM) there is, to our strong prior, **no way for the app to force-enable
   or lock it** — this is exactly PoC B's crux finding (B5). The app should
   detect when the extension is disabled and **alert the parent**, and rely on
   the standard-account restriction (ADR-006) + the native system-extension
   layer for what tamper resistance is achievable. Do not advertise a lock we
   cannot deliver.

## Tamper posture (honest)

- **No FamilyControls on macOS** — there is no app-delete / iCloud lock like iOS
  (ARCHITECTURE §4, ADR-004). Tamper resistance = **standard (non-admin) child
  account** (ADR-006) + a **notarized system extension** (harder to remove
  without admin) + parent-facing "extension/agent disabled" alerts.
- An **admin child defeats it**: they can disable the extension, remove the app,
  the native host, and the system extension. The agent must **detect admin-child
  and alert the parent** rather than claim protection it cannot provide.
- **Never block Safari.** It is acceptable for macOS to enforce via the browser
  extension while iOS uses native filtering — as long as both consume the same
  shared policy model and produce identical decisions.

## Parity obligation (lockstep with `shared/`)

- `Extension/youtube-normalize.js` is a **faithful port** of
  `shared/youtube/youtube-normalize.ts`; `Extension/background.js` reproduces the
  relevant slice of the **evaluation order** in `shared/policy/policy-model.ts`.
  The TypeScript is the **authoritative spec** (ADR-007, ADR-008); keep the JS in
  lockstep and treat divergence as a bug.
- **If** a native macOS system-extension layer (Swift) is added for the
  socket/hostname tier, its Swift port of the shared evaluation/normalization
  must match the TypeScript spec exactly — the same obligation the iOS scaffold
  carries (`apple/AjarFilter/Shared/*`).

## What to measure

Follow `docs/MACOS_SAFARI_POC.md` tests **B1–B7**, fill the Observed Results
table there, and record the B5 finding (can a consumer app force-enable/lock a
Safari extension?) and the propagation numbers in `docs/DECISIONS.md` (ADR-004).
