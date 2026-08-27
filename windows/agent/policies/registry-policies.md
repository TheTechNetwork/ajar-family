# Windows browser & anti-bypass policies applied by the agent

Concrete reference for the exact machine (`HKLM`) policy values the hardened
service writes to make the force-installed extension (PoC C, Tier 1) actually
enforce, plus the anti-bypass choke points (Tier 3). These are **documented OS
policy mechanisms**, not hacks. The service applies them; a **standard (non-admin)
child cannot alter `HKLM\SOFTWARE\Policies`**, an admin child can (ADR-006, so the
agent detects admin-child and alerts the parent).

> These close the gaps that would otherwise let a child slip past the extension
> (ECH hiding SNI, browser DoH, QUIC bypassing inspection, private mode, dev
> tools, sideloaded/other browsers). None of it decrypts traffic — there is **no
> TLS interception** in the default architecture (ADR-005). Cite sources below.

## 1. Force-install the enforcement extension + block all others

### Chrome — `HKLM\SOFTWARE\Policies\Google\Chrome`
| Value | Type | Data | Purpose |
|---|---|---|---|
| `ExtensionInstallForcelist\1` | REG_SZ | `<EXT_ID>;https://clients2.google.com/service/update2/crx` | Force-install + prevent uninstall. On non-domain-joined Win11 Home this works **only for Chrome-Web-Store-published** extensions. |
| `ExtensionInstallBlocklist\1` | REG_SZ | `*` | Block every other extension. |
| `ExtensionInstallAllowlist\1` | REG_SZ | `<EXT_ID>` | Allowlist our extension (+ any explicitly permitted). |

### Edge — `HKLM\SOFTWARE\Policies\Microsoft\Edge`
Same three value names; force-install limited to **Microsoft Edge Add-ons** on
non-AD machines. Use the Edge Add-ons update URL
`https://edge.microsoft.com/extensionwebstorebase/v1/crx`.

### Firefox — `HKLM\SOFTWARE\Policies\Mozilla\Firefox`
Use `ExtensionSettings` (JSON in `policies.json` or the registry tree):
`{"*":{"installation_mode":"blocked"},"<id>@vendor":{"installation_mode":"force_installed","install_url":"https://.../latest.xpi"}}`.
Firefox has no domain-join restriction (AMO signing required). Also set
`Certificates\ImportEnterpriseRoots=1` **only** if the (optional, fallback) MITM
tier is ever enabled — not in the default architecture.

## 2. Kill ECH / DoH so the network layer stays legible (defense-in-depth)

| Value (Chrome/Edge key) | Type | Data | Purpose |
|---|---|---|---|
| `DnsOverHttpsMode` | REG_SZ | `off` | Stop browser-internal DoH (also suppresses Chrome ECH, which needs its own DoH to fetch the ECHConfig). |
| `BuiltInDnsClientEnabled` | REG_DWORD | `0` | Force use of the system resolver. |
| `EncryptedClientHelloEnabled` | REG_DWORD | `0` | Disable ECH so SNI stays visible for the DNS/domain layer. |

Firefox (`policies.json`): `"DNSOverHTTPS":{"Enabled":false,"Locked":true}` and
`"Preferences":{"network.dns.echconfig.enabled":{"Value":false,"Status":"locked"}}`
(Firefox 129+ can get the ECHConfig via the OS resolver, so lock the pref too).

Windows resolver: Group Policy **"Configure DNS over HTTPS (DoH) name resolution" →
Prohibit DoH**, plus `netsh dnsclient set global doh=no ddr=no`, and
`Set-DnsClientDohServerAddress -AutoUpgrade $false` for the built-in known-DoH
servers. Firewall-block known third-party DoH/DoT endpoints as a further layer.

## 3. Kill QUIC/HTTP-3 (so there is no UDP path around inspection/logging)

| Value (Chrome/Edge key) | Type | Data |
|---|---|---|
| `QuicAllowed` | REG_DWORD | `0` |

Firefox: `network.http.http3.enable` locked `false`. Belt-and-braces at the
firewall (scope to browser executables to avoid breaking Meet/Teams/games):
`New-NetFirewallRule -DisplayName "Block browser QUIC" -Direction Outbound -Program "<chrome.exe>" -Protocol UDP -RemotePort 443 -Action Block`.

## 4. Close private mode, dev tools, guest/other profiles

| Value (Chrome/Edge key) | Type | Data | Purpose |
|---|---|---|---|
| `IncognitoModeAvailability` | REG_DWORD | `1` | Disable Incognito/InPrivate (extensions don't run there by default). |
| `DeveloperToolsAvailability` | REG_DWORD | `2` | Prevent source tampering / request replay. |
| `BrowserGuestModeEnabled` | REG_DWORD | `0` | No guest profile (bypasses profile policy state). |
| `BrowserAddPersonEnabled` | REG_DWORD | `0` | No new profiles. |

Native fallback if the extension is ever disabled: `URLBlocklist` / `URLAllowlist`
(~1000-entry cap) as a coarse safety net.

## 5. Block unsupported browsers (AppLocker, not process-killing)

Prefer **AppLocker publisher deny-rules** over silent `TerminateProcess` (the
Microsoft Family Safety cautionary tale — a name-based kill list broke Chrome for
~8 months). AppLocker enforces on Windows 11 Home post-KB5024351; it produces a
clean "blocked by your administrator" dialog and an event-log entry. Deny known
non-approved browser vendors (Brave, Opera, Vivaldi, Tor, portable builds) and
WebView2 host executables that a child could use as a bare browser; **use
publisher/hash conditions, never user-writable path allowances** (`%LOCALAPPDATA%`,
`C:\Windows\Tasks`).

`--disable-extensions` has no policy block; the service detects a browser launched
with it via ETW `Microsoft-Windows-Kernel-Process` and terminates+relaunches,
telling the child why (documented, not stealth).

## Sources
- Chrome ExtensionInstallForcelist — <https://chromeenterprise.google/policies/extension-install-forcelist/>
- Chrome policy list (Quic/DoH/ECH/Incognito/DevTools) — <https://chromeenterprise.google/policies/>
- Edge browser policies — <https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/>
- Blocking web requests / policy-installed MV3 keeps webRequestBlocking — <https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests>
- Firefox ExtensionSettings — <https://mozilla.github.io/policy-templates/>
- Windows DoH client — <https://learn.microsoft.com/windows-server/networking/dns/doh-client-support>
- AppLocker requirements — <https://learn.microsoft.com/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker>
