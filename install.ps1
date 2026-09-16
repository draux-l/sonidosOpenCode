# install.ps1 — idempotent installer/uninstaller for the Sonido OpenCode plugin.
#
# Install:   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
# Uninstall: powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# Safety:
#   - Copies ONLY the Sonido files (sonido.ts, sonido-notify.ps1, and every
#     *.wav audio asset in plugin/) into the global OpenCode plugins directory.
#     Unrelated plugins are never touched, listed, or removed.
#   - Idempotent: re-running install yields the same result; destination files
#     are verified byte-for-byte against the project source.
#   - The PowerShell notification script is syntax-checked before anything is
#     copied.
#   - Uninstall removes exactly the Sonido files plus the runtime sonido.log.
#     Nothing else.

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$PluginsDir = (Join-Path $env:USERPROFILE ".config\opencode\plugins"),
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$SourceDir = Join-Path $PSScriptRoot "plugin"
$CoreFiles = @("sonido.ts", "sonido-notify.ps1")

# Stable uninstall manifest: every file Sonido has ever installed. It is kept
# explicit so uninstalling never depends on the source checkout, and never
# orphans an asset that a later release stopped shipping. `quack.wav` is
# legacy-only: it is no longer installed, but 1.0.2 put it in the plugins
# directory, so uninstall must still remove it.
$InstalledNames = @(
    "sonido.ts",
    "sonido-notify.ps1",
    "response.wav",
    "attention.wav",
    "completion.wav",
    "error.wav",
    "quack.wav"
)

# Runtime artifacts created by the plugin itself; removed on uninstall only.
$RuntimeArtifacts = @("sonido.log")

function Write-Step {
    param([string]$Message)
    if (-not $Quiet) { Write-Host $Message }
}

function Test-PsSyntax {
    param([string]$Path)
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseInput(
        [System.IO.File]::ReadAllText($Path), [ref]$tokens, [ref]$errors)
    return ($null -eq $errors -or $errors.Count -eq 0)
}

function Confirm-SourceReady {
    foreach ($file in $Files) {
        $path = Join-Path $SourceDir $file
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Missing source file: $path"
        }
    }
    foreach ($file in $Files) {
        if ($file -like "*.ps1") {
            $path = Join-Path $SourceDir $file
            if (-not (Test-PsSyntax -Path $path)) {
                throw "Syntax check failed for source: $path"
            }
        }
    }
    Write-Step "Source OK: $SourceDir"
}

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $PluginsDir)) {
        Write-Step "Nothing to uninstall: $PluginsDir does not exist."
        exit 0
    }
    foreach ($file in ($InstalledNames + $RuntimeArtifacts)) {
        $path = Join-Path $PluginsDir $file
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
            Write-Step "Removed: $path"
        }
        else {
            Write-Step "Not present, skipped: $path"
        }
    }
    Write-Step "Uninstall complete. Restart OpenCode to stop loading the plugin."
    exit 0
}

# Install path only: the audio assets are discovered from the checkout, so
# shipping a new sound never requires editing this script.
$wavFiles = @(Get-ChildItem -Path $SourceDir -Filter "*.wav" | Select-Object -ExpandProperty Name)
if ($wavFiles.Count -eq 0) {
    throw "No audio assets (*.wav) found in $SourceDir"
}
$Files = $CoreFiles + $wavFiles

Confirm-SourceReady

if (-not (Test-Path -LiteralPath $PluginsDir)) {
    New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
    Write-Step "Created: $PluginsDir"
}

foreach ($file in $Files) {
    $source = Join-Path $SourceDir $file
    $target = Join-Path $PluginsDir $file

    Copy-Item -LiteralPath $source -Destination $target -Force

    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) {
        throw "Verification failed for ${file}: installed bytes differ from source."
    }
    Write-Step "Installed + verified: $target"
}

Write-Step "Install complete. RESTART OpenCode for the plugin to load."
Write-Step "Other plugins in $PluginsDir were left untouched."
Write-Step "A previous sonido.log (if present) was preserved."
