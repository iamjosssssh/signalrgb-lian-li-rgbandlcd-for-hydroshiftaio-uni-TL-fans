# Stops L-Connect for this session only. Startup settings are not changed, so a
# reboot (or start-lconnect.ps1) puts L-Connect back in charge. Needs admin.
$log = Join-Path $PSScriptRoot 'lconnect.log'
"--- stop $(Get-Date)" | Out-File $log -Append -Encoding utf8
try {
    Get-Process 'L-Connect 3' -ErrorAction SilentlyContinue | Stop-Process -Force
    Stop-Service LConnectServiceWatcher -Force -ErrorAction SilentlyContinue
    Stop-Service LConnectService -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    Get-Process OpenRGB -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    "service: $((Get-Service LConnectService).Status)" | Out-File $log -Append -Encoding utf8
    "openrgb running: $([bool](Get-Process OpenRGB -ErrorAction SilentlyContinue))" | Out-File $log -Append -Encoding utf8
}
catch {
    "error: $_" | Out-File $log -Append -Encoding utf8
}
