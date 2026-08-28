# Windows agent — hardened service (PoC C)

The on-device authority for Windows enforcement. A single always-on Windows
**service** running as **LocalSystem** that syncs policy, feeds the policy-installed
browser extensions, writes browser + OS anti-tamper policy, and detects
circumvention. The browser extension (`windows/extension/`) is the per-URL
enforcement engine; **this service is what makes the extension trustworthy and
hard to remove** on a **standard (non-admin) child account**.

Under **ADR-005**, Windows starts **without TLS interception**. Under **ADR-006**,
the child **must** be a standard (non-admin) account. See
`docs/WINDOWS_FILTER_POC.md` for the tiered experiment protocol (this service is
Tiers C3–C5; the extension is C1–C2).

## Implementation (v1, built)

A single Go binary (`familyfilter.exe`, no external runtime). What it does today:
**applies the HKLM browser policies** (force-install the extension, block others,
kill QUIC/DoH/ECH, disable incognito/devtools/guest — see
`policies/registry-policies.md`), **re-applies on a watchdog tick**, **warns if the
child account is an administrator** (ADR-006), runs as an **auto-start,
auto-restart** service whose default SD already denies `SERVICE_STOP` to
non-admins. No TLS interception, no stealth/rootkit techniques.

```powershell
# Build (from windows/agent/, needs Go 1.24+). Cross-compiles from any OS:
$env:GOOS="windows"; $env:GOARCH="amd64"; go build -o familyfilter.exe .

# Install (elevated PowerShell): copies the exe, writes an ACL-locked config,
# creates+starts the service, checks the child isn't an admin.
.\install\install.ps1 -ExePath .\familyfilter.exe `
  -ChromeExtensionId <webstore-id> -BackendUrl http://localhost:8787 -ChildUser "PC\Jane"

