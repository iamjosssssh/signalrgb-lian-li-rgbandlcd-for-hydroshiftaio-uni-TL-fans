# Puts L-Connect back in charge of the fans, pump and LCDs. Needs admin.
$log = Join-Path $PSScriptRoot 'lconnect.log'
"--- start $(Get-Date)" | Out-File $log -Append -Encoding utf8
try {
    Start-Service LConnectService -ErrorAction Stop
    Start-Sleep -Seconds 2
    Start-Process 'C:\Program Files\Lian-Li\L-Connect 3\L-Connect 3.exe'
    "service: $((Get-Service LConnectService).Status)" | Out-File $log -Append -Encoding utf8
}
catch {
    "error: $_" | Out-File $log -Append -Encoding utf8
}
