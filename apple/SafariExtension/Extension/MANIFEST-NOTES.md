# manifest.json — the notes that used to live inside it

These were `_`-prefixed keys inside `Extension/manifest.json`, on the theory that
"JSON has no comment syntax, so notes live in _-prefixed keys, ignored by the
WebExtension loader." That is true of the spec and of Chrome and Firefox. It was
an *assumption* about Safari — which is the only browser this extension actually
ships to, and which parses the manifest before it will let anyone enable the
extension. Several of these keys were nested inside `background`, `options_ui`,
`content_scripts` and `web_accessible_resources`, not merely at the top level.

The manifest is now strictly what the spec defines. Nothing here is deleted —
every word is preserved below, and this file is where it belongs, because a
reader looking for the reasoning is a person, not a parser.

## `_about`

Ajar's Safari Web Extension — the per-request enforcement surface (ADR-018). ONE copy, two hosts: the iOS filter app (apple/AjarFilter target SafariExtension) and the macOS container (apple/AjarSafari). Safari supports MV3. JSON has no comment syntax, so notes live in _-prefixed keys, ignored by the WebExtension loader. See ../README.md and docs/MACOS_SAFARI_POC.md.


## `_absolute_rule`

NEVER block Safari to gain enforcement. This extension gates per-video inside Safari and redirects blocked navigations to blocked.html; Safari itself stays fully functional.


## `background._note_safari`

Safari supports MV3 background service workers. Safari may unload the worker aggressively (B4/B5): background.js must tolerate reconnects to the native host and can fall back to polling browser.storage. Safari uses 'service_worker' like Chrome; 'scripts'/persistent pages are the older Firefox style and are not relied on here.


## `options_ui._note`

Dev/browser-testable enrollment: point the extension at the backend and redeem a six-digit code. In production the macOS child agent is the policy source and this page is unnecessary.


## `content_scripts._note`

document_start so the SPA history patch installs before the page's own router. Single-page apps change route via history.pushState WITHOUT a network request, so content.js must catch them and ask the background worker to re-evaluate (B3). Scoped to all http(s) pages because the shared evaluator enforces DOMAIN/CATEGORY rules everywhere, not just YouTube.


## `_permissions_notes`

**declarativeNetRequest** — Static/dynamic rules for coarse host or URL blocking that can be expressed declaratively. NOTE: DNR alone cannot express 'default-deny YouTube except this one canonical video id' — that decision needs the evaluator in background.js. DNR is used only for support-host allow-listing / obvious blocks; per-video gating is done in JS.

**declarativeNetRequestWithHostAccess** — Allows DNR rules that redirect/modify only on hosts we already have access to (the youtube host_permissions), rather than requesting the broad 'declarativeNetRequestFeedback'/all-URL grant.

**webNavigation** — onBeforeNavigate / onCommitted give the full navigation URL so background.js can normalize+evaluate and redirect blocked top-level navigations to blocked.html.

**storage** — Holds the synced, signed DevicePolicySnapshot delivered by the native messaging host, plus the 'any video currently approved?' flag used to keep googlevideo.com reachable.

**nativeMessaging** — browser.runtime.connectNative to the signed native host (child agent): receives signed policy snapshots, sends AccessRequests. Safari routes native messaging through the containing app's SafariWebExtensionHandler.


## `_host_permissions_note`

<all_urls> is REQUIRED and justified: the shared policy model is not YouTube-only — it evaluates DOMAIN / URL / URL_PATTERN / CATEGORY rules and supports a default-deny web posture (DefaultPolicy.webDefault). Enforcing those on arbitrary sites means observing navigations to arbitrary sites. ADR-004 still holds: we never disable or blanket-block Safari, we only redirect a specifically-blocked navigation to our own block page. The extension inspects URLs to make allow/block decisions and does NOT exfiltrate browsing history (ARCHITECTURE.md privacy posture); only a URL the child explicitly asks about is ever sent. The media CDN *.googlevideo.com and other playback-support hosts stay reachable while a video is approved (B7).


## `web_accessible_resources._note`

blocked.html is the Request-Access page a blocked navigation is redirected to. The WAR `matches` list gates which ORIGINS may load it, and it used to name four YouTube hosts — so a blocked navigation on any other site could not load the block page at all, and the child got a browser error instead of a way to ask. That contradicted this same manifest's host_permissions note, which says <all_urls> is required precisely because the shared policy model evaluates DOMAIN / URL / URL_PATTERN / CATEGORY rules on arbitrary sites. Now every http(s) origin, which is the set of origins the extension can block in the first place. page-hook.js is loaded BY THE PAGE (content.js injects a <script src> pointing here), so it must be web-accessible from every origin the extension can gate — it runs in the page's own JavaScript world, which is the only world where patching history.pushState has any effect.


## `_safari_caveats`

- Safari supports MV3, declarativeNetRequest, and background service workers, but its DNR quotas, rule-count limits, and webRequest support differ from Chrome/Firefox — verify with the safari-web-extension-converter output and the Safari console on device.

- browser.* is the promise-based API namespace; chrome.* callbacks also work. This scaffold uses browser.* (WebExtension standard).

- Native messaging in Safari goes through the containing app (SafariWebExtensionHandler), not a standalone host manifest in a well-known directory as on Chrome/Firefox.

- The user must ENABLE this extension in Safari Settings → Extensions and grant host access. On consumer macOS (no MDM) the app very likely cannot force-enable or lock it — this is PoC B's crux finding (B5).


## `_name_note`

Not "Ajar (PoC B)". This string is what a child sees in Safari's extension list on their own device, and shipping the letters PoC there is the same defect as the filter calling itself "ParentFilter PoC" in Settings.


## `_action_note`

Was "YouTube Guard" — off-brand, and YouTube-specific on an extension whose whole point is that the policy model is not YouTube-only.


## What a child reads, and why it changed (2026-09-03)

Two strings in this manifest are rendered by Safari on the child's own device,
in Settings, under the extension's name. They were written for a reader of this
repository and shipped to a reader of a phone.

**`description`** said *"Ajar — per-video YouTube approvals in Safari, consuming
the shared policy model. Experiment scaffold — not production."* Two faults, and
this file already names the first one under `_name_note`: shipping the letters
PoC to a child's screen is the same defect as the filter calling itself
"ParentFilter PoC" in Settings, which a device screenshot caught once already.
The second is that it describes the product as YouTube-specific on the one
surface where a child forms their idea of what this thing is, when the policy
model has never been YouTube-only.

**`host_permissions`** listed `*://localhost/*` and `*://127.0.0.1/*`. Safari
renders granted hosts by name, so a child's permission screen showed two
development addresses. They were also redundant: `<all_urls>` is present and
subsumes every specific entry, so all of them bought nothing. The list is now
`<all_urls>` alone, which is what the extension actually needs and what the
justification above is written about.
