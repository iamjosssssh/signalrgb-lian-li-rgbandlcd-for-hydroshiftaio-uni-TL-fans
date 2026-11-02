# Lian Li wireless and LCD control for SignalRGB

Runs Lian Li's L-Wireless gear from SignalRGB instead of L-Connect 3:

| What | How | Tested on |
|---|---|---|
| Fan, pump ring and Strimer lighting | Wireless dongle, found automatically | 3x TL LCD, 1x TL140 LCD, 3x TL, HydroShift II LCD-S, Strimer |
| Fan speed curves | SignalRGB's Cooling page, one curve per fan group, 30% floor by default | Same fans |
| Pump speed curve | Optional, off by default, sent in the AIO parameter block | HydroShift II LCD-S: followed 2447 to about 3020 rpm and back |
| Coolant temperature | Published as a SignalRGB sensor | HydroShift II LCD-S |
| Stored effects | Devices play an animation by themselves, smoothly | Same hardware, simulation-tested upload |
| HydroShift II LCD-S screen | SignalRGB's LCD page, USB `1CBE:A034` | Firmware `lianlih2s_0001_0027` |
| TL Wireless LCD screens | SignalRGB's LCD page, USB `1CBE:0006`, with the bridge program | Firmware `tlv2_2024091005_01` |
| System Stats LCD face | Four live gauges for any SignalRGB sensor | TL Wireless LCD |

Community project, not affiliated with Lian Li or WhirlwindFX. Use at your own risk.

