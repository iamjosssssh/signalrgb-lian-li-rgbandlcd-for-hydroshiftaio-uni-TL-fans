# Restarts L-Connect Service so it reopens the dongle. Use this if its log shows
# "Open RFSender Failed" because another program was holding the dongle. Needs admin.
$log = Join-Path $PSScriptRoot 'lconnect.log'
"--- restart $(Get-Date)" | Out-File $log -Append -Encoding utf8
try {
    Restart-Service LConnectService -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    "service: $((Get-Service LConnectService).Status)" | Out-File $log -Append -Encoding utf8
}
catch {
    "error: $_" | Out-File $log -Append -Encoding utf8
}
