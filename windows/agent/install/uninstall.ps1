#requires -RunAsAdministrator
# Stops + removes the Family Filter service and the browser policies it wrote.
$ErrorActionPreference = "SilentlyContinue"
$exe = Join-Path (Join-Path $env:ProgramFiles "FamilyFilter") "familyfilter.exe"

Write-Host "==> Removing Family Filter agent" -ForegroundColor Cyan
if (Test-Path $exe) {
  & $exe uninstall   # stops + deletes the service and removes HKLM browser policies
} else {
  sc.exe stop   FamilyFilterAgent | Out-Null
  sc.exe delete FamilyFilterAgent | Out-Null
}
Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles "FamilyFilter") -ErrorAction SilentlyContinue
# Config under ProgramData is left in place by default; uncomment to remove:
# Remove-Item -Recurse -Force (Join-Path $env:ProgramData "FamilyFilter")
Write-Host "==> Removed. Restart browsers to clear enforced policies." -ForegroundColor Cyan
