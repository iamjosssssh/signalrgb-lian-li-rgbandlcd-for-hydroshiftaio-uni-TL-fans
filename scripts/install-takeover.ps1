# Makes SignalRGB the owner of the Lian Li hardware from every sign-in. Needs admin.
# Undo with uninstall-takeover.ps1.
$ErrorActionPreference = 'Stop'
$handoff = Join-Path $PSScriptRoot 'lconnect-handoff.ps1'
$taskName = 'Lian Li Handoff to SignalRGB'
$user = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Get-Service LConnectService -ErrorAction SilentlyContinue)) {
    'L-Connect Service not found, so there is nothing to hand off.'
    return
}

# L-Connect Service still starts with Windows to run the fans. The watcher would undo every handoff.
Set-Service LConnectService -StartupType Automatic
Stop-Service LConnectServiceWatcher -Force -ErrorAction SilentlyContinue
Set-Service LConnectServiceWatcher -StartupType Disabled

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$handoff`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

"Installed. Task: $((Get-ScheduledTask -TaskName $taskName).State). Watcher: $((Get-Service LConnectServiceWatcher).StartType)."
