# PoC C — Windows policy-installed extension + hardened service (NO MITM by default)

> This is the Windows per-video enforcement proof. It answers the Windows row of
> `ARCHITECTURE.md §1` and unresolved item **#8** of `ARCHITECTURE.md §13`, under
> the product decision recorded in **ADR-005** (Windows starts without TLS
> interception) and **ADR-006** (child must be a standard, non-admin account).
>
> **Per an explicit product decision we do NOT start with TLS interception.** The
> starting architecture is a hardened Windows service + **policy-installed** MV3
> browser extensions (Chrome/Edge/Firefox) doing full-URL enforcement, with the
> service writing browser policy and anti-tamper controls and blocking
> unsupported browsers. A local MITM proxy is a **fallback requiring empirical
> justification** (Tier C6); it is documented here as a decision, **not built**.
>
> **This environment (Linux, no Windows kernel, no Win11 hardware, no signed
> browser packages) cannot build or run any Windows binary, register a service,
> write HKLM policy, or force-install an extension.** Every tier below is written
> to be executed by a human on real Windows 11 Home hardware, who records results
> in the **Observed Results** table and in `docs/DECISIONS.md` (ADR-005).

---

## 0. Why this shape, in one paragraph

No Windows OS layer sees an HTTPS **URL path**. A WFP / kernel stream callout
sees at most IP, port, process, and (sometimes) the TLS **SNI** — and even SNI is
disappearing: TLS 1.3 encrypts the certificate, and **Encrypted Client Hello
(ECH)** is on by default in Chrome 117+/Edge and Firefox 119+ (Firefox 129+ needs
no browser DoH for ECH), which hides SNI too. Microsoft's own WFP documentation
describes the stream/ALE layers and confirms there is no HTTPS-path visibility at
that layer — <https://learn.microsoft.com/windows/win32/fwp/>. Therefore per-URL
control on Windows can only come from **inside the TLS endpoint**: a **browser
extension** (our choice), or a **local MITM proxy** that terminates TLS with a
locally-trusted root CA (the fallback). Everything in Tiers C1–C5 is an attempt to
make the extension path load-bearing and tamper-resistant enough that the MITM
fallback (C6) is never needed.

---

## 1. The one load-bearing empirical question

> **On a CLEAN, non-domain-joined Windows 11 Home machine signed in with a
> personal Microsoft account, can a service running as LocalSystem force-install
> our MV3 extension via `ExtensionInstallForcelist` such that (a) it installs
> automatically, (b) the standard-user child cannot remove or disable it, and
> (c) its `webRequestBlocking` `onBeforeRequest` handler actually blocks a
> navigation?**

Everything else in PoC C is secondary to this. If force-install + blocking
`webRequest` does **not** work on unmanaged Win11 Home, the extension path is not
viable as the primary enforcement mechanism and the MITM fallback (C6) is
promoted from "documented" to "required" — that is the decision this PoC exists to
make. Two published facts make us optimistic but do **not** substitute for the
on-hardware test:

- Chrome's own MV3 migration guide states that policy-installed extensions
  **keep** the blocking form of `webRequest`: *"You don't need to make these
  changes if your extension is installed by policy"* —
  <https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests>.
  So `webRequestBlocking` is available to us **specifically because** we
  force-install by policy; a store-installed MV3 extension could not do this.
- `ExtensionInstallForcelist` is documented to work on unmanaged Windows, but on
  **non-domain-joined** machines the forced install is limited to
  **Web-Store-published** extensions; a **self-hosted CRX requires domain join** —
  <https://chromeenterprise.google/policies/extension-install-forcelist/>. Edge's
  equivalent limits forced install to **Microsoft Edge Add-ons** on non-AD
  machines —
  <https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/extensioninstallforcelist>.

**Consequence for the plan:** the extension must be **published to the Chrome Web
Store / Microsoft Edge Add-ons / Firefox AMO** and force-installed **by ID** (see
`windows/extension/README.md`). We cannot rely on self-hosting a CRX on a consumer
(non-domain-joined) box.

---

## 2. Tiered protocol

Prove the tiers in order. A later tier is not worth building until the earlier one
is observed to hold on hardware. Tier C6 is evaluated **only** if a concrete
required case survives C1–C5 uncovered.

Two canonical YouTube video ids are used throughout, matching PoC A so results are
comparable:

- **ALLOWED_VIDEO** = `dQw4w9WgXcQ` (the one the parent approves)
- **BLOCKED_VIDEO** = `9bZkp7q19f0` (must stay blocked the whole time)

