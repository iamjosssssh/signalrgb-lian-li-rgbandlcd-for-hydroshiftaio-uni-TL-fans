# Lian Li wireless and LCD control for SignalRGB

Runs Lian Li's L-Wireless fans, AIO coolers and Strimers from SignalRGB instead of L-Connect 3: lighting, speed curves and LCD screens, all found automatically.

Community project, not affiliated with Lian Li or WhirlwindFX. Use at your own risk.

## What works with it

| Hardware | Lighting | Speed curve | Screen | Tested on real hardware |
|---|---|---|---|---|
| UNI FAN TL Wireless, TL LCD | Yes | Yes | TL LCD: yes | **Yes** (3x TL, 3x TL LCD, 1x TL140 LCD) |
| UNI FAN TL V3, SL V3, SL V3 LCD, SL V4, SL-INF, SL-INF V3, CL, CL V2, P28 V2 (wireless) | Yes | Yes | SL V3 LCD: yes | No. Same protocol in [lian-li-linux](https://github.com/sgtaziz/lian-li-linux) |
| HydroShift II LCD-S | Yes | Yes, optional | Yes | **Yes** |
| HydroShift II LCD-C | Yes | Yes, optional | Yes | No |
| Strimer Wireless (88, 116, 132 and 174 LED versions) | Yes | n/a | n/a | **Yes** (88 LED) |
| TX and RX dongles `0416:8040` and `0416:8041` | | | | **Yes** |
| V2 dongles `1A86:E304` and `1A86:E305` | | | | No |

The firmware versions tested are `tlv2_2024091005_01` on TL LCD fans and `lianlih2s_0001_0027` on the pump screen.

**Not covered:** wired UNI FAN controllers (SignalRGB has its own plugins for these), and the Lancool 207, Vision and Universal Screen displays. Anything marked "No" should work but hasn't been run on the real thing, so please open an issue with what you find.

## Install

1. In SignalRGB, open **Settings**, then **Add-ons**, paste this URL and restart SignalRGB:

   ```
   https://github.com/iamjosssssh/signalrgb-lian-li-rgbandlcd-for-hydroshiftaio-uni-TL-fans
   ```

2. Run the setup once from PowerShell. It asks for admin rights:

   ```powershell
   & (Get-ChildItem "$env:LOCALAPPDATA\WhirlwindFX\SignalRgb\cache\addons" -Recurse -Filter setup-lianli.ps1 | Select-Object -First 1).FullName
   ```

3. Optional: to use curves, set **Fan Speeds** on the Lian Li Wireless device to `SignalRGB Fan Control`, then set them on the Cooling page. The pump works the same way through **Pump Speed**.

### What each step does

**The add-on by itself** adds the plugins and changes nothing else. It can't start programs or stop services, so:

- If L-Connect is running, the plugins wait until it's closed, and L-Connect comes back at every boot.
- With more than one LCD fan, only one screen works, and it may show another screen's picture.

**The setup makes these changes to your PC:**

| Change | Why | Effect you'll notice |
|---|---|---|
| If L-Connect is installed: adds the task `Lian Li Handoff to SignalRGB`, running as admin at sign-in | Only one program can hold the dongle | L-Connect Service stops once SignalRGB is up, and returns if SignalRGB closes |
| If L-Connect is installed: disables the `LConnectServiceWatcher` service | It would undo every handoff | L-Connect Service no longer restarts itself |
| Adds the task `Lian Li LCD Bridge`, and builds its program in `%LOCALAPPDATA%\LianLiSignalRGB` | SignalRGB can only open one of several identical screens | One small background program, about 12 MB of memory |
| Copies the System Stats face to `Documents\WhirlwindFX\LCDFaces` | Faces can't be installed by an add-on. Needs SignalRGB Pro | A new face in the LCD tab |

`setup-lianli.ps1 -DryRun` lists the steps without changing anything. `setup-lianli.ps1 -Remove` undoes them apart from the face, then remove the add-on.

**Warnings**

- The L-Connect 3 app can't control this hardware while SignalRGB does. Opening its window hands the hardware back until you close it.
- Fan and pump speeds only change if you turn curves on. Fans can't be stopped, and the pump can't go below 2000 rpm.
- Screens take about 30 seconds after SignalRGB starts to change. See [Limits](#limits).
- If you also run the OpenRGB bundled with L-Connect, it can corrupt SignalRGB's RAM scan. The [motherboard repo](https://github.com/iamjosssssh/signalrgb-msi-x870e-godlike-xedition-controller) has the fix.

Built on [SignalRGB-HydroShift-II-TL-Wireless](https://github.com/ShkourBashtawi/SignalRGB-HydroShift-II-TL-Wireless)
(its framing, tinyuz compressor and stored effects, `vendor/core.cjs`), which ports
[lian-li-linux](https://github.com/sgtaziz/lian-li-linux). The pump screen start-up sequence follows
[signalrgb-hydroshift-ii-s](https://github.com/KnxckbackWili/signalrgb-hydroshift-ii-s). All MIT.

## If the fans and Strimer stop changing color

The TX dongle can hang. SignalRGB then shows **Lian Li TX dongle isn't responding** on the device, or the Lian Li Wireless device disappears because Windows reports the dongle as `Unknown USB Device (Device Descriptor Request Failed)`. Fans and the pump keep running by themselves.

**Unplug the TX dongle and plug it back in.** If it's on an internal header, shut down and turn off the power supply for 30 seconds. A restart doesn't help, because USB power stays on.

## Layout

The plugins draw everything to real size at 1 canvas unit = 3 mm, so a 120 mm fan is 40 units across. Other devices come in at SignalRGB's own default sizes, so set them on the Layouts page to match.

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

- Wireless lighting isn't instant. Uploads get lost on the radio, so a new color is resent until the device reports it, which usually takes a few seconds and now and then longer.
- Live animated effects share about 6 updates per second across all groups, so each gets only a few. For smooth motion use **Lighting Mode: Hardware Effect**.
- After a power cycle the devices show L-Connect's saved effect until SignalRGB takes over, and the pump runs at L-Connect's saved speed. The same applies once L-Connect takes back over after SignalRGB closes.
- Screens start 30 seconds after SignalRGB does. SignalRGB looks up a screen's saved face when the screen starts, and resets it to the default for good if its face list isn't ready, which takes about 10 seconds.
- Screens keep their last frame when SignalRGB closes.
- The Lian Li Wireless device must fit inside the canvas. Parts outside it read wrong colors, and a large setup may need its scale reduced on the Layouts page.

## Build and test

```bash
node build.cjs
```

```bash
node --openssl-legacy-provider test/sim.cjs
```

The simulation runs against a fake dongle and fake screens, so it doesn't prove the hardware responds. It also can't catch syntax SignalRGB's script engine rejects, except object spread, which it checks for.