familyfilter.exe status     # service + console-user admin state
familyfilter.exe apply      # (elevated) apply policies once, without the service — for testing
.\install\uninstall.ps1     # stop + remove service and policies
```

Subcommands: `install | uninstall | run | apply | status | version`.
Config: `%ProgramData%\FamilyFilter\config.json` (see `config.example.json`).
Full walkthrough with per-step tests: `docs/DEMO_WINDOWS.md`.

**Not yet in v1 (documented follow-ups):** the native-messaging host for the
signed-policy production path (the extension currently uses the backend HTTP mode
directly), AppLocker deny-rules for other browsers, the UDP/443 firewall rule, and
ETW `--disable-extensions` detection. These are additive and listed in
`docs/WINDOWS_FILTER_POC.md`.

## Language recommendation

- **Recommended: Go or Rust** — a **single static binary** for the service. No
  runtime to install or tamper with, small attack surface, straightforward Win32
  service + registry + firewall interop (Go `golang.org/x/sys/windows/svc`; Rust
  `windows-rs`). A static binary is easy to sign and to verify from the watchdog.
- **Acceptable: C#/.NET** (Worker Service / `sc.exe` install). First-class Windows
  APIs and the cleanest service tooling, at the cost of a runtime dependency;
  publish **self-contained/AOT** to avoid a separate .NET install as a tamper
  surface.
- Whatever the language, the service is **transparent and admin-owned** — no
  stealth persistence, no rootkit/hooking (`ARCHITECTURE.md §9`).

## Responsibilities

1. **Policy sync + signed offline cache.** Pull signed, versioned
   `DevicePolicySnapshot`s from the backend (incremental "since vN", full sync as
   fallback; WS/SSE for immediate push on approval). **Verify the Ed25519
   signature** over the canonical JSON before use; reject unsigned/altered
   snapshots (**fail closed** for YouTube/protected, **fail open** for ordinary
   network errors — `ARCHITECTURE.md §8`). Persist the verified snapshot under
   `%ProgramData%` with a restrictive DACL (below) so rules and active temporary
   grants keep working offline.
2. **Native-messaging host for the extensions.** Register a native-messaging host
   (Chrome/Edge/Firefox) so the extension receives the verified snapshot and posts
   AccessRequests back. The service is the only component with backend
   credentials; the extension never talks to the backend directly. Include the
   server-anchored UTC time with each push so the extension can run a monotonic
   grant clock (ADR-009).
3. **HKLM browser-policy writer.** Write and continuously reassert the Chrome/Edge/
   Firefox policy keys (force-install our extension by ID, block other extensions,
   `QuicAllowed=0`, `DnsOverHttpsMode=off`, `EncryptedClientHelloEnabled=0`,
   `IncognitoModeAvailability=1`, `DeveloperToolsAvailability=2`). Exact keys/values
   in `policies/registry-policies.md`. Reassert on a timer so a transient edit is
   corrected quickly.
4. **Firewall / AppLocker anti-bypass.** Block outbound **UDP/443** for the browser
   executables (QUIC/HTTP-3 escape hatch; defense in depth behind `QuicAllowed=0`),
   and deny non-approved browsers / standalone WebView2 hosts via **AppLocker
   publisher rules** (clean "blocked by administrator" dialog — never silent
   `TerminateProcess`; see the Family Safety cautionary note in the PoC doc).
   Commands/rules in `policies/registry-policies.md`.
5. **Watchdog.** `SERVICE_CONFIG_FAILURE_ACTIONS` (+ the failure-actions flag) for
   auto-restart on kill, plus a **mutual watchdog** (a second lightweight component
   that restarts the main service and vice-versa) so killing one restores both.
   The default service security descriptor already denies `SERVICE_STOP` to
   non-admins —
   <https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights>.
6. **Admin-child detection.** Check whether the child account is a local
   Administrator (or trivially UAC-elevatable) and **alert the parent** — per
   ADR-006 we do not claim protection we cannot provide against an admin child.
7. **UTC + monotonic grant expiry.** Enforce temporary-approval expiry against the
   server-signed UTC `expiresAt`, tracked with a **monotonic** clock, with
   clock/timezone-skew detection. A standard user can change the **time zone** (not
   the system clock — `SeSystemtimePrivilege` is Administrators-only), so store and
   compare in **UTC** and never let a TZ change extend a grant (ADR-009):
   <https://learn.microsoft.com/windows/security/threat-protection/security-policy-settings/change-the-system-time>.

## `%ProgramData%` cache DACL

Store the signed snapshot + service state under `%ProgramData%\<vendor>\`. The
default `%ProgramData%` ACL is too permissive for our purposes, so set an
**explicit restrictive DACL**: `SYSTEM` and `Administrators` full control; the
standard child **read-only or no access**, with inheritance disabled so a child
cannot edit the cache to forge an allow or roll back a policy version. Verified in
Tier C3.

## Browser-policy registry keys this service writes

Full paths + values (Chrome/Edge/Firefox) are in
[`policies/registry-policies.md`](policies/registry-policies.md). Summary of the
keys, all under `HKLM` (machine policy, standard users cannot write there):

| Intent | Chrome / Edge policy | Firefox |
|---|---|---|
| Force-install our extension by ID | `ExtensionInstallForcelist` | `ExtensionSettings` → `force_installed` |
| Block all other extensions | `ExtensionInstallBlocklist = *` (+ allow our id) | `ExtensionSettings` `"*": { installation_mode: "blocked" }` |
| Disable QUIC/HTTP-3 | `QuicAllowed = 0` | `network.http.http3.enable = false` (via `Preferences`) |
| Disable browser DoH | `DnsOverHttpsMode = off` | `DNSOverHTTPS` `Enabled=false`, `Locked=true` |
| Disable Encrypted Client Hello | `EncryptedClientHelloEnabled = 0` | `network.dns.echconfig.enabled = false` |
| Disable Incognito/Private | `IncognitoModeAvailability = 1` | `DisablePrivateBrowsing = true` |
| Disable DevTools | `DeveloperToolsAvailability = 2` | `DisableDeveloperTools = true` |

Policy doc URLs are cited in `policies/registry-policies.md`.

## Standard-account requirement (non-negotiable)

Per ADR-006, the child **must** be a **standard (non-admin) account**. Everything
above — service-stop denial, HKLM policy, `%ProgramData%` DACL, AppLocker,
firewall — holds against a standard user and is **bypassable by a local admin**.
An admin child can uninstall the service, remove the CA/policy, and edit the cache.
**PPL/ELAM** is the only mechanism that resists a local admin, and it is **out of
reach for a small vendor** (ELAM signing / anti-malware attestation) —
<https://learn.microsoft.com/windows/win32/services/protecting-anti-malware-services->.
The service therefore **detects admin-child and alerts the parent** rather than
pretending to protect it.

## MITM is NOT built — and the criteria that would justify it

Per **ADR-005**, this service does **not** perform TLS interception. No root CA is
installed, no traffic is decrypted. A local, **on-device** MITM proxy is a
documented **fallback** (Tier C6 in `docs/WINDOWS_FILTER_POC.md`), evaluated only
if a **concrete required case** cannot be covered by the extension + service path.
The criteria that would trigger evaluating it (and recording the decision in
`docs/DECISIONS.md`, ADR-005):

1. **The load-bearing question fails:** `ExtensionInstallForcelist` +
   `webRequestBlocking` does **not** hold on a clean, non-domain-joined Win11 Home
   box (won't force-install, removable by the standard child, or the blocking
   handler doesn't fire).
2. **An un-extensible web surface must be filtered** — a required target renders
   web content in a runtime that cannot host our extension (a WebView2/Electron app
   we must cover; a browser we can neither force-install into nor legitimately
   AppLocker-deny).
3. **Enforcement must happen below the browser** — a required case where the child
   fetches gated media from a non-browser process.

Even then MITM would be scoped as narrowly as possible and would carry the costs
enumerated in the PoC doc (root-CA trust surface, pinning-bypass list, mandatory
QUIC block, UWP/AppContainer loopback caveat), and traffic would stay **on-device**
— never routed through our cloud.
