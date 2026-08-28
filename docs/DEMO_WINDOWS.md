# Deploy & test — Windows end-to-end (alpha)

> **Just want to install it?** Use **[INSTALL.md](INSTALL.md)** — download two
> prebuilt binaries, no Node or Go on the box. **This page is the build-from-source
> developer demo** (it compiles everything locally), useful for hacking on Ajar.

Full loop on one Windows 11 machine: backend + parent console + browser extension
+ hardened service. **Each step has a test and the ✅ result to expect.** Do them
in order. Times are rough.

**Prereqs (from-source only):** Node 22, Go 1.24+, Chrome or Edge, a **standard
(non-admin) child account** for the real test (you can dry-run as admin).
PowerShell as Admin for the service steps.

---

## A. Backend (2 min)

```powershell
git clone https://github.com/00o-sh/contentfilter && cd contentfilter
npm ci ; npm run build
cd backend ; $env:AUTH_SECRET="dev" ; node dist/index.js   # leave running
```
**Test:** new terminal → `curl http://localhost:8787/v1/health`
✅ `{"status":"ok","version":"0.0.0-alpha"}`

---

## B. Parent console (30 sec)

The backend from step A already serves the console — no separate web server.

1. Open `http://localhost:8787/` → **Register** (any email + name).
2. **Create family** → **Add child** "Jane" → click **Enroll a device**.

**Test:** an enrollment **code** (6 digits) appears.
✅ e.g. `482913`. Keep it — it expires in 15 min.

---

## C. Windows service (5 min)

```powershell
cd windows\agent
$env:GOOS="windows"; $env:GOARCH="amd64"; go build -o familyfilter.exe .
# Elevated PowerShell for install:
.\install\install.ps1 -ExePath .\familyfilter.exe -ChromeExtensionId PLACEHOLDER `
  -BackendUrl http://localhost:8787 -ChildUser "$env:COMPUTERNAME\Jane"
```
**Test 1 — service running:** `sc.exe query FamilyFilterAgent`
✅ `STATE : 4 RUNNING`.

**Test 2 — non-admin can't stop it:** from a **standard** user shell:
`sc.exe stop FamilyFilterAgent`
✅ `Access is denied.` (default service SD denies non-admin stop.)

**Test 3 — auto-restart:** elevated: `taskkill /IM familyfilter.exe /F` → wait 5 s →
`sc.exe query FamilyFilterAgent`
✅ back to `RUNNING` (SCM recovery restarts it).

**Test 4 — admin-child warning:** if you passed an admin `-ChildUser`, install prints
`WARNING: … IS A LOCAL ADMINISTRATOR`. ✅ Warning shown. (Make the child Standard for real use.)

**Test 5 — policies written:**
`reg query "HKLM\SOFTWARE\Policies\Google\Chrome" /v QuicAllowed`
✅ `QuicAllowed  REG_DWORD  0x0`. (Also `DnsOverHttpsMode=off`, `IncognitoModeAvailability=1`.)

> Note: real force-install needs the extension **published** to the Chrome Web
> Store/Edge Add-ons and its ID in `-ChromeExtensionId`. For this demo you load it
> unpacked (Part D); the policies still apply and are testable as above.

---

## D. Extension: enroll (2 min)

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → pick
   `windows\extension\`.
2. Click the extension's **Details → Extension options**.
3. Backend URL `http://localhost:8787` + the **code** from Part B → **Enroll**.

**Test:** options page shows **"Enrolled. Device … for child …"**.
✅ Enrolled.

---

## E. The MVP test (2 min) — the whole point

1. Browse to `https://www.youtube.com/watch?v=9bZkp7q19f0`.
   ✅ **Blocked** — redirected to the extension's block page (default-deny YouTube).
2. Click **Request Access** (add a reason, optional).
   ✅ In the **parent console**, a pending request appears within ~3 s.
3. In the parent console: scope **THIS_VIDEO**, click **Allow 30m**.
   ✅ Toast "Approved…".
4. Back in Chrome, **reload** the video.
   ✅ **It plays** — within a few seconds (the extension long-poll picked up the signed policy).
5. Open a **different** video `…watch?v=dQw4w9WgXcQ`.
   ✅ **Still blocked** (only the one video was approved).
6. Wait 30 min (or approve with **Once**) → reload the approved video.
   ✅ **Blocked again** (temporary grant auto-expired).

**That's the success test:** default-deny YouTube → approve one video → plays in
seconds → others blocked → auto-expires. No VPN, no TLS interception.

---

## Cleanup

```powershell
# elevated
cd windows\agent ; .\install\uninstall.ps1     # stop+remove service, remove policies
# stop the backend terminal (Ctrl+C); remove the unpacked extension in chrome://extensions
```

## If something's off (fast checks)
- Extension not enforcing → reload it in `chrome://extensions`; re-check Options shows Enrolled.
- Request not showing → confirm backend terminal is up; parent console Backend URL = `http://localhost:8787`.
- Approved video still blocked → give it ~5 s (long-poll); hard-reload (Ctrl+F5).
- Service won't install → PowerShell must be **elevated**; `familyfilter.exe status`.
- `curl` health fails → backend terminal died; restart Part A.