Both reduce to `YOUTUBE_VIDEO:<id>` via `shared/youtube/youtube-normalize.ts`
(ported to `windows/extension/youtube-normalize.js`, kept in lockstep). The
extension MUST call that normalization and the shared evaluation order — never an
ad-hoc URL string match.

---

### Tier C1 — Force-install + blocking `webRequest` on clean Win11 Home *(prove first)*

**This is the load-bearing tier (§1).** Run it on a freshly-imaged, **non-domain-
joined** Windows 11 **Home** machine, signed in with a **personal Microsoft
account**, with a **standard (non-admin) child account** as the enforcement
target and a separate admin account only for install.

**C1-Chrome**
1. Publish the MV3 extension to the Chrome Web Store; note its extension **ID**.
2. As admin (or via the service running as LocalSystem), write
   `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist\1` =
   `<id>;https://clients2.google.com/service/update2/crx`
   (see `windows/agent/policies/registry-policies.md` for exact values).
3. Sign into the **standard child** account. Launch Chrome. Confirm the extension
   **auto-installs** without a prompt and shows as **"Installed by your
   organization"**.
4. As the standard child, attempt to **disable** and **remove** it from
   `chrome://extensions`. Expect: toggle/remove unavailable (managed).
5. Navigate to `https://www.youtube.com/watch?v=9bZkp7q19f0`. Confirm the
   `onBeforeRequest [blocking]` handler **actually blocks** and redirects to the
   extension's `blocked.html`. **This is the decisive observation.**

**C1-Edge** — repeat with
`HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`, publishing to
**Microsoft Edge Add-ons** (non-AD machines can only force-install Add-ons-hosted
items).

**C1-Firefox** — use the `ExtensionSettings` policy with
`installation_mode: force_installed` and an `install_url`. Firefox permits a
**self-hosted XPI** (AMO-signed) here, unlike Chrome/Edge on non-AD machines. Key:
`HKLM\SOFTWARE\Policies\Mozilla\Firefox\ExtensionSettings` (or `policies.json`).
Docs: <https://mozilla.github.io/policy-templates/#extensionsettings>. Firefox MV2
`webRequest` blocking is fully available; confirm the block fires.

**Also measure in C1:** how quickly the browser picks up the forcelist (fresh
launch vs. running-browser refresh), and whether a **standard user** can defeat
the extension by launching the browser with `--disable-extensions` (Chrome) — see
Key unresolved.

---

### Tier C2 — Full-URL per-video enforcement in the extension

With C1 proven, prove the actual product decision inside the extension, using the
shared normalization + evaluation order (default-deny YouTube + allow-one-video).

1. Policy: `youTubeDefault = BLOCK`; standing allow for `YOUTUBE_VIDEO:dQw4w9WgXcQ`.
2. Navigate `https://www.youtube.com/watch?v=9bZkp7q19f0` → **block page**
   (`blocked.html?u=<enc>` with reason).
