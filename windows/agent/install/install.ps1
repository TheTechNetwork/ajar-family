#requires -RunAsAdministrator
<#
  Installs the Family Filter agent as a hardened Windows service.
  Run in an ELEVATED PowerShell. Builds nothing — point -ExePath at a prebuilt
  familyfilter.exe (see windows/agent/README.md for the go build command).

  Example:
    .\install.ps1 -ExePath .\familyfilter.exe `
                  -ChromeExtensionId abcdefghijklmnopabcdefghijklmnop `
                  -EdgeExtensionId   abcdefghijklmnopabcdefghijklmnop `
                  -BackendUrl http://localhost:8787 `
                  -ChildUser  "DESKTOP-XYZ\Jane"
#>
param(
  [Parameter(Mandatory)] [string] $ExePath,
  [string] $ChromeExtensionId = "",
  [string] $EdgeExtensionId   = "",
  [string] $BackendUrl        = "http://localhost:8787",
  [string] $ChildUser         = ""
)
$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:ProgramFiles "FamilyFilter"
$dataDir    = Join-Path $env:ProgramData "FamilyFilter"
$exeDest    = Join-Path $installDir "familyfilter.exe"

Write-Host "==> Installing Family Filter agent" -ForegroundColor Cyan

# 1. Program files: copy the binary.
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $ExePath $exeDest

# 2. ProgramData: config + restrictive ACL (only SYSTEM + Administrators; NO Users).
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
icacls $dataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
@{
  chromeExtensionId = $ChromeExtensionId
  edgeExtensionId   = $EdgeExtensionId
  backendUrl        = $BackendUrl
  reapplyMinutes    = 5
  antiBypass        = $true
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $dataDir "config.json")

# 3. Create + start the service (auto-start, auto-restart) via the exe.
& $exeDest install

# 4. Confirm the default service SD already denies SERVICE_STOP to non-admins.
Write-Host "Service security descriptor:" -ForegroundColor DarkGray
sc.exe sdshow FamilyFilterAgent

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

Write-Host "==> Done. Check: sc.exe query FamilyFilterAgent  |  familyfilter.exe status" -ForegroundColor Cyan
