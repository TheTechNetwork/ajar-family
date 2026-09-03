#requires -RunAsAdministrator
<#
  Installs the Ajar agent as a hardened Windows service.
  Run in an ELEVATED PowerShell. Builds nothing — point -ExePath at a prebuilt
  ajar-agent.exe (see windows/agent/README.md for the go build command).

  Example:
    .\install.ps1 -ExePath .\ajar-agent.exe `
                  -ChromeExtensionId abcdefghijklmnopabcdefghijklmnop `
                  -EdgeExtensionId   abcdefghijklmnopabcdefghijklmnop `
                  -BackendUrl http://localhost:8787 `
                  -ChildUser  "DESKTOP-XYZ\Jane"
#>
param(
  [Parameter(Mandatory)] [string] $ExePath,
  # AT LEAST ONE EXTENSION ID IS REQUIRED, checked below. These were plain
  # optional strings, so an install with neither set produced a running service
  # that wrote no policies at all: no forcelist, no incognito block, no devtools
  # block. It reported success and enforced nothing.
  [string] $ChromeExtensionId = "",
  [string] $EdgeExtensionId   = "",
  [string] $BackendUrl        = "http://localhost:8787",
  [string] $ChildUser         = ""
)
$ErrorActionPreference = "Stop"

# `$ErrorActionPreference = "Stop"` DOES NOT TRAP A NATIVE EXE'S EXIT CODE. It
# governs PowerShell errors; icacls, sc.exe and ajar-agent.exe can each fail
# loudly, set $LASTEXITCODE, and the script sails on to print "Done." That is how
# an install ends with %ProgramData%\Ajar still inheriting permissions the child
# can write, or with no service at all, while telling the parent it worked.
function Invoke-Checked {
  param([Parameter(Mandatory)][scriptblock] $Do, [Parameter(Mandatory)][string] $What)
  & $Do
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

if (-not $ChromeExtensionId -and -not $EdgeExtensionId) {
  throw "Give -ChromeExtensionId and/or -EdgeExtensionId. Without one, the agent installs, runs, and enforces nothing."
}
foreach ($pair in @(@{n="-ChromeExtensionId"; v=$ChromeExtensionId}, @{n="-EdgeExtensionId"; v=$EdgeExtensionId})) {
  if ($pair.v -and $pair.v -notmatch '^[a-p]{32}$') {
    throw "$($pair.n) '$($pair.v)' is not an extension id (32 letters a-p). A wrong id installs nothing while still blocking every other extension."
  }
}

$installDir = Join-Path $env:ProgramFiles "Ajar"
$dataDir    = Join-Path $env:ProgramData "Ajar"
$exeDest    = Join-Path $installDir "ajar-agent.exe"

Write-Host "==> Installing Ajar agent" -ForegroundColor Cyan

# 1. Program files: copy the binary.
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $ExePath $exeDest

# 2. ProgramData: config + restrictive ACL (only SYSTEM + Administrators; NO Users).
#    NOT optional: %ProgramData% grants Users create-file by default, so without
#    this the child can rewrite the config the service reads.
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Invoke-Checked -What "Hardening the ACL on $dataDir" -Do {
  icacls $dataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
}
@{
  chromeExtensionId = $ChromeExtensionId
  edgeExtensionId   = $EdgeExtensionId
  backendUrl        = $BackendUrl
  reapplyMinutes    = 5
  antiBypass        = $true
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $dataDir "config.json")

# 3. Create + start the service (auto-start, auto-restart) via the exe.
Invoke-Checked -What "Installing the AjarFamilyAgent service" -Do { & $exeDest install }

# 4. Confirm the default service SD already denies SERVICE_STOP to non-admins.
Write-Host "Service security descriptor:" -ForegroundColor DarkGray
sc.exe sdshow AjarFamilyAgent

# 5. ADR-006: the child must be a STANDARD (non-admin) account.
if ($ChildUser) {
  $short = $ChildUser.Split('\')[-1]
  $isAdmin = (Get-LocalGroupMember -Group "Administrators" -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -like "*\$short" -or $_.Name -eq $short })
  if ($isAdmin) {
    Write-Warning "CHILD ACCOUNT '$ChildUser' IS A LOCAL ADMINISTRATOR. Protections are bypassable. Make the child a Standard user (Settings > Accounts) before relying on this."
  } else {
    Write-Host "OK: '$ChildUser' is a standard (non-admin) account." -ForegroundColor Green
  }
}

Write-Host "==> Done. Check: sc.exe query AjarFamilyAgent  |  ajar-agent.exe status" -ForegroundColor Cyan
