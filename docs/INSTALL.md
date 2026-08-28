# Install Ajar — prebuilt binaries (no Node, no Go)

The target machine needs **nothing installed** — no Node, no Go, no toolchain.
You download two things and run them. Each step has the **✅ result** to expect.

> **Where the pieces live in production**
> - **Backend** (API + parent console): runs in the cloud on **Cloudflare
>   Workers** — nothing on the child's box. (You *can* self-host the same
>   backend as one binary; see §4.)
> - **Child's Windows PC**: only the **Ajar service** (`familyfilter.exe`, a
>   single static binary) + the **browser extension** (from the store).
> - **Parent**: the console in any browser (served by the backend at `/`).

Download the latest binaries from the repo's **Releases** page:
`https://github.com/00o-sh/contentfilter/releases/latest`

---

## 1. Get the files (1 min)

From Releases, download:

- `familyfilter-windows-amd64.exe` — the Ajar service (use `arm64` on ARM PCs).
- (Self-host only) `ajar-backend-windows-x64.zip` (or `-macos-arm64` / `-linux-x64`).

✅ You have a `.exe` (and optionally a `.zip`). No installer, no runtime.

---

## 2. Install the Ajar service on the child's PC (2 min)

Open **PowerShell as Administrator**, `cd` to the download folder, then:

```powershell
.\familyfilter-windows-amd64.exe install `
  -BackendUrl https://api.ajar.family `
  -ChromeExtensionId <STORE_EXTENSION_ID> `
  -ChildUser "$env:COMPUTERNAME\Jane"
```

**Test:** `sc.exe query FamilyFilterAgent`
✅ `STATE : 4  RUNNING`.

**Test (tamper-resist):** from the child's **standard** account, run
`sc.exe stop FamilyFilterAgent`
✅ `Access is denied.`

> If install prints `WARNING: … IS A LOCAL ADMINISTRATOR`, the child account can
> undo everything. Make it a **Standard** account before real use.

---

## 3. Install the browser extension (1 min)

The service force-installs it by policy on next browser launch. To confirm:

1. Close and reopen Chrome/Edge on the child's account.
2. Visit any blocked YouTube video.

✅ You land on the **Ajar** "You can ask to unlock this video" page.

---

## 4. (Optional) Self-host the backend as one binary

Only if you're **not** using the cloud backend. The backend is one
self-contained executable that serves **both** the API and the parent console —
no Node required.

```powershell
# Windows
Expand-Archive ajar-backend-windows-x64.zip -DestinationPath ajar-backend
cd ajar-backend
$env:AUTH_SECRET="<a-long-random-secret>"
.\ajar-backend.exe            # leave running
```

```bash
# macOS / Linux
unzip ajar-backend-macos-arm64.zip -d ajar-backend && cd ajar-backend
AUTH_SECRET="<a-long-random-secret>" ./ajar-backend   # leave running
```

**Test:** open `http://localhost:8787/` in a browser.
✅ The **Ajar Parent Console** loads (and `curl http://localhost:8787/v1/health`
returns `{"status":"ok",...}`).

Point the service's `-BackendUrl` at this host instead of the cloud URL.

**Make it durable** (survives restart) and stable across restarts:

| Env var | What it does |
|---|---|
| `DATABASE_FILE` | Path to a SQLite file → data persists across restarts. |
| `AUTH_SECRET` | Bearer-token secret. Set it to anything real. |
| `SIGNING_PUBLIC_KEY_B64` / `SIGNING_PRIVATE_KEY_B64` | Stable policy-signing keypair (else a dev key is generated each boot). |
| `PORT` | Listen port (default `8787`). |

---

## 5. Parent: approve in seconds

1. Open the console (cloud URL, or `http://localhost:8787/` when self-hosting).
2. **Register** → **Create family** → **Add child** → **Enroll a device**
   (enter the 6-digit code in the child's extension → Options).
3. When the child asks, the ask appears **live**. Tap **Say yes**.

✅ The child's page unlocks within seconds; every other video stays closed.

---

### Where each binary comes from

| Binary | Built by | Toolchain on the box? |
|---|---|---|
| `familyfilter-*.exe` | Go, cross-compiled in CI (`.github/workflows/release.yml`) | **None** — static binary |
| `ajar-backend-*` | Node SEA, built per-OS in CI (`backend/scripts/build-sea.mjs`) | **None** — Node is baked in |
| Browser extension | Published to Chrome Web Store / Edge Add-ons | **None** — installed by policy |

The Node/Go you see in `docs/DEMO_WINDOWS.md` is only for building **from
source** on a dev machine. Families use the prebuilt binaries above.
