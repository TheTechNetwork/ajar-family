# Windows browser extension — MV3 per-video enforcement (PoC C)

The Windows per-URL enforcement engine. A single **MV3** extension for Chrome and
Edge (Firefox packaged from the same source with WebExtension-standard APIs),
**published** to the Chrome Web Store / Microsoft Edge Add-ons / Firefox AMO and
then **force-installed by ID** by the hardened service (`windows/agent/`). It makes
per-URL allow/block decisions using the **shared policy model** and redirects
blocked navigations to a friendly Request-Access page.

This is the primary Windows mechanism under **ADR-005** (Windows starts without
TLS interception). See `docs/WINDOWS_FILTER_POC.md` for the experiment protocol and
the load-bearing empirical question this extension exists to answer.

## Why a policy-installed extension can do what a store one can't

MV3 removed the blocking form of `webRequest` for ordinary extensions and pushed
them to `declarativeNetRequest`. **Policy-installed extensions are exempt.** Chrome's
migration guide is explicit: *"You don't need to make these changes if your
extension is installed by policy"* —
<https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests>.
That exemption is the whole reason this design works: we get **synchronous
`webRequestBlocking` `onBeforeRequest`**, which can cancel or redirect a
navigation **before** it loads, giving true per-URL (per-video) control that
`declarativeNetRequest`'s static rules cannot express for a default-deny-YouTube +
allow-one-video policy synced live from the service.

**Corollary — distribution:** because the forced install of a **self-hosted CRX**
requires a **domain-joined** machine, and consumer Win11 Home boxes are **not**
domain-joined, we **must publish to the stores** and force-install **by ID**:

- Chrome — `ExtensionInstallForcelist` on a non-AD machine only installs
  **Web-Store-published** extensions —
  <https://chromeenterprise.google/policies/extension-install-forcelist/>.
- Edge — forced install on non-AD machines is limited to **Microsoft Edge
  Add-ons** —
  <https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/extensioninstallforcelist>.
- Firefox — `ExtensionSettings` `force_installed` **can** point at a self-hosted,
  **AMO-signed** XPI, so Firefox is the one browser where self-hosting is possible —
  <https://mozilla.github.io/policy-templates/#extensionsettings>.

The exact registry values the service writes are in
`windows/agent/policies/registry-policies.md`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions `webRequest` + `webRequestBlocking` + `declarativeNetRequest` + `webNavigation` + `storage` + `nativeMessaging`; host permissions for YouTube hosts + `<all_urls>` (justified inline). `web_accessible_resources`: `blocked.html`. Comment records that `webRequestBlocking` is honored because policy-installed. |
| `background.js` | Service worker. Synchronous `chrome.webRequest.onBeforeRequest [blocking]`: normalizes each URL via `youtube-normalize.js`, runs the **shared evaluation order**, redirects blocked navigations to `blocked.html?u=<enc>`. Loads the signed policy snapshot from the native host and caches it in memory for the synchronous listener. Also intercepts YouTube SPA route changes via `webNavigation.onHistoryStateUpdated`. |
| `youtube-normalize.js` | Faithful JS port of `shared/youtube/youtube-normalize.ts` (**lockstep**). |
| `blocked.html` / `blocked.js` | Friendly block page + reason + **Request Access** button; posts the blocked canonical id to the native host via the background worker (stub for the backend leg). |

## Semantics — keep in lockstep with `shared/`

`shared/policy/policy-model.ts` and `shared/youtube/youtube-normalize.ts` are the
**single source of truth**. `background.js` reproduces `evaluate()` and
`youtube-normalize.js` ports `normalizeYouTube()`/`youTubePolicyKey()`. They must
produce **identical decisions** for the same input. When the shared TypeScript
changes, mirror it here (review obligation, per ADR-008). The evaluation order
reproduced here (device → child → temporary approval → exact-URL allow →
exact-URL block → YouTube video/playlist/channel → domain → category → default,
with an independent YouTube default) is the product's mandated ordering.

Two behaviors worth calling out because they are easy to get wrong:

- **Playback-support hosts.** A default-deny YouTube policy must still allow the
  hosts an approved video needs to stream — `www.youtube.com`,
  `*.googlevideo.com` (the opaque media CDN), `s.ytimg.com`/`i.ytimg.com`,
  `youtubei.googleapis.com`, etc. (`YOUTUBE_PLAYBACK_SUPPORT_HOSTS`). `googlevideo.com`
  URLs cannot be tied to a video id, so the extension allows that host **while any
  video is currently approved** and relies on the per-video **watch-page gate** to
  control access. Blocking these makes an approved video spin forever. See
  `ARCHITECTURE.md §6`.
- **SPA navigation.** YouTube swaps the video with `history.pushState` + an
  InnerTube fetch, with no full document load, so `onBeforeRequest` `main_frame`
  never fires for the second video. `webNavigation.onHistoryStateUpdated` (and,
  as a backstop, the `youtubei/v1/player` XHR in `onBeforeRequest`) catches it.

## How policy reaches the extension (native messaging)

The extension has no network credentials and never talks to the backend directly.
The **LocalSystem service** (`windows/agent/`) is the policy authority on-device:
it syncs signed, versioned `DevicePolicySnapshot`s from the backend, **verifies the
Ed25519 signature**, and pushes the verified snapshot to the extension over a
**native-messaging** connection. The extension caches the last snapshot in
`chrome.storage.local` so enforcement survives a service-worker restart and works
offline (temporary grants expire locally against a server-signed UTC `expiresAt`
tracked with a monotonic clock — ADR-009). The **Request Access** button posts the
blocked canonical id back through the same channel; the service signs and forwards
it to the backend AccessRequest workflow (`ARCHITECTURE.md §7`).

## Firefox notes

- Firefox WebExtensions retain full blocking `webRequest` (MV2 semantics), so the
  same `onBeforeRequest` logic applies; the `background.js` module is reusable.
- Force-install + lockdown via `ExtensionSettings` (`installation_mode:
  force_installed`, `install_url`, and `default_area`), plus locking
  `network.trr.mode` (DoH) and `network.http.http3.enable=false` via policy.
- Firefox is the **only** target where a **self-hosted (AMO-signed) XPI** can be
  force-installed on a non-domain-joined machine.

## Honest limits

- **This is not tamper-proof by itself.** The extension is only as strong as the
  policy that force-installs it and blocks other extensions/browsers — that
  hardening lives in the **service** (`windows/agent/`, Tiers C3–C4) and holds only
  for a **standard (non-admin) child account** (ADR-006). An **admin** child can
  remove the policy, the extension, or the service; the service detects admin-child
  and alerts the parent rather than pretending otherwise.
- **`declarativeNetRequest` is a complement, not the core.** DNR handles coarse
  host-level blocks without per-request JS but cannot express live per-video
  allow-one decisions; the load-bearing path is the blocking `webRequest` handler.
  DNR dynamic-rule limits: 30,000 rules (5,000 "unsafe" for redirect/modifyHeaders)
  — <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest>.
- **No TLS interception.** This extension sees URLs because it runs **inside** the
  browser's TLS endpoint. A MITM proxy is a documented fallback (Tier C6 in
  `docs/WINDOWS_FILTER_POC.md`), **not built**.
