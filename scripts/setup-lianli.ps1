# One-time setup for what a SignalRGB plugin can't do by itself. Asks for admin rights.
#  - Stops L-Connect at each sign-in once SignalRGB is up, and hands the hardware back if SignalRGB closes.
#  - Builds the screen bridge and starts it at sign-in. More than one TL LCD fan needs it.
#  - Installs the System Stats LCD face.
# -DryRun lists the steps and changes nothing. -Remove undoes everything except the face.
param([switch]$DryRun, [switch]$Remove)

$repo = Split-Path $PSScriptRoot -Parent
$installFolder = Join-Path $env:LOCALAPPDATA 'LianLiSignalRGB'
$bridgeTask = 'Lian Li LCD Bridge'
$faces = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WhirlwindFX\LCDFaces'

if ($DryRun) {
    "Would copy scripts and bridge from $repo to $installFolder"
    'Would build the bridge with the C# compiler that ships with Windows'
    "Would add the sign-in task '$bridgeTask' and start the bridge"
    "Would copy the faces to $faces"
    "Would install the L-Connect handoff task and disable L-Connect's watcher service"
    return
}

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Remove) { $arguments += '-Remove' }
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList $arguments
    return
}
$ErrorActionPreference = 'Stop'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $bridgeTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process LianLiLcdBridge -ErrorAction SilentlyContinue | Stop-Process -Force
    if (Test-Path $installFolder) { & (Join-Path $installFolder 'scripts\uninstall-takeover.ps1') }
    Remove-Item $installFolder -Recurse -Force -ErrorAction SilentlyContinue
    'Removed.'
    return
}

# SignalRGB can replace or delete its add-on folder, so the sign-in tasks run from their own copy.
New-Item -ItemType Directory -Force $installFolder | Out-Null
Get-Process LianLiLcdBridge -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item (Join-Path $repo 'scripts'), (Join-Path $repo 'bridge') $installFolder -Recurse -Force
& (Join-Path $installFolder 'bridge\build.ps1')
$bridge = Join-Path $installFolder 'bridge\LianLiLcdBridge.exe'

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $bridge
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# Priority 4 is normal. A task's default is below normal.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4 -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $bridgeTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $bridgeTask

New-Item -ItemType Directory -Force $faces | Out-Null
Copy-Item (Join-Path $repo 'faces\*.html') $faces -Force

& (Join-Path $installFolder 'scripts\install-takeover.ps1')
'Done. Restart SignalRGB to pick up the System Stats face.'