Built on [SignalRGB-HydroShift-II-TL-Wireless](https://github.com/ShkourBashtawi/SignalRGB-HydroShift-II-TL-Wireless)
(its framing, tinyuz compressor and stored effects, `vendor/core.cjs`), which ports
[lian-li-linux](https://github.com/sgtaziz/lian-li-linux). The pump screen start-up sequence follows
[signalrgb-hydroshift-ii-s](https://github.com/KnxckbackWili/signalrgb-hydroshift-ii-s). All MIT.

## Install

1. In SignalRGB, open **Settings**, then **Add-ons**, paste this repo's URL and restart SignalRGB:

   ```
   https://github.com/iamjosssssh/signalrgb-lian-li-rgbandlcd-for-hydroshiftaio-uni-TL-fans
   ```

2. Run the one-time setup from PowerShell. It asks for admin rights:

   ```powershell
   & (Get-ChildItem "$env:LOCALAPPDATA\WhirlwindFX\SignalRgb\cache\addons" -Recurse -Filter setup-lianli.ps1 | Select-Object -First 1).FullName
   ```

3. To use curves, set **Fan Speeds** on the Lian Li Wireless device to `SignalRGB Fan Control`, then set the curves on the Cooling page.

The add-on alone installs the plugins. Plugins can't start programs, so step 2 does three things they can't. It stops L-Connect at each sign-in once SignalRGB is up, because only one program can hold the dongle. It builds the screen bridge and starts it at sign-in, which you need with more than one TL LCD fan. And it installs the System Stats face, which needs SignalRGB Pro. `setup-lianli.ps1 -DryRun` lists the steps without changing anything, and `-Remove` undoes them, apart from the face.

If you run the bundled OpenRGB through L-Connect, it can also corrupt SignalRGB's RAM scan. See the [motherboard repo](https://github.com/iamjosssssh/signalrgb-msi-x870e-godlike-xedition-controller) for the fix.

## Who owns the hardware

Only one program can hold the dongle and screens, so `scripts\lconnect-handoff.ps1` runs at sign-in and keeps one in charge:

| Situation | Who has the hardware |
|---|---|
| Power-on until SignalRGB starts | L-Connect Service, because wireless fans don't spin until something talks to the dongle |
| SignalRGB running | SignalRGB. The handoff also ends L-Connect's process, which otherwise holds the hardware for about 90 seconds after reporting Stopped |
| SignalRGB closed for 15 seconds | L-Connect Service again |
| L-Connect 3 window open | L-Connect, until the window closes |

Undo with `setup-lianli.ps1 -Remove`, then remove the add-on.

## Changing what a screen shows

Each screen has its own page: **Devices**, the screen, then the **LCD** tab. The fan screens are named by the start of their serial number, and **Settings** on the same page has **Rename Device**.

| You want | Where |
|---|---|
| Clock, text, logo, one sensor, or four gauges | **LCD Face**, **Select** |
| More faces, including CPU and GPU dashboards | **Discover**, **LCD Blocks** |
| A photo or GIF | **Background Type**: `image`, then **Browse** (PNG, JPG, BMP, GIF). Faces draw on top of it |
| The current lighting effect | **Background Type**: `canvas` |
| Brightness, rotation, render rate | Top of the LCD tab |

The `media` background type is the thumbnail of whatever is playing on the PC, not a file.

### Video

SignalRGB's LCD system doesn't play video: `image` rejects MP4, and its face engine has no `<video>` element. `tools\video-to-lcd-gif.ps1` turns a clip into a looping GIF in `Documents\WhirlwindFX\LCD Media`, ready for **Browse**. It needs FFmpeg (`winget install Gyan.FFmpeg`).

```powershell
tools\video-to-lcd-gif.ps1 clip.mp4 -Seconds 15 -Fps 15
tools\video-to-lcd-gif.ps1 -InstallSendTo   # adds it to Explorer's Send To menu
```

## Fan screens and the bridge

SignalRGB opens a raw USB handle on only one of several identical devices, and gives it to whichever plugin instance wins a startup race. So that instance may be attached to a different physical screen than its own name, and the other instances can't reach their screens at all.

`bridge\LianLiLcdBridge.cs` works around that. Every instance sends its frames to the bridge over `127.0.0.1`, labelled with its real serial number, and the bridge writes them through WinUSB. The one screen SignalRGB is holding can't be opened, so its frames go back to the instance with the handle. With one screen, or with no bridge running, that instance shows its own frames directly.

## Safety

- `src/guard.cjs` checks every wireless write. Only clock, RGB and speed frames can leave the dongle, and only to devices the RX reports as bound to your own dongle, so a neighbour's fans are never touched.
- Reboot, bind, firmware, LCD picture and LCD theme-switch frames are rejected, not just unused.
- Speed frames can't stop a fan or go below its minimum, and can't take the pump below 2000 rpm. They stay on the channel each device already uses.
- The RX can return a record while it's being updated, with part of the address zeroed. A device only counts once it has looked the same in three reports running.
- For a pump that always runs flat out, set **Lowest Pump Speed** to 100 and pick the `Pump` preset on the Cooling page.
- The fan-speed frame's pump slot changes the speed the pump reports but not its real speed, so this plugin doesn't use it. Pump speed goes in the AIO parameter block, without the command that switches the screen to its sensor theme.
- An uncertain curve value holds the last speed. No usable value for 30 seconds goes to full speed. If SignalRGB closes, fans get their earlier speed back.
- The screen code can build only frame, brightness, frame-rate, version, stop-play and stop-clock commands. The startup-image (flash), reboot and desktop-mode commands can't be sent. Write timeouts are 2 seconds, because a shorter one can wedge the screen until a power cycle.
- A screen that stops answering is left alone for 10 seconds before trying again.

## Limits

- Wireless lighting isn't instant. Uploads get lost on the radio, so a new color is resent until the device reports it, which takes about 2 seconds and now and then up to 8. Each device only reports about once a second, so the lights can change a little before the report shows it.
- Live animated effects share about 15 updates per second across all groups, so each gets only a few. For smooth motion use **Lighting Mode: Hardware Effect**.
- After a power cycle the devices show L-Connect's saved effect until SignalRGB takes over, and the pump runs at L-Connect's saved speed. The same applies once L-Connect takes back over after SignalRGB closes.
- Screens start 30 seconds after SignalRGB does. SignalRGB looks up a screen's saved face when the screen starts, and resets it to the default for good if its face list isn't ready, which takes about 10 seconds.
- Screens keep their last frame when SignalRGB closes.
- The Lian Li Wireless device must fit inside the canvas. Parts outside it read wrong colors, so check its position and scale on the Layouts page.

## Build and test

```bash
node build.cjs
```

```bash
node --openssl-legacy-provider test/sim.cjs
```

The simulation runs against a fake dongle and fake screens, so it doesn't prove the hardware responds. It also can't catch syntax SignalRGB's script engine rejects, except object spread, which it checks for.
