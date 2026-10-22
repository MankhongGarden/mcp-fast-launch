$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Write-Host '== What auto-onboard would change today (dry run) =='
node "$root\onboard.mjs" --dry-run
if ($LASTEXITCODE -ne 0) { throw "dry run failed (exit $LASTEXITCODE)" }

New-Item -ItemType File -Force "$root\onboard.enabled" | Out-Null
Write-Host "`n== Enabled ($root\onboard.enabled). Running one real pass now =="
node "$root\onboard.mjs" --now
Write-Host "`nLast log lines ($root\onboard.log):"
Get-Content "$root\onboard.log" -Tail 5
Write-Host "`nFrom now on it runs at most once an hour, started by any MCP server that uses the launcher."
Write-Host "Turn off: pwsh -File $root\disable-onboard.ps1"
