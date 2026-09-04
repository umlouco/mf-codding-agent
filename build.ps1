<#
.SYNOPSIS
    Builds the MF Agent VS Code extension: Go core, TypeScript bundle, and optionally a .vsix.

.DESCRIPTION
    One entry point for every build this repo needs, runnable from any directory.

    Defaults to a host-only core build, which is what you want while iterating.
    -Package switches to all six shipping targets, because a .vsix carrying only
    your own platform's binaries installs fine and then fails to start for
    everyone else.

.PARAMETER Targets
    host = build the Go core for this machine only (fast; the default).
    all  = cross-compile Windows, macOS and Linux on x64 and arm64.

.PARAMETER Package
    Produce mf-agent-<version>.vsix. Implies -Targets all unless -Targets is
    passed explicitly.

.PARAMETER Install
    Install the packaged .vsix into VS Code. Implies -Package.

.PARAMETER Bump
    Raise the version in package.json and package-lock.json before building:
    patch, minor, major, or none. Packaging bumps the patch version unless told
    otherwise, so every .vsix carries a version VS Code installs as an update;
    a plain host build bumps nothing unless asked. Nothing is committed or
    tagged -- that stays yours to do.

.PARAMETER Watch
    Rebuild the TypeScript bundle on every change and stay running. Skips the
    core build and packaging.

.PARAMETER SkipTypecheck
    Skip 'tsc --noEmit'. esbuild strips types without checking them, so this is
    the only step that catches a type error before runtime.

.PARAMETER Clean
    Delete out/, bin/ and any .vsix before building.

.EXAMPLE
    .\build.ps1
    Host core + bundle + typecheck.

.EXAMPLE
    .\build.ps1 -Package
    Bump the patch version, build all six targets, then pack the .vsix.

.EXAMPLE
    .\build.ps1 -Package -Bump minor
    Bump 0.1.x to 0.2.0 first.

.EXAMPLE
    .\build.ps1 -Package -Bump none
    Pack without touching the version.

.EXAMPLE
    .\build.ps1 -Install
    Same as -Package, then install it into VS Code.

.EXAMPLE
    .\build.ps1 -Watch
    Bundle on every save.
#>
[CmdletBinding()]
param(
    [ValidateSet('host', 'all')]
    [string] $Targets = 'host',

    [switch] $Package,
    [switch] $Install,
    [switch] $Watch,
    [switch] $SkipTypecheck,
    [switch] $Clean,

    [ValidateSet('patch', 'minor', 'major', 'none')]
    [string] $Bump
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

# -Install is -Package plus a step, and packaging a host-only build ships a
# .vsix that is broken on every other platform, so unless the caller named
# -Targets themselves, packaging means all of them.
if ($Install) { $Package = $true }
if ($Package -and -not $PSBoundParameters.ContainsKey('Targets')) { $Targets = 'all' }

# Packaging bumps the patch version unless the caller said otherwise. A .vsix
# carrying the same version as the one already installed is not an update to
# VS Code: it needs --force, and the old build can linger until a reload. A
# host build is for iterating and bumps nothing on its own.
if (-not $PSBoundParameters.ContainsKey('Bump')) {
    $Bump = if ($Package) { 'patch' } else { 'none' }
}

# ---------------------------------------------------------------- helpers ---

function Write-Step {
    param([Parameter(Mandatory)][string] $Label)
    Write-Host ''
    Write-Host "==> $Label" -ForegroundColor Cyan
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)][string] $Label,
        [Parameter(Mandatory)][scriptblock] $Action
    )
    Write-Step $Label
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $Action
    $sw.Stop()
    Write-Host ("    ok ({0:n1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
}

# $IsWindows only exists in PowerShell 6+; this reads correctly on 5.1 too.
$script:OnWindows = ($env:OS -eq 'Windows_NT')

<#
Resolves a tool to a path we can actually call.

