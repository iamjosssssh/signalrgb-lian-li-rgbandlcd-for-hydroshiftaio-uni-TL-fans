# Turns a video into a looping GIF that SignalRGB can show on an LCD, because SignalRGB's LCD
# backgrounds take PNG, JPG, BMP and GIF but not video. Needs FFmpeg: winget install Gyan.FFmpeg
#
# Pick the result in SignalRGB: Devices, your screen, LCD tab, Background Type "image", Browse.
#
#   video-to-lcd-gif.ps1 clip.mp4
#   video-to-lcd-gif.ps1 clip.mp4 -Seconds 20 -Start 5 -Fps 20
#
# Add -InstallSendTo once to add "SignalRGB LCD GIF" to Explorer's Send To menu.
param(
    [string]$Video,
    [double]$Seconds = 15,
    [double]$Start = 0,
    [int]$Fps = 15,
    [int]$Size = 480,
    [string]$OutFolder = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WhirlwindFX\LCD Media'),
    [switch]$InstallSendTo
)

if ($InstallSendTo) {
    $link = Join-Path ([Environment]::GetFolderPath('SendTo')) 'SignalRGB LCD GIF.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $shortcut.Description = 'Make a looping GIF for a SignalRGB LCD'
    $shortcut.Save()
    "Added $link"
    return
}

function Find-Ffmpeg {
    $command = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    Get-ChildItem $packages -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue } |
        Select-Object -First 1 -ExpandProperty FullName
}

$ffmpeg = Find-Ffmpeg
if (-not $ffmpeg) { Write-Error 'FFmpeg not found. Install it with: winget install Gyan.FFmpeg'; exit 1 }
if (-not $Video -or -not (Test-Path -LiteralPath $Video)) { Write-Error "No such video: '$Video'"; exit 1 }
New-Item -ItemType Directory -Force $OutFolder | Out-Null
$out = Join-Path $OutFolder ([IO.Path]::GetFileNameWithoutExtension($Video) + '.gif')

# Centre crop to a square. One palette per clip keeps the GIF small, and light dithering keeps it from flickering.
$filter = "fps=$Fps,scale=${Size}:${Size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${Size}:${Size},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
$arguments = @('-hide_banner', '-loglevel', 'error', '-y', '-ss', "$Start", '-t', "$Seconds", '-i', $Video, '-an', '-filter_complex', $filter, '-loop', '0', $out)
& $ffmpeg @arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)) { Write-Error 'FFmpeg could not convert this video.'; exit 1 }
"$out ($([math]::Round((Get-Item -LiteralPath $out).Length / 1MB, 1)) MB)"
