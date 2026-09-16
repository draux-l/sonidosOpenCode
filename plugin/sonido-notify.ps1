# sonido-notify.ps1 — fixed notification renderer for the Sonido OpenCode plugin.
#
# Contract:
#   - Designed for Windows PowerShell 5.1 (powershell.exe). WinRT toast types
#     are NOT available in pwsh 7, so this script must run under powershell.exe.
#   - All dynamic content arrives as Base64(UTF-8) and is decoded here. Event
#     text is never interpolated into executable code; toast text is assigned
#     through the XML DOM (InnerText), which escapes it safely.
#   - Each kind maps to its own sound file (<kind>.wav) and plays it once.
#   - response/completion -> sound only.
#   - attention/error -> Windows toast (custom AUMID) + sound; the toast failure
#     path falls back to the sound alone.
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

$AUMID = "Sonido.OpenCode"

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

function Show-SonidoToast {
    param([string]$ToastTitle, [string]$ToastBody)
    try {
        # WinRT activation support for Windows PowerShell 5.1.
        Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text></text><text></text></binding></visual></toast>")
        $texts = $xml.GetElementsByTagName("text")
        # InnerText performs safe XML escaping; never build XML by string concatenation.
        $texts.Item(0).InnerText = $ToastTitle
        $texts.Item(1).InnerText = $ToastBody

        $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $xml
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID)
        $notifier.Show($toast)
        return $true
    }
    catch {
        return $false
    }
}

try {
    $title = Decode-B64Value -Value $TitleB64
    $body = Decode-B64Value -Value $BodyB64

    if ($DryRun) {
        Write-Output "SONIDO_OK kind=$Kind title=$title body=$body"
        exit 0
    }

    if ($Kind -eq "completion" -or $Kind -eq "response") {
        # Completion and response are sound-only by design.
        Invoke-SonidoSound -SoundKind $Kind
    }
    else {
        # Attention/error: show toast for visual details and always play sound for the audio alert.
        $null = Show-SonidoToast -ToastTitle $title -ToastBody $body
        Invoke-SonidoSound -SoundKind $Kind
    }
}
catch {
    # Last-resort fallback: sound, then a clean exit. Never propagate.
    try {
        Invoke-SonidoSound -SoundKind $Kind
    } catch { }
}

exit 0