On Windows, 'npm' and 'npx' resolve to .ps1 shims that do not forward their
arguments. They reconstruct the command line from the *text* of the calling
statement and slice InvocationName.Length characters off the front, so anything
but a bare `npm ...` typed at the start of a statement arrives corrupted:
`& npm run typecheck` reaches npm as `pm run typecheck`, and a splatted call
passes the name of the calling function's variable instead of its value. The
.cmd next to the shim just forwards argv, so prefer it.
#>
function Resolve-Tool {
    param([Parameter(Mandatory)][string] $Name)

    $found = @(Get-Command $Name -All -ErrorAction SilentlyContinue)
    if ($found.Count -eq 0) { return $null }

    if ($script:OnWindows) {
        $app = $found |
            Where-Object { $_.CommandType -eq 'Application' -and $_.Source -match '\.(cmd|bat|exe)$' } |
            Select-Object -First 1
        if ($app) { return $app.Source }
    }

    return $found[0].Source
}

function Test-Tool {
    param([Parameter(Mandatory)][string] $Name)
    return $null -ne (Resolve-Tool $Name)
}

# Native tools report failure through the exit code, not through PowerShell's
# error stream, so $ErrorActionPreference never sees it. Every external call
# goes through here.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string] $File,
        [string[]] $Arguments = @(),
        [string] $WorkingDirectory = $RepoRoot
    )
    $exe = Resolve-Tool $File
    if (-not $exe) { throw "not on PATH: $File" }

    Push-Location $WorkingDirectory
    $previousPreference = $ErrorActionPreference
    try {
        # Under 'Stop', a native tool's stderr aborts the build the moment the
        # caller redirects it (.\build.ps1 2>&1 | Tee-Object, a CI log capture),
        # because PowerShell 5.1 turns each redirected stderr line into a
        # NativeCommandError. go, esbuild and vsce all write ordinary progress
        # there. The exit code is the real signal, and it is checked below.
        $ErrorActionPreference = 'Continue'
        & $exe @Arguments
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            throw "$File $($Arguments -join ' ') exited with code $code"
        }
    }
    finally {
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
}

function Format-Size {
    param([Parameter(Mandatory)][long] $Bytes)
    if ($Bytes -ge 1MB) { return '{0:n1} MB' -f ($Bytes / 1MB) }
    return '{0:n0} KB' -f ($Bytes / 1KB)
}

# ---------------------------------------------------------------- the build ---