3. Navigate `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → **plays**, including
   media streaming (confirm `*.googlevideo.com` and the other
   `YOUTUBE_PLAYBACK_SUPPORT_HOSTS` are not blocked while a video is approved —
   `shared/youtube/youtube-normalize.ts`).
4. Repeat the block via `youtu.be/9bZkp7q19f0`, `m.youtube.com/watch?v=…`,
   `/shorts/9bZkp7q19f0`, `/embed/9bZkp7q19f0`, and a URL with extra params
   `…watch?v=9bZkp7q19f0&t=30s&pp=abc` → **all block** (canonicalization).
5. **SPA route interception.** YouTube is a single-page app: after the first load,
   clicking a thumbnail changes the video via `history.pushState` and an InnerTube
   fetch, **without a full document navigation**. Confirm the extension catches
   this — via `chrome.webNavigation.onHistoryStateUpdated` and/or the
   `youtubei/v1/player` request in `onBeforeRequest` — and blocks a disallowed
   video reached by in-page navigation, not only by address-bar load. Record which
   signal fires first and the latency to block.
6. **Request Access.** On the block page, confirm the **Request Access** button
   posts the blocked canonical id to the native-messaging host (stub in
   `blocked.html`) which would forward it to the service → backend.

---

### Tier C3 — Hardened service

Prove the service that anchors everything the extension cannot protect itself
against.

1. **LocalSystem.** Install as a Windows service running as `LocalSystem`.
2. **Default security descriptor denies non-admin stop.** Confirm a **standard
   user** cannot `sc stop`, `net stop`, or kill it via Task Manager (the default
   service SD already denies `SERVICE_STOP` to non-admins) —
   <https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights>.
3. **Auto-restart on kill.** Configure `SERVICE_CONFIG_FAILURE_ACTIONS` with the
   `SERVICE_CONFIG_FAILURE_ACTIONS_FLAG` set so recovery actions apply even to a
   clean-looking termination; confirm the service **auto-restarts** after a forced
   kill (measure restart latency) —
   <https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsw>.
   Add a **mutual watchdog** (a lightweight second component that restarts the
   main service and vice-versa) and confirm killing one restores both.
4. **`%ProgramData%` DACL.** Store the signed offline policy cache under
   `%ProgramData%\<vendor>\` with an **explicit restrictive DACL** (SYSTEM +
   Administrators full; standard users read-only or no access). Confirm the
   standard child **cannot edit** the cached policy to forge an allow. (Default
   `%ProgramData%` inheritance grants `CREATOR OWNER`/`Users` more than we want —
   the explicit DACL is required.)
5. **Admin-child detection + parent alert.** The service checks whether the child
   account is a member of the local Administrators group (or is UAC-elevatable) and
   — per ADR-006 — **alerts the parent** rather than pretending to protect an admin
   child. Confirm the alert fires when the child is admin, and clears when the
   child is standard.

---

### Tier C4 — Anti-tamper / browser-policy from the service

Prove the service can write and hold the browser policy + OS-level anti-bypass
that the extension depends on. All exact keys/values are in
`windows/agent/policies/registry-policies.md`.

1. **Write HKLM browser policy** (Chrome/Edge/Firefox): force-install our
   extension; **block all other extensions** (`ExtensionInstallBlocklist = *`
   plus allowlist of our id); `QuicAllowed = 0`; `DnsOverHttpsMode = off`;
   `EncryptedClientHelloEnabled = 0`; `IncognitoModeAvailability = 1`;
   `DeveloperToolsAvailability = 2`. Confirm each takes effect (e.g. `chrome://policy`
   / `edge://policy` shows them; `about:config` locked for Firefox) and that a
   standard user cannot rewrite `HKLM\SOFTWARE\Policies\...` (ACL check).
   - `IncognitoModeAvailability` — <https://chromeenterprise.google/policies/#IncognitoModeAvailability>
   - `DeveloperToolsAvailability` — <https://chromeenterprise.google/policies/#DeveloperToolsAvailability>
     (blocking DevTools also blocks a trivial "disable the extension via DevTools" path)
   - `DnsOverHttpsMode` — <https://chromeenterprise.google/policies/#DnsOverHttpsMode>
   - `EncryptedClientHelloEnabled` — <https://chromeenterprise.google/policies/#EncryptedClientHelloEnabled>
   - `QuicAllowed` — <https://chromeenterprise.google/policies/#QuicAllowed>
2. **Block outbound UDP/443 for browsers** (QUIC/HTTP-3 escape hatch). Even with
   `QuicAllowed=0`, add a defense-in-depth Windows Firewall rule blocking outbound
   **UDP 443** for the browser executables, and for Firefox also set
   `network.http.http3.enable = false`. Confirm HTTP/3 is not used (so all traffic
   falls back to TCP/TLS where the extension is on-path) — see the `netsh advfirewall`
   command in `registry-policies.md`.
   Firewall docs: <https://learn.microsoft.com/windows/security/operating-system-security/network-security/windows-firewall/>.
3. **AppLocker publisher deny for non-approved browsers / WebView2 hosts.** Deny
   execution of browsers we do not filter (and standalone WebView2 host apps that
   would render web content outside our extensions) via **AppLocker publisher
   rules**. AppLocker enforcement works on Win11 Home after **KB5024351**. Prefer
   AppLocker's clean **"blocked by administrator"** dialog over silently killing
   processes by name (see §3, cautionary prior art). Confirm an unapproved browser
   (e.g. a portable Chromium, Brave, Opera) is **blocked at launch** with the
   standard dialog.
   Docs: <https://learn.microsoft.com/windows/security/application-security/application-control/app-control-for-business/applocker/applocker-overview>.
4. **Unsupported-browser posture.** Confirm the set {block other extensions} +
   {AppLocker deny other browsers} + {force-install in the three we support} leaves
   the child with **only** filtered browsers, each carrying our extension.

---

### Tier C5 — Clock / timezone tamper does not extend a grant

Per ADR-009, prove that a standard child cannot lengthen a temporary approval by
touching time.

1. Grant a **short** (e.g. 60-second) temporary allow for BLOCKED_VIDEO with a
   server-signed UTC `expiresAt`. Confirm it plays, then confirm it is **blocked
   again automatically** at expiry (extension re-evaluates against the shared
   `TemporaryRule` window using `EvalContext.nowMs`).
