$flag = Join-Path $PSScriptRoot 'onboard.enabled'
if (Test-Path $flag) { Remove-Item $flag; Write-Host 'MCP auto-onboard disabled.' } else { Write-Host 'MCP auto-onboard was already off.' }