try {
    $total = [System.Diagnostics.Stopwatch]::StartNew()

    $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    Write-Host "MF Agent $($pkg.version) - building in $RepoRoot" -ForegroundColor White

    # --- prerequisites ---
    # Checked up front so a missing Go toolchain fails in a second rather than
    # after the TypeScript build has already run.
    $needed = @('node', 'npm')
    if (-not $Watch) { $needed += 'go' }
    $missing = @($needed | Where-Object { -not (Test-Tool $_) })
    if ($missing.Count -gt 0) {
        throw "not on PATH: $($missing -join ', ')"
    }

    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
        Invoke-Step 'installing npm dependencies' { Invoke-Native 'npm' @('install') }
    }

    # --- version ---
    # Before anything is built: the core stamps this version into its binary
    # and the .vsix takes its name from it, so both have to see the new one.
    if ($Bump -ne 'none' -and -not $Watch) {
        Invoke-Step "bumping $Bump version" {
            $before = $pkg.version
            # --no-git-tag-version rewrites package.json and package-lock.json
            # and nothing else; committing and tagging stay yours to do.
            Invoke-Native 'npm' @('version', $Bump, '--no-git-tag-version')
            $script:pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
            Write-Host "    $before -> $($script:pkg.version)" -ForegroundColor DarkGray
        }
    }

    # --- clean ---
    if ($Clean) {
        Write-Step 'cleaning'
        foreach ($dir in 'out', 'bin') {
            $path = Join-Path $RepoRoot $dir
            if (Test-Path $path) {
                Remove-Item $path -Recurse -Force -Confirm:$false
                Write-Host "    removed $dir/" -ForegroundColor DarkGray
            }
        }
        Get-ChildItem -Path (Join-Path $RepoRoot 'mf-agent-*.vsix') -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item $_.FullName -Force -Confirm:$false
                Write-Host "    removed $($_.Name)" -ForegroundColor DarkGray
            }
    }

    # --- watch mode short-circuits: it never returns ---
    if ($Watch) {
        Write-Step 'watching src/ (Ctrl+C to stop)'
        Invoke-Native 'npm' @('run', 'watch')
        exit 0
    }

    # --- Go core ---
    # build-core.mjs keeps bin/<exe> and bin/<host>/<exe> in sync itself, so the
    # extension can never spawn a core older than the source it was built from.
    if ($Targets -eq 'all') {
        Invoke-Step 'building Go core for all targets' {
            Invoke-Native 'npm' @('run', 'build:core', '--', '--all')
        }
    }
    else {
        Invoke-Step 'building Go core for this host' {
            Invoke-Native 'npm' @('run', 'build:core')
        }
    }

    # --- typecheck ---
    if ($SkipTypecheck) {
        Write-Step 'typecheck skipped'
    }
    else {
        Invoke-Step 'typechecking' { Invoke-Native 'npm' @('run', 'typecheck') }
    }

    # --- bundle ---
    Invoke-Step 'bundling extension' { Invoke-Native 'npm' @('run', 'build:ext') }

    # --- package ---
    $vsix = $null
    if ($Package) {
        Invoke-Step 'packaging .vsix' {
            Invoke-Native 'npx' @(
                '--yes', '@vscode/vsce', 'package',
                '--no-dependencies', '--allow-missing-repository'
            )
        }

        $expected = Join-Path $RepoRoot "$($pkg.name)-$($pkg.version).vsix"
        if (-not (Test-Path $expected)) { throw "vsce reported success but $expected is missing" }
        $vsix = Get-Item $expected

        # Drop packages left over from older versions, but only now that a good
        # one exists: deleting them first would leave a failed build with none.
        Get-ChildItem -Path (Join-Path $RepoRoot 'mf-agent-*.vsix') -File |
            Where-Object { $_.FullName -ne $vsix.FullName } |
            ForEach-Object {
                Remove-Item $_.FullName -Force -Confirm:$false
                Write-Host "    removed stale $($_.Name)" -ForegroundColor DarkGray
            }
    }

    # --- install ---
    if ($Install) {
        if (Test-Tool 'code') {
            Invoke-Step 'installing into VS Code' {
                Invoke-Native 'code' @('--install-extension', $vsix.FullName, '--force')
            }
        }
        else {
            Write-Host "    'code' is not on PATH; install manually from $($vsix.Name)" -ForegroundColor Yellow
        }
    }

    # --- summary ---
    $total.Stop()
    Write-Step 'artifacts'

    $rows = @()

    $bundle = Join-Path $RepoRoot 'out\extension.js'
    if (Test-Path $bundle) {
        $item = Get-Item $bundle
        $rows += [pscustomobject]@{ Artifact = 'out\extension.js'; Size = (Format-Size $item.Length) }
    }

    Get-ChildItem -Path (Join-Path $RepoRoot 'bin') -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object FullName |
        ForEach-Object {
            $rows += [pscustomobject]@{
                Artifact = $_.FullName.Substring($RepoRoot.Length + 1)
                Size     = (Format-Size $_.Length)
            }
        }

    if ($vsix) {
        $rows += [pscustomobject]@{ Artifact = $vsix.Name; Size = (Format-Size $vsix.Length) }
    }

    $rows | Format-Table -AutoSize | Out-String | Write-Host

    # A host build leaves any earlier .vsix exactly as it was, which is easy
    # to mistake for a fresh package when one is sitting in the folder.
    if (-not $Package) {
        Write-Host '    no .vsix was built: this was a host build. Run .\build.ps1 -Package for the .vsix, or -Install to also install it.' -ForegroundColor Yellow
    }

    # The core stamps its version at build time; printing it here is how you
    # confirm the binary on disk is the one this run produced.
    $coreExe = Join-Path $RepoRoot 'bin\mfcore.exe'
    if (Test-Path $coreExe) {
        $version = (& $coreExe --version | Select-Object -First 1)
        Write-Host "core version $version" -ForegroundColor DarkGray
    }

    Write-Host ("BUILD OK ({0:n1}s)" -f $total.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ''
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