2. As the standard child, **change the time zone** forward (a standard user *can*
   change TZ; they **cannot** change the system clock — `SeSystemtimePrivilege` is
   Administrators-only). Confirm the grant does **not** extend (store/compare
   **UTC**, track duration with a **monotonic** clock, detect skew) —
   `SeSystemtimePrivilege` reference:
   <https://learn.microsoft.com/windows/security/threat-protection/security-policy-settings/change-the-system-time>.
3. Repeat **offline** (disconnect network after caching the grant) to prove local
   expiry without connectivity.

---

### Tier C6 — MITM proxy fallback *(EVALUATE ONLY — DO NOT IMPLEMENT)*

**Trigger condition (the only thing that promotes this tier):** a **concrete,
required** enforcement case is observed in C1–C5 that the policy-installed
extension path **cannot** cover. This PoC does not implement a proxy; it records
the decision criteria so the decision is made on evidence, not by default (ADR-005).

**Concrete cases that WOULD trigger evaluating a local, on-device MITM proxy:**

- **C1 fails:** `ExtensionInstallForcelist` + `webRequestBlocking` does **not**
  hold on non-domain-joined Win11 Home (extension won't force-install, is
  removable by the standard child, or the blocking handler doesn't fire). This is
  the primary trigger.
- **Un-extensible web surface that must be filtered:** a required target renders
  web content in a runtime that cannot host our extension (e.g. a WebView2/Electron
  app we must cover, a browser we cannot force-install into and cannot AppLocker-
  deny for a legitimate reason).
- **In-page bypass the extension can't see:** a required case where enforcement
  must happen below the browser (e.g. media fetched by a non-browser process).

**What a proxy would cost (documented so the trade-off is explicit, per
`ARCHITECTURE.md §10`):**

- A **locally-installed root CA** (trust-store write; itself a tamper surface a
  standard child cannot remove but an admin child can — ADR-006).
- A **certificate-pinning bypass list**: apps and sites that pin (many native
  apps, some Google endpoints) will **break** behind MITM and need exclusion,
  which reintroduces un-inspected traffic.
- **QUIC/HTTP-3 must be blocked** (UDP/443) so traffic is forced onto the
  interceptable TCP/TLS path — the same lever as C4.2, now mandatory.
- **UWP/AppContainer loopback caveat:** UWP/packaged apps cannot reach a
  `127.0.0.1` proxy without a loopback exemption; Edge and Store apps may not route
  through a local proxy cleanly.
- Traffic stays **on-device**; we never route child traffic through our cloud.

**Decision rule:** introduce MITM **only** for the specific surface that survives
uncovered, scoped as narrowly as possible, and record the triggering case in
`docs/DECISIONS.md` (ADR-005) before building anything.

---

## 3. Cautionary prior art (why AppLocker, not TerminateProcess)

Microsoft **Family Safety** filtered web content **only in Edge** and enforced it
against other browsers by **killing them by process name**. When Chrome changed
something, Family Safety kept terminating Chrome on launch for roughly **eight
months** (widely reported, 2024–2025), which read to families as "Chrome is
broken," not "Chrome is blocked." We deliberately **do not** silently
`TerminateProcess` competing browsers. We use **AppLocker publisher deny rules**,
which present the OS's own clean **"blocked by administrator"** dialog — honest,
attributable, and not mistaken for a crash. No consumer product currently ships
true **per-URL** control on Windows; that is exactly the gap this PoC probes, and
the honesty of the block UX is part of the product.

---

## 4. What this environment can and cannot do

- **Cannot** (this Linux box): build the service (Go/Rust/.NET), produce a signed
  browser package, publish to any store, write HKLM, register a Windows service,
  set AppLocker/firewall rules, or launch a Windows browser. No tier's
  **Observed** column can be filled here.
- **Can:** author the MV3 extension source (`windows/extension/`), the faithful JS
  port of the shared normalization, the block page, the service responsibilities
  and exact registry reference (`windows/agent/`), and this protocol. The TypeScript
  in `shared/` remains the spec; the JS port must match it (lockstep review).

---

## 5. Observed Results (fill on hardware)

| Test | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| C1-Chrome force-install on clean Win11 Home (personal MSA, non-domain-joined) | Auto-installs, "Installed by your organization" | | | **THE load-bearing question** |
| C1-Chrome standard child cannot disable/remove | Managed, not removable | | | |
| C1-Chrome `webRequestBlocking` onBeforeRequest actually blocks | Block fires | | | policy-installed keeps blocking webRequest |
| C1-Edge force-install (Edge Add-ons) | Auto-installs | | | non-AD limited to Add-ons |
| C1-Firefox force-install (ExtensionSettings, AMO XPI) | Auto-installs | | | self-host XPI allowed |
| C1 forcelist pickup latency (fresh vs running) | seconds | | | ___ s |
| C1 `--disable-extensions` defeats block? | Should not (or detected) | | | **key unknown** |
| C2 block BLOCKED_VIDEO (all URL forms) | Block page | | | |
| C2 allow ALLOWED_VIDEO plays + streams | Plays, googlevideo reachable | | | |
| C2 SPA in-page nav to blocked video | Blocked | | | which signal fires first? |
| C2 Request Access posts canonical id to native host | Round-trips | | | |
| C3 standard child cannot stop service | Denied (default SD) | | | |
| C3 auto-restart on forced kill | Restarts | | | ___ s restart |
| C3 mutual watchdog restores both | Restores | | | |
| C3 `%ProgramData%` DACL blocks policy edit | Denied | | | |
| C3 admin-child detection + parent alert | Alerts | | | |
| C4 HKLM browser policy applied (chrome://policy etc.) | All present | | | |
| C4 standard child cannot rewrite HKLM\Policies | Denied | | | |
| C4 UDP/443 blocked → no HTTP/3 | TCP/TLS only | | | |
| C4 AppLocker denies unapproved browser (clean dialog) | Blocked at launch | | | Home post-KB5024351 |
| C5 temp grant plays then auto-expires | Blocks at expiry | | | ___ s |
| C5 timezone change does not extend grant | No extension | | | UTC + monotonic |
| C5 offline expiry | Blocks at expiry | | | |

---

## 6. Key unresolved (the questions this PoC exists to answer)

1. **Force-install + `webRequestBlocking` on a clean, non-domain-joined Win11
   Home box with a personal Microsoft account** — does it actually install,
   resist removal by the standard child, and fire the blocking handler? *(the
   single load-bearing question; decides whether C6/MITM is promoted).*
2. **Which concrete cases, if any, force the MITM fallback** — enumerated in C6;
   none may materialize, which is the goal.
3. **AppLocker enforcement on Windows 11 Home** — does publisher deny actually
   enforce (not just audit) on Home post-KB5024351, with the clean "blocked by
   administrator" dialog?
4. **Standard vs. admin account boundaries** — precisely what the standard child
   can and cannot do (stop service, rewrite HKLM policy, remove extension, change
   clock vs. timezone); confirm the admin-child boundary matches ADR-006.
5. **`--disable-extensions` (and similar launch-flag) detection latency** — can a
   standard child launch a filtered browser with extensions disabled, and if so,
   how fast does the service detect and remediate it (or does AppLocker/command-line
   policy prevent the launch)?

## 7. Primary sources

- WFP overview (no HTTPS-path visibility at kernel/stream layer) — <https://learn.microsoft.com/windows/win32/fwp/>
- MV3 blocking `webRequest` kept for policy-installed extensions — <https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests>
- `ExtensionInstallForcelist` (Chrome; non-AD limits) — <https://chromeenterprise.google/policies/extension-install-forcelist/>
- Edge `ExtensionInstallForcelist` (non-AD → Add-ons only) — <https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/extensioninstallforcelist>
- Firefox `ExtensionSettings` (self-host XPI) — <https://mozilla.github.io/policy-templates/#extensionsettings>
- `declarativeNetRequest` limits — <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest>
- Service security & access rights (default SD denies non-admin stop) — <https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights>
- Service failure actions (auto-restart) — <https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsw>
- Protecting anti-malware services (PPL/ELAM — out of reach for a small vendor) — <https://learn.microsoft.com/windows/win32/services/protecting-anti-malware-services->
- AppLocker overview — <https://learn.microsoft.com/windows/security/application-security/application-control/app-control-for-business/applocker/applocker-overview>
- Change the system time (`SeSystemtimePrivilege` = Administrators) — <https://learn.microsoft.com/windows/security/threat-protection/security-policy-settings/change-the-system-time>
- Windows Firewall — <https://learn.microsoft.com/windows/security/operating-system-security/network-security/windows-firewall/>
- Chrome policy list (QuicAllowed, DnsOverHttpsMode, EncryptedClientHelloEnabled, IncognitoModeAvailability, DeveloperToolsAvailability) — <https://chromeenterprise.google/policies/>
- Edge browser policies — <https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/>
