#requires -RunAsAdministrator
# Stops + removes the Ajar service and the browser policies it wrote.
$ErrorActionPreference = "SilentlyContinue"
$exe = Join-Path (Join-Path $env:ProgramFiles "Ajar") "ajar-agent.exe"

Write-Host "==> Removing Ajar agent" -ForegroundColor Cyan
if (Test-Path $exe) {
  & $exe uninstall   # stops + deletes the service and removes HKLM browser policies
} else {
  sc.exe stop   AjarFamilyAgent | Out-Null
  sc.exe delete AjarFamilyAgent | Out-Null
}
Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles "Ajar") -ErrorAction SilentlyContinue
# Config under ProgramData is left in place by default; uncomment to remove:
# Remove-Item -Recurse -Force (Join-Path $env:ProgramData "Ajar")
Write-Host "==> Removed. Restart browsers to clear enforced policies." -ForegroundColor Cyan
