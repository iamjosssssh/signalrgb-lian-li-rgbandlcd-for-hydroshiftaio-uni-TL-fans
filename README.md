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

Community project, not affiliated with Lian Li or WhirlwindFX. Use at your own risk.

Built on [SignalRGB-HydroShift-II-TL-Wireless](https://github.com/ShkourBashtawi/SignalRGB-HydroShift-II-TL-Wireless)
(its framing, tinyuz compressor and stored effects, `vendor/core.cjs`), which ports
[lian-li-linux](https://github.com/sgtaziz/lian-li-linux). The pump screen start-up sequence follows
[signalrgb-hydroshift-ii-s](https://github.com/KnxckbackWili/signalrgb-hydroshift-ii-s). All MIT.

## Install

1. Copy `dist\*.js` to `Documents\WhirlwindFX\Plugins\LianLiLocal`.
2. Run `bridge\build.ps1`, then start `bridge\LianLiLcdBridge.exe`. It needs to run at every sign-in if you have more than one TL LCD fan.
3. In an admin PowerShell, run `scripts\install-takeover.ps1`.
4. Restart SignalRGB. Enable both **Lian Li Wireless** and **Lian Li Wireless Monitor**.
5. To use curves, set **Fan Speeds** on the Lian Li Wireless device to `SignalRGB Fan Control`, then set the curves on the Cooling page.

If you run the bundled OpenRGB through L-Connect, it can also corrupt SignalRGB's RAM scan. See the [motherboard repo](https://github.com/iamjosssssh/signalrgb-msi-x870e-godlike-xedition-controller) for the fix.

## Who owns the hardware

Only one program can hold the dongle and screens, so `scripts\lconnect-handoff.ps1` runs at sign-in and keeps one in charge:

| Situation | Who has the hardware |
|---|---|
| Power-on until SignalRGB starts | L-Connect Service, because wireless fans don't spin until something talks to the dongle |
| SignalRGB running | SignalRGB. The handoff also ends L-Connect's process, which otherwise holds the hardware for about 90 seconds after reporting Stopped |
| SignalRGB closed for 15 seconds | L-Connect Service again |
| L-Connect 3 window open | L-Connect, until the window closes |

Undo with `scripts\uninstall-takeover.ps1`, and remove the `LianLiLocal` folder.

## Fan screens and the bridge

SignalRGB opens a raw USB handle on only one of several identical devices, and gives it to whichever plugin instance wins a startup race. So that instance may be attached to a different physical screen than its own name, and the other instances can't reach their screens at all.

`bridge\LianLiLcdBridge.cs` works around that. Every instance sends its frames to the bridge over `127.0.0.1`, labelled with its real serial number, and the bridge writes them through WinUSB. The one screen SignalRGB is holding can't be opened, so its frames go back to the instance with the handle. With one screen, or with no bridge running, that instance shows its own frames directly.

## Safety

- `src/guard.cjs` checks every wireless write. Only clock, RGB and speed frames can leave the dongle, and only to devices the RX reports as bound to your own dongle, so a neighbour's fans are never touched.
- Reboot, bind, firmware, LCD picture and LCD theme-switch frames are rejected, not just unused.
- Speed frames can't stop a fan or go below its minimum, and can't take the pump below 2000 rpm. They stay on the channel each device already uses.
- The fan-speed frame's pump slot changes the speed the pump reports but not its real speed, so this plugin doesn't use it. Pump speed goes in the AIO parameter block, without the command that switches the screen to its sensor theme.
- An uncertain curve value holds the last speed. No usable value for 30 seconds goes to full speed. If SignalRGB closes, fans get their earlier speed back.
- The screen code can build only frame, brightness, frame-rate, version, stop-play and stop-clock commands. The startup-image (flash), reboot and desktop-mode commands can't be sent. Write timeouts are 2 seconds, because a shorter one can wedge the screen until a power cycle.
- A screen that stops answering is left alone for 10 seconds before trying again.

## Limits

- Live animated effects share about 15 updates per second across all groups, so each gets only a few. For smooth motion use **Lighting Mode: Hardware Effect**.
- After a power cycle the devices show L-Connect's saved effect until SignalRGB takes over.
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
