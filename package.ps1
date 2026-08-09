# Build all platform binaries, bundle the extension, and produce a .vsix.
# Run this after making changes to src/ or core/.

$ErrorActionPreference = "Stop"

Write-Host "=== building all + packaging ===" -ForegroundColor Cyan

# Remove old .vsix so we don't accumulate stale packages.
Get-ChildItem mf-agent-*.vsix -ErrorAction SilentlyContinue | Remove-Item

npm run package
if ($LASTEXITCODE -ne 0) { throw "package failed" }

$vsix = Get-ChildItem mf-agent-*.vsix | Select-Object -First 1
if ($vsix) {
    Write-Host "=== done: $($vsix.Name) ($([math]::Round($vsix.Length / 1MB, 1)) MB) ===" -ForegroundColor Green
} else {
    throw "no .vsix produced"
}
