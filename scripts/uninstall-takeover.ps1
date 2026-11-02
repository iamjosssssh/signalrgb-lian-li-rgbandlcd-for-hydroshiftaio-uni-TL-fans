# Puts L-Connect back in full charge of the Lian Li hardware. Needs admin.
# Remove Documents\WhirlwindFX\Plugins\LianLiLocal too, or SignalRGB keeps waiting for the hardware.
$taskName = 'Lian Li Handoff to SignalRGB'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
if (-not (Get-Service LConnectService -ErrorAction SilentlyContinue)) {
    'L-Connect Service not found, so there is nothing to give back.'
    return
}
Set-Service LConnectServiceWatcher -StartupType Automatic
Start-Service LConnectService -ErrorAction SilentlyContinue
Start-Service LConnectServiceWatcher -ErrorAction SilentlyContinue
"Removed. L-Connect Service: $((Get-Service LConnectService).Status)."
