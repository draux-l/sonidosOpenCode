# sonido-notify.ps1 — fixed notification renderer for the Sonido OpenCode plugin.
#
# Contract:
#   - This is the FALLBACK renderer. Sonido normally plays its sounds inside
#     OpenCode's own process (bun:ffi + winmm); this script only runs when that
#     backend is unavailable.
#   - Designed for Windows PowerShell 5.1 (powershell.exe).
#   - Sound only by design: no toasts. Each kind maps to its own sound file
#     (<kind>.wav) and plays it once, falling back to a Windows system sound.
#   - Always exits 0: a notification failure must never surface anywhere.
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sonido-notify.ps1 `
#       -Kind response|completion|attention|error -TitleB64 <base64> -BodyB64 <base64>
#   powershell.exe -NoProfile -File sonido-notify.ps1 -Kind completion -DryRun

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("response", "completion", "attention", "error")]
    [string]$Kind,

    [string]$TitleB64 = "",
    [string]$BodyB64 = "",

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Decode-B64Value {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

function Invoke-SonidoSound {
    param([string]$SoundKind)

    # 1. Kind-specific WAV (e.g. response.wav, completion.wav) — played ONCE.
    $kindWav = Join-Path $PSScriptRoot "$SoundKind.wav"
    if (Test-Path -LiteralPath $kindWav) {
        try {
            $player = New-Object System.Media.SoundPlayer $kindWav
            $player.PlaySync()
            return
        }
        catch { }
    }

    # 2. System sound fallback if the WAV is missing or unplayable — played ONCE.
    $sound = [System.Media.SystemSounds]::Asterisk
    switch ($SoundKind) {
        "attention" { $sound = [System.Media.SystemSounds]::Exclamation }
        "error"     { $sound = [System.Media.SystemSounds]::Hand }
    }
    $sound.Play()
}

try {
    $title = Decode-B64Value -Value $TitleB64
    $body = Decode-B64Value -Value $BodyB64

    if ($DryRun) {
        Write-Output "SONIDO_OK kind=$Kind title=$title body=$body"
        exit 0
    }

    # Sound only by design: every kind plays its own file once.
    Invoke-SonidoSound -SoundKind $Kind
}
catch {
    # Last-resort fallback: sound, then a clean exit. Never propagate.
    try {
        Invoke-SonidoSound -SoundKind $Kind
    } catch { }
}

exit 0
