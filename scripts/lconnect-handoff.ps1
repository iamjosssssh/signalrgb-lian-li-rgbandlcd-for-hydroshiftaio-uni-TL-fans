# Keeps one program in charge of the Lian Li dongle and screens. Run elevated at sign-in by
# install-takeover.ps1.
#
# L-Connect Service runs the fans from power-on, because wireless fans don't spin until something
# talks to the dongle. Once SignalRGB is up, this stops the service so SignalRGB can take over.
# If SignalRGB goes away, the service comes back, so the fans never go unmanaged. Opening the
# L-Connect 3 window gives it the hardware until the window closes.
param([switch]$Once)

$service = 'LConnectService'
$pollSeconds = 5
$signalRgbGoneSeconds = 15
$log = Join-Path $PSScriptRoot 'lconnect.log'

function Mark($text) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') handoff: $text" | Out-File $log -Append -Encoding utf8
}

function Get-Wanted($signalRgbRunning, $lconnectWindowOpen, $goneSeconds) {
    if ($lconnectWindowOpen) { return 'Running' }
    if ($signalRgbRunning) { return 'Stopped' }
    if ($goneSeconds -ge $signalRgbGoneSeconds) { return 'Running' }
    return ''
}

# Optional checks for one machine, kept beside this script and out of the project. If the file
# defines Invoke-LocalCheck, it runs on every pass, and a failure in it can't stop the handoff.
$localChecks = Join-Path $PSScriptRoot 'handoff.local.ps1'
if (-not $Once -and (Test-Path $localChecks)) {
    try { . $localChecks }
    catch { Mark "local checks did not load: $_" }
}

Mark 'started'
$lastSeen = Get-Date
do {
    if (-not $Once -and (Get-Command Invoke-LocalCheck -ErrorAction SilentlyContinue)) {
        try { Invoke-LocalCheck }
        catch { Mark "local checks failed: $_" }
    }
    $signalRgb = [bool](Get-Process SignalRgb -ErrorAction SilentlyContinue)
    $window = [bool](Get-Process 'L-Connect 3' -ErrorAction SilentlyContinue)
    if ($signalRgb) { $lastSeen = Get-Date }
    $wanted = Get-Wanted $signalRgb $window ((Get-Date) - $lastSeen).TotalSeconds
    $current = (Get-Service $service).Status
    if ($Once) {
        "signalrgb=$signalRgb window=$window service=$current wanted='$wanted'"
    }
    elseif ($wanted -eq 'Stopped' -and $current -eq 'Running') {
        Stop-Service $service -Force -ErrorAction SilentlyContinue
        # The service can report Stopped while its process holds the hardware for another 90 seconds.
        Get-Process 'L-Connect-Service' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Mark "SignalRGB is running, stopped L-Connect Service: $((Get-Service $service).Status)"
    }
    elseif ($wanted -eq 'Running' -and $current -eq 'Stopped') {
        Start-Service $service -ErrorAction SilentlyContinue
        Mark "gave the hardware back to L-Connect Service: $((Get-Service $service).Status)"
    }
    if (-not $Once) { Start-Sleep -Seconds $pollSeconds }
} while (-not $Once)
