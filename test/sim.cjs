// Runs the built plugins against a fake dongle, fake screens and a fake clock. No hardware involved.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");
let fails = 0;
let checks = 0;
function ok(cond, name) {
	checks++;
	if (!cond) {
		fails++;
	}
	console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
}

const TX = "LianLi_Wireless.js";
const RX = "LianLi_Wireless_Monitor.js";
const TL_LCD = "LianLi_TL_Wireless_LCD.js";
const H2S_LCD = "LianLi_HydroShift_LCD.js";

const MASTER_HEX = "aa:bb:cc:00:00:01";
const macBytes = (s) => s.split(":").map((h) => parseInt(h, 16));
const MASTER = macBytes(MASTER_HEX);
const base = { master: MASTER_HEX, ch: 8, pwm: [150, 150, 150, 0], coolant: 0, fx: [0, 0, 0, 0], right: false, stale: false };
const DEVICES = [
	{ ...base, mac: "10:00:00:00:00:01", type: 0, rx: 1, fans: 3, fanTypes: [32, 32, 32, 0], rpm: [1367, 1378, 1356, 0], pumpRpm: 0 },
	{ ...base, mac: "10:00:00:00:00:04", type: 0, rx: 4, fans: 1, fanTypes: [32, 0, 0, 0], rpm: [1244, 0, 0, 0], pumpRpm: 0 },
	{ ...base, mac: "10:00:00:00:00:03", type: 0, rx: 3, fans: 3, fanTypes: [28, 28, 28, 0], rpm: [1879, 1866, 1865, 0], pumpRpm: 0 },
	{ ...base, mac: "10:00:00:00:00:06", type: 11, rx: 6, fans: 0, fanTypes: [0, 0, 0, 0], rpm: [0, 0, 0, 3180], pumpRpm: 3180, coolant: 33 },
	{ ...base, mac: "10:00:00:00:00:05", type: 4, rx: 5, fans: 0, fanTypes: [0, 0, 0, 0], rpm: [0, 0, 0, 0], pumpRpm: 0 },
];
// Someone else's master and fans, heard over the air. Must never be touched.
const FOREIGN = { ...base, mac: "20:00:00:00:00:01", master: "bb:bb:bb:bb:bb:bb", ch: 12, type: 0, rx: 2, fans: 3, fanTypes: [28, 28, 28, 0], rpm: [900, 900, 900, 0], pumpRpm: 0 };

function load(file, opts = {}) {
	const state = {
		now: 1000, writes: [], logs: [], messages: {}, handlers: {}, sent: [], replies: [], fanControls: {}, sensors: {}, rpm: {},
		leds: null, size: null, levels: {}, fanDisabled: false, frameRate: null, lcdInit: null, frame: opts.frame === undefined ? [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9] : opts.frame,
		qualities: [], dropWrites: !!opts.noHandle, bridge: [],
	};
	const device = {
		Uid: "1cbe:0006:ABCDEF0123456789",
		log: (m) => state.logs.push(String(m)),
		pause: (ms) => { state.now += ms; },
		color: (x, y) => (opts.steadyColor ? [9, 8, 7] : [x % 256, y % 256, Math.floor(state.now / 16) % 256]),
		addMessage: (id, text) => { state.messages[id] = text; },
		removeMessage: (id) => { delete state.messages[id]; },
		setSize: (s) => { state.size = s; },
		setControllableLeds: (names, positions) => { state.leds = { names, positions }; },
		createFanControl: (n) => { state.fanControls[n] = true; },
		removeFanControl: (n) => { delete state.fanControls[n]; },
		createTemperatureSensor: (n) => { state.sensors[n] = null; },
		removeTemperatureSensor: (n) => { delete state.sensors[n]; },
		SetTemperature: (n, v) => { state.sensors[n] = v; },
		setRPM: (n, v) => { state.rpm[n] = v; },
		fanControlDisabled: () => state.fanDisabled,
		getNormalizedFanlevel: (n) => state.levels[n],
		setFrameRateTarget: (f) => { state.frameRate = f; },
		bulk_transfer: (ep, data, len) => {
			if (ep === 0x01) {
				state.writes.push({ at: state.now, data: data.slice(), len });
				if (opts.onWrite) {
					opts.onWrite(state, data);
				}
				if (data[0] === 0x11 && opts.macReply) {
					state.replies.push(opts.macReply);
				}
				return { length: state.dropWrites ? -1 : len };
			}
			const next = state.replies.shift();
			return next ? { length: next.length, data: next } : { length: -1 };
		},
	};
	const udp = {
		createSocket: () => ({
			on: (ev, fn) => { state.handlers[ev] = fn; },
			bind: () => {},
			close: () => {},
			write: (text) => (text.startsWith("LLB1") ? state.bridge.push(text) : state.sent.push(JSON.parse(text))),
		}),
	};
	const LCD = {
		initialize: (o) => { state.lcdInit = o; },
		getFrame: (o) => { state.qualities.push(o.quality); return state.frame; },
	};
	const fakeDate = { now: () => state.now };
	const params = {
		LightingMode: "Canvas", forcedColor: "#009bde", UpdateRate: "15", HwEffect: "Static", HwSpeed: 5, HwColor: "#112233",
		OnExit: "Keep Last Colors", shutdownColor: "#000000", FanControl: "SignalRGB Fan Control", FanFloor: 30, PumpControl: "Off (keep current speed)", PumpFloor: 50,
		FrameRate: "20", JpegQuality: 75, ScreenBrightness: 100, ...opts.params,
	};
	const code = fs.readFileSync(path.join(dist, file), "utf8")
		.replace(/^import .*$/gm, "")
		.replace(/^export function /gm, "function ");
	const exportsList = {
		[TX]: "Initialize,Render,Shutdown,LedNames,LedPositions,llsAssertRf,llRgbPacket,llBuildRgbUpload,llPwmFrame,llsRoster,llBuildClockFrame,llBuildAioParam,llAioParamsFrame",
		[RX]: "Initialize,Render,llsAssertGetDev",
		[TL_LCD]: "Initialize,Render,Shutdown,lcdHeader,desCbcEncrypt",
		[H2S_LCD]: "Initialize,Render,Shutdown,lcdHeader,desCbcEncrypt",
	}[file];
	const names = Object.keys(params);
	const run = new Function("device", "udp", "LCD", "Date", ...names, `${code}\nreturn {${exportsList}};`);
	return { state, api: run(device, udp, LCD, fakeDate, ...names.map((k) => params[k])) };
}

const macReply = () => {
	const r = new Array(64).fill(0);
	r[0] = 0x11;
	MASTER.forEach((b, i) => { r[1 + i] = b; });
	r[10] = 9;
	return r;
};

function run(p, ms, devices) {
	const end = p.state.now + ms;
	while (p.state.now < end) {
		if (devices) {
			p.state.handlers.message(JSON.stringify({ kind: "lls-monitor", t: p.state.now, devices }));
		}
		p.api.Render();
		p.state.now += 16;
	}
}

// Rebuild RF frames from the 4-part USB writes.
function frames(writes) {
	const out = [];
	for (let i = 0; i + 3 < writes.length; ) {
		const w = writes[i];
		if (w.data[0] !== 0x10) { i++; continue; }
		let rf = [];
		for (let k = 0; k < 4; k++) {
			rf = rf.concat(writes[i + k].data.slice(4));
		}
		out.push({ at: writes[i + 3].at, start: w.at, usb: w.data, rf });
		i += 4;
	}
	return out;
}

const isTarget = (f, mac) => f.rf.slice(2, 8).every((b, i) => b === macBytes(mac)[i]);

console.log("--- static checks on the shipped files");
for (const f of [TX, RX]) {
	const text = fs.readFileSync(path.join(dist, f), "utf8");
	ok(!/llThemeSwitchFrame|llPicFrame|LL_RF_SEND_PIC|LL_RF_AIO_SWITCH/.test(text), `${f}: no LCD theme switch or picture code`);
	ok((text.match(/bulk_transfer\(0x01/g) || []).length === 1, `${f}: exactly one USB write path`);
	ok(!/fetch\(|XMLHttpRequest|WebSocket|writeFile/.test(text), `${f}: no network or file access`);
	ok(/ConflictingProcesses/.test(text), `${f}: waits for L-Connect to release the dongle`);
	ok(!/([0-9a-f]{2}:){5}[0-9a-f]{2}/.test(text.replace(/00:00:00:00:00:00/g, "")), `${f}: no hard-coded device addresses`);
}
for (const f of [TL_LCD, H2S_LCD]) {
	const text = fs.readFileSync(path.join(dist, f), "utf8");
	ok(!/0x28\b|0x0B\b|0x96\b|0xFB\b|0xFC\b/i.test(text.replace(/const (IP|PC1|PC2|P|SBOX)_?[A-Z]* = [\s\S]*?;\n/g, "")), `${f}: no startup image, reboot, mode switch, pump or ring opcodes`);
	ok((text.match(/bulk_transfer\(0x01/g) || []).length === 1, `${f}: exactly one USB write path`);
	ok(/ConflictingProcesses/.test(text), `${f}: waits for L-Connect to release the screen`);
}

for (const f of [TX, RX, TL_LCD, H2S_LCD]) {
	// SignalRGB's script engine rejects the whole file on this syntax, which Node accepts.
	const text = fs.readFileSync(path.join(dist, f), "utf8");
	ok(!/\{\s*\.\.\.|,\s*\.\.\.[a-zA-Z]+\s*[,}]\s*$/m.test(text), `${f}: no object spread`);
}

console.log("--- discovery and layout");
{
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 1500);
	const before = frames(p.state.writes);
	ok(before.length > 0 && before.every((f) => f.rf[1] === 0x14), "without Monitor data only heartbeats are sent");
	run(p, 500, DEVICES.concat([FOREIGN]));
	ok(p.state.leds && p.state.leds.names.length === 294, `294 LEDs found by discovery (got ${p.state.leds && p.state.leds.names.length})`);
	ok(p.state.leds.positions.every(([x, y]) => x >= 0 && y >= 0 && x < p.state.size[0] && y < p.state.size[1]), "every LED inside the device box");
	ok(Object.keys(p.state.fanControls).length === 3, `one fan control per fan group (got ${Object.keys(p.state.fanControls).join(" | ")})`);
}

console.log("--- lighting");
{
	const p = load(TX, { macReply: macReply(), params: { FanControl: "Off (keep current speeds)" } });
	p.api.Initialize();
	run(p, 500, DEVICES.concat([FOREIGN]));
	p.state.writes.length = 0;
	run(p, 8000, DEVICES.concat([FOREIGN]));
	const fr = frames(p.state.writes);
	const rgb = fr.filter((f) => f.rf[1] === 0x20);
	ok(fr.every((f) => f.rf[1] === 0x14 || f.rf[1] === 0x20), "fan control off: only clock and RGB on the air");
	ok(p.state.writes.every((w) => w.data[0] === 0x10 || w.data[0] === 0x11), "only SendRF and GetMac over USB");
	ok(p.state.writes.every((w) => w.data.length === 64), "every USB write is 64 bytes");
	for (const d of DEVICES) {
		const mine = rgb.filter((f) => isTarget(f, d.mac));
		ok(mine.length > 0 && mine.every((f) => f.usb[3] === d.rx && f.usb[2] === 8), `${d.mac} addressed on slot ${d.rx}, channel 8`);
	}
	ok(!fr.some((f) => isTarget(f, FOREIGN.mac)), "another master's fans are never addressed");
	ok(rgb.every((f) => f.usb[3] !== 0xff), "RGB is never broadcast");
	let gapOk = true;
	for (let i = 1; i < fr.length; i++) {
		const a = fr[i - 1];
		const b = fr[i];
		const same = a.rf.slice(2, 8).join() === b.rf.slice(2, 8).join() && a.rf[1] === b.rf[1];
		if (!same && b.start - a.at < (a.rf[1] === 0x20 ? 10 : 5)) {
			gapOk = false;
		}
	}
	ok(gapOk, "air gap kept between frames to different targets");
}
{
	const p = load(TX);
	p.api.Initialize();
	run(p, 6000, DEVICES);
	ok(frames(p.state.writes).length === 0 && !!p.state.messages.lls_master, "TX silent (L-Connect owns it): no RF, message shown");
}

console.log("--- fan control");
{
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 500, DEVICES);
	const names = Object.keys(p.state.fanControls);
	names.forEach((n) => { p.state.levels[n] = 0.6; });
	run(p, 4000, DEVICES);
	p.state.writes.length = 0;
	run(p, 15000, DEVICES);
	const pwm = frames(p.state.writes).filter((f) => f.rf[1] === 0x10);
	for (const d of DEVICES.filter((x) => x.type === 0)) {
		const mine = pwm.filter((f) => isTarget(f, d.mac));
		ok(mine.length >= 20, `${d.mac} gets speed commands every second (${mine.length} frames in 15 s, each sent twice)`);
		const last = mine[mine.length - 1];
		ok(last.usb[3] === d.rx && last.usb[2] === 8 && last.rf[14] === d.rx && last.rf[15] === 8, `${d.mac} addressed on its own slot and channel`);
		const duties = last.rf.slice(17, 21);
		ok(duties.slice(0, d.fans).every((v) => v === 153) && duties.slice(d.fans).every((v) => v === 0), `${d.mac} runs at the curve value (${duties.join("/")})`);
	}
	ok(!pwm.some((f) => isTarget(f, DEVICES[3].mac) || isTarget(f, DEVICES[4].mac)), "pump and Strimer get no speed commands");
	ok(Object.values(p.state.rpm).every((v) => v > 0), `RPM reported to SignalRGB (${Object.values(p.state.rpm).join("/")})`);
	ok(p.state.sensors.Coolant === 33, "coolant temperature published");

	names.forEach((n) => { p.state.levels[n] = 0; });
	p.state.writes.length = 0;
	run(p, 15000, DEVICES);
	const floor = frames(p.state.writes).filter((f) => f.rf[1] === 0x10);
	ok(floor.slice(-3).every((f) => f.rf[17] === 77), `a 0% curve runs at the 30% floor, never stops (${floor[floor.length - 1].rf[17]})`);

	names.forEach((n) => { p.state.levels[n] = undefined; });
	p.state.writes.length = 0;
	run(p, 5000, DEVICES);
	const held = frames(p.state.writes).filter((f) => f.rf[1] === 0x10);
	ok(held.length > 0 && held.every((f) => f.rf[17] === 77), "a missing level holds the last speed");
	run(p, 40000, DEVICES);
	p.state.writes.length = 0;
	run(p, 12000, DEVICES);
	const full = frames(p.state.writes).filter((f) => f.rf[1] === 0x10);
	ok(full[full.length - 1].rf[17] === 255, `no usable level for 30 s goes to full speed (${full[full.length - 1].rf[17]})`);

	names.forEach((n) => { p.state.levels[n] = 0.6; });
	p.state.writes.length = 0;
	p.api.Shutdown(false);
	const bye = frames(p.state.writes).filter((f) => f.rf[1] === 0x10);
	ok(bye.length === 6 && bye.every((f) => f.rf[17] === 150), `shutdown hands every group back at its earlier speed (${bye.length} frames)`);
	ok(Object.keys(p.state.fanControls).length === 0, "shutdown removes the fan controls");
}
{
	const p = load(TX, { macReply: macReply() });
	p.state.fanDisabled = true;
	p.api.Initialize();
	run(p, 8000, DEVICES);
	const fr = frames(p.state.writes);
	ok(!fr.some((f) => f.rf[1] === 0x10), "SignalRGB Fan Control disabled: no speed commands");
}
{
	const low = DEVICES.map((d) => (d.type === 11 ? { ...d, pumpRpm: 400, rpm: [0, 0, 0, 400] } : d));
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 500, DEVICES);
	run(p, 7000, low);
	ok(!!p.state.messages.lls_cooling, "slow pump: warning shown");
	run(p, 500, DEVICES);
	ok(!p.state.messages.lls_cooling, "warning clears when the pump recovers");
}

{
	const pumpDevices = DEVICES.map((d) => (d.type === 11 ? { ...d, pumpRpm: 2450, rpm: [0, 0, 0, 2450] } : d));
	const pumpMac = DEVICES[3].mac;
	const timerOf = (f) => (f.rf[46] << 8) | f.rf[47];
	const p = load(TX, { macReply: macReply(), params: { FanControl: "Off (keep current speeds)", PumpControl: "SignalRGB Fan Control" } });
	p.api.Initialize();
	run(p, 500, pumpDevices);
	const names = Object.keys(p.state.fanControls);
	ok(names.length === 1 && names[0].startsWith("Pump"), `pump control on: one curve, for the pump (${names.join()})`);
	p.state.levels[names[0]] = 0.8;
	run(p, 4000, pumpDevices);
	p.state.writes.length = 0;
	run(p, 15000, pumpDevices);
	let fr = frames(p.state.writes);
	ok(!fr.some((f) => f.rf[1] === 0x10 || f.rf[1] === 0x19), "the pump gets no fan speed or LCD theme frames");
	let pump = fr.filter((f) => f.rf[1] === 0x21);
	ok(pump.length >= 12 && pump.every((f) => isTarget(f, pumpMac)), `pump speed is sent about once a second (${pump.length} in 15 s)`);
	ok(timerOf(pump[pump.length - 1]) === 234, `an 80% curve sets 2880 rpm (timer ${timerOf(pump[pump.length - 1])})`);
	ok(p.state.rpm[names[0]] === 2450, "pump RPM reported to SignalRGB");
	p.state.levels[names[0]] = 0;
	p.state.writes.length = 0;
	run(p, 15000, pumpDevices);
	pump = frames(p.state.writes).filter((f) => f.rf[1] === 0x21);
	ok(timerOf(pump[pump.length - 1]) === 800, `a 0% curve holds the pump at its floor, 2400 rpm (timer ${timerOf(pump[pump.length - 1])})`);
	p.state.writes.length = 0;
	p.api.Shutdown(false);
	fr = frames(p.state.writes).filter((f) => f.rf[1] === 0x21);
	ok(fr.length === 1 && timerOf(fr[0]) === 750, `shutdown hands the pump back at its earlier 2450 rpm (timer ${fr[0] && timerOf(fr[0])})`);
}
{
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 6000, DEVICES);
	ok(!frames(p.state.writes).some((f) => f.rf[1] === 0x21 || (f.rf[1] === 0x10 && isTarget(f, DEVICES[3].mac))), "pump control off: the pump gets no speed commands");
}
{
	// The dongle answers on channel 8 while the devices listen on 39. Nothing may move them.
	const on39 = DEVICES.map((d) => ({ ...d, ch: 39 }));
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 500, on39);
	Object.keys(p.state.fanControls).forEach((n) => { p.state.levels[n] = 0.6; });
	run(p, 6000, on39);
	const fr = frames(p.state.writes);
	const pwm = fr.filter((f) => f.rf[1] === 0x10);
	const rgb = fr.filter((f) => f.rf[1] === 0x20);
	const clock = fr.filter((f) => f.rf[1] === 0x14);
	ok(pwm.length > 0 && pwm.every((f) => f.usb[2] === 39 && f.rf[15] === 39), "speed frames stay on the devices' own channel");
	ok(rgb.length > 0 && rgb.every((f) => f.usb[2] === 39), "RGB follows the devices' channel");
	ok(clock.length > 0 && clock.every((f) => f.usb[2] === 8), "the heartbeat stays on the master channel");
}

console.log("--- stored effects");
{
	const reported = (fxByMac) => DEVICES.map((d) => ({ ...d, fx: fxByMac[d.mac] || d.fx }));
	const p = load(TX, { macReply: macReply(), params: { LightingMode: "Hardware Effect", HwEffect: "Rainbow Spin", FanControl: "Off (keep current speeds)" } });
	p.api.Initialize();
	run(p, 500, DEVICES);
	run(p, 1000, DEVICES);
	const headers = frames(p.state.writes).filter((f) => f.rf[1] === 0x20 && f.rf[18] === 0);
	ok(DEVICES.every((d) => headers.some((f) => isTarget(f, d.mac))), "uploaded to every group");
	ok(headers.every((f) => ((f.rf[25] << 8) | f.rf[26]) > 1), "uploads hold many frames");
	const fx = {};
	for (const f of headers) {
		fx[DEVICES.find((d) => isTarget(f, d.mac)).mac] = f.rf.slice(14, 18);
	}
	run(p, 2000, reported(fx));
	ok(p.state.logs.filter((l) => l.includes("Hardware effect playing")).length === DEVICES.length, "each device's report confirms the upload");
	p.state.writes.length = 0;
	run(p, 8000, reported(fx));
	ok(frames(p.state.writes).every((f) => f.rf[1] === 0x14), "no more uploads once confirmed");
}
{
	const p = load(TX, { macReply: macReply(), params: { OnExit: "Keep Last Colors", FanControl: "Off (keep current speeds)" } });
	p.api.Initialize();
	run(p, 500, DEVICES);
	p.state.writes.length = 0;
	p.api.Shutdown(false);
	ok(p.state.writes.length === 0, "Keep Last Colors sends nothing on exit");
}
{
	const p = load(TX, { macReply: macReply(), params: { OnExit: "Shutdown Color", shutdownColor: "#102030", FanControl: "Off (keep current speeds)" } });
	p.api.Initialize();
	run(p, 500, DEVICES);
	p.state.writes.length = 0;
	p.api.Shutdown(false);
	const heads = frames(p.state.writes).filter((f) => f.rf[1] === 0x20 && f.rf[18] === 0);
	ok(DEVICES.every((d) => heads.some((f) => isTarget(f, d.mac))), "Shutdown Color goes to every group");
}

console.log("--- safety layer rejects forged frames");
{
	const p = load(TX, { macReply: macReply() });
	p.api.Initialize();
	run(p, 500, DEVICES);
	const mac = macBytes(DEVICES[2].mac);
	const forge = (op) => {
		const rf = new Array(240).fill(0);
		rf[0] = 0x12;
		rf[1] = op;
		mac.forEach((b, i) => { rf[2 + i] = b; });
		MASTER.forEach((b, i) => { rf[8 + i] = b; });
		return rf;
	};
	const names = { 0x12: "select group", 0x15: "save config", 0x16: "LCD reboot", 0x19: "AIO theme", 0x22: "picture", 0x23: "217 wifi", 0x27: "MB sync" };
	const rejects = (rf, ch, rx, label) => {
		let threw = false;
		try { p.api.llsAssertRf(rf, ch, rx); } catch (e) { threw = /guard:/.test(String(e)); }
		ok(threw, label);
	};
	for (const op of Object.keys(names).map(Number)) {
		rejects(forge(op), 8, 3, `rejects 0x${op.toString(16)} (${names[op]})`);
	}
	const colors = new Array(78).fill([1, 2, 3]);
	const up = p.api.llBuildRgbUpload([colors], 5000, null);
	const good = p.api.llRgbPacket(up, mac, MASTER, 0);
	let passed = true;
	try { p.api.llsAssertRf(good, 8, 3); } catch (e) { passed = false; }
	ok(passed, "accepts a real RGB frame");
	rejects(good, 8, 0xff, "rejects RGB broadcast");
	rejects(good, 8, 1, "rejects RGB on another slot");
	rejects(good, 39, 3, "rejects RGB on another channel");
	rejects(p.api.llRgbPacket(up, macBytes(FOREIGN.mac), MASTER, 0), 8, 2, "rejects a device not bound to this dongle");
	const shortUp = p.api.llBuildRgbUpload([new Array(24).fill([1, 2, 3])], 5000, null);
	rejects(p.api.llRgbPacket(shortUp, mac, MASTER, 0), 8, 3, "rejects the wrong LED count");

	const pwm = (duties, target = mac, rx = 3) => p.api.llPwmFrame(target, MASTER, rx, 8, 3, duties);
	let pwmOk = true;
	try { p.api.llsAssertRf(pwm([153, 153, 153, 0]), 8, 3); } catch (e) { pwmOk = false; }
	ok(pwmOk, "accepts a real fan speed frame");
	rejects(pwm([0, 0, 0, 0]), 8, 3, "rejects a fan stop");
	rejects(pwm([6, 6, 6, 0]), 8, 3, "rejects the follow-motherboard value");
	rejects(pwm([10, 10, 10, 0]), 8, 3, "rejects a duty under the fan's minimum");
	rejects(pwm([153, 153, 153, 153]), 8, 3, "rejects a duty on an unused slot");
	rejects(pwm([153, 0, 0, 0], macBytes(DEVICES[3].mac), 6), 8, 6, "rejects fan speed frames to the pump");
	const pumpMac = macBytes(DEVICES[3].mac);
	const pumpFrame = (rpm, target = pumpMac, rx = 6) => {
		const param = p.api.llBuildAioParam({ pumpRpm: rpm, pumpShape: "square", brightness: 100, theme: 0, rotation: 0, loopInterval: 3 });
		return p.api.llAioParamsFrame(target, MASTER, rx, 8, 4, param);
	};
	let pumpOk = true;
	try { p.api.llsAssertRf(pumpFrame(2400), 8, 6); } catch (e) { pumpOk = false; }
	ok(pumpOk, "accepts a real pump speed frame");
	rejects(pumpFrame(1600), 8, 6, "rejects a pump speed under 2000 rpm");
	rejects(pumpFrame(2400, mac, 3), 8, 3, "rejects pump frames to fans");
	rejects(pwm([153, 0, 0, 0], macBytes(DEVICES[4].mac), 5), 8, 5, "rejects speed frames to the Strimer");
	rejects(pwm([153, 153, 153, 0]), 8, 1, "rejects a speed frame on another slot");
}

console.log("--- monitor plugin");
{
	const p = load(RX);
	const rec = new Array(42).fill(0);
	macBytes(DEVICES[2].mac).forEach((b, i) => { rec[i] = b; });
	MASTER.forEach((b, i) => { rec[6 + i] = b; });
	rec[12] = 8;
	rec[13] = 3;
	rec[19] = 3;
	rec[20] = 0x81; rec[21] = 2; rec[22] = 3; rec[23] = 4;
	rec[24] = 28;
	rec[28] = 0x07; rec[29] = 0x57;
	rec[36] = 150;
	rec[41] = 0x1c;
	const reply = [0x10, 1, 0, 0].concat(rec);
	for (let i = 0; i < reply.length; i += 64) {
		p.state.replies.push(reply.slice(i, i + 64));
	}
	p.api.Initialize();
	ok(p.state.writes.length === 1 && p.state.writes[0].data[0] === 0x10 && p.state.writes[0].data[1] === 1, "only sends the device list query");
	const shared = p.state.sent[0].devices[0];
	ok(shared.rx === 3 && shared.rpm[0] === 0x757 && shared.pwm[0] === 150 && shared.fx[0] === 0x81 && shared.fanTypes[0] === 28, "parses and shares the record");
	for (let i = 0; i < 20; i++) {
		p.state.now += 1000;
		p.api.Render();
	}
	ok(p.state.writes.every((w) => w.data[0] === 0x10 && w.data[1] === 1 && w.data.slice(2).every((b) => b === 0)), "stays read-only over 20 polls");
	let threw = false;
	const forged = new Array(64).fill(0);
	forged[0] = 0x15;
	try { p.api.llsAssertGetDev(forged); } catch (e) { threw = true; }
	ok(threw, "rejects USB 0x15 (reset companion)");
}

console.log("--- LCD encryption");
function decrypt(enc) {
	const d = crypto.createDecipheriv("des-cbc", Buffer.from("slv3tuzx"), Buffer.from("slv3tuzx"));
	return Buffer.concat([d.update(Buffer.from(enc)), d.final()]);
}
{
	const p = load(TL_LCD);
	const nist = p.api.desCbcEncrypt([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef], [0x13, 0x34, 0x57, 0x79, 0x9b, 0xbc, 0xdf, 0xf1], [0, 0, 0, 0, 0, 0, 0, 0]);
	ok(nist.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") === "85e813540f0ab405", "matches the published DES test vector");
	const h = p.api.lcdHeader(0x65, [0, 1, 2, 3]);
	ok(h.length === 512, "fan screen header is 512 bytes");
	const plain = decrypt(h);
	ok(plain.length === 504 && plain[0] === 0x65 && plain[2] === 0x1a && plain[3] === 0x6d && plain[8] === 0 && plain[9] === 1 && plain[11] === 3, "fan screen header decrypts to the expected layout");
}
{
	const p = load(H2S_LCD);
	const h = p.api.lcdHeader(0x65, [0, 1, 2, 3]);
	ok(h.length === 512 && h[510] === 0xa1 && h[511] === 0x1a && h.slice(504, 510).every((b) => b === 0), "pump header ends with the WinUSB trailer");
	const plain = decrypt(h.slice(0, 504));
	ok(plain.length === 500 && plain[0] === 0x65 && plain[2] === 0x1a && plain[3] === 0x6d && plain[11] === 3, "pump header decrypts to the expected layout");
}

console.log("--- fan screen plugin");
const opcode = (w) => decrypt(w.data.slice(0, 512))[0];
{
	const p = load(TL_LCD);
	p.api.Initialize();
	ok(p.state.lcdInit.width === 400 && p.state.lcdInit.height === 400, "asks SignalRGB for 400x400");
	ok(p.state.frameRate === 20, "uses the Frame Rate setting");
	ok(p.state.writes.map(opcode).join() === [0x0f, 0x0a, 0x0e].join(), "init sends only frame rate, version and brightness");
	p.state.writes.length = 0;
	run(p, 500);
	ok(p.state.writes.length > 0 && p.state.writes.every((w) => opcode(w) === 0x65), "frames use only the JPEG command");
	const w = p.state.writes[0];
	const jpegLen = (decrypt(w.data.slice(0, 512))[8] << 24) | (decrypt(w.data.slice(0, 512))[9] << 16) | (decrypt(w.data.slice(0, 512))[10] << 8) | decrypt(w.data.slice(0, 512))[11];
	ok(w.len === 102400 && w.data.length === 102400, "each frame is one 102400-byte write");
	ok(jpegLen === 7 && w.data[512] === 0xff && w.data[513] === 0xd8 && w.data[518] === 0xd9 && w.data[519] === 0, "JPEG follows the header, zero padded");
	ok(p.state.qualities[0] === 75, "asks for the JPEG Quality setting");
	const count = p.state.writes.length;
	ok(count <= 11 && count >= 8, `frame rate is held to about 20 per second in the plugin too (${count} in 500 ms)`);
}
{
	const huge = new Array(110000).fill(1);
	huge[0] = 0xff;
	huge[1] = 0xd8;
	const p = load(TL_LCD, { frame: huge });
	p.api.Initialize();
	p.state.writes.length = 0;
	run(p, 500);
	ok(p.state.writes.length === 0, "a frame over the 101888-byte limit is dropped");
	ok(Math.min(...p.state.qualities) < 75, "and quality drops for the next ones");
}
{
	const p = load(TL_LCD, { frame: [1, 2, 3] });
	p.api.Initialize();
	p.state.writes.length = 0;
	run(p, 300);
	ok(p.state.writes.length === 0, "anything that isn't a JPEG is never sent");
}
{
	const p = load(TL_LCD);
	p.api.Initialize();
	p.state.dropWrites = true;
	p.state.writes.length = 0;
	run(p, 1000);
	const failed = p.state.writes.length;
	run(p, 3000);
	ok(failed <= 3 && p.state.writes.length === failed, `a failing screen backs off instead of hammering it (${failed} tries)`);
}

console.log("--- fan screens without a USB handle");
{
	const big = new Array(70000).fill(0).map((_, i) => i % 251);
	big[0] = 0xff;
	big[1] = 0xd8;
	const p = load(TL_LCD, { noHandle: true, frame: big });
	p.api.Initialize();
	const writesAtInit = p.state.writes.length;
	ok(writesAtInit === 1, `stops writing to USB once it knows it has no handle (${writesAtInit} write)`);
	ok(p.state.bridge.some((m) => m === "LLB1|ABCDEF0123456789|B|100"), "sends brightness to the bridge");
	p.state.bridge.length = 0;
	run(p, 60);
	const parts = p.state.bridge.filter((m) => m.split("|")[2] !== "B").map((m) => m.split("|"));
	ok(parts.length === 2 && parts[0][1] === "ABCDEF0123456789" && parts.every((x) => x[4] === "2"), `a big frame is split into numbered chunks (${parts.length})`);
	ok(parts.every((x) => x.join("|").length < 60000), "each chunk fits in one UDP packet");
	const rebuilt = Buffer.from(parts.sort((a, b) => a[3] - b[3]).map((x) => x[5]).join(""), "base64");
	ok(rebuilt.length === big.length && rebuilt.every((b, i) => b === big[i]), "chunks rebuild the exact JPEG");
	p.state.bridge.length = 0;
	run(p, 1000);
	ok(p.state.bridge.length === 0, "an unchanged frame isn't sent again straight away");
	run(p, 1200);
	ok(p.state.bridge.length === 2, "but is resent every 2 seconds in case the bridge restarted");
	ok(p.state.writes.length === writesAtInit, "never touches USB while on the bridge");
}
console.log("--- the fan screen instance with the USB handle");
const frameWrites = (p) => p.state.writes.filter((w) => w.len === 102400);
{
	const p = load(TL_LCD);
	p.api.Initialize();
	p.state.writes.length = 0;
	p.state.bridge.length = 0;
	run(p, 300);
	ok(frameWrites(p).length > 0 && !p.state.bridge.some((m) => m.split("|").length === 6), "bridge not running: shows its own frames over USB");
	const hello = () => p.state.handlers.message("LLB1|hello");
	hello();
	p.state.writes.length = 0;
	p.state.bridge.length = 0;
	run(p, 300);
	ok(frameWrites(p).length === 0 && p.state.bridge.some((m) => m.startsWith("LLB1|ABCDEF0123456789|")), "bridge running: sends its own frames there, not to whichever screen the handle is on");
	const jpeg = Buffer.from([0xff, 0xd8, 9, 8, 7, 6, 5]);
	const b64 = jpeg.toString("base64");
	hello();
	p.state.handlers.message(`LLB1|FEDCBA9876543210|1|0|2|${b64.slice(0, 4)}`);
	p.api.Render();
	ok(frameWrites(p).length === 0, "waits for every chunk of a relayed frame");
	p.state.handlers.message(`LLB1|FEDCBA9876543210|1|1|2|${b64.slice(4)}`);
	p.api.Render();
	const relayed = frameWrites(p);
	ok(relayed.length === 1 && relayed[0].data.slice(512, 519).join() === Array.from(jpeg).join() && relayed[0].data[519] === 0, "writes a relayed frame to USB exactly");
	p.state.writes.length = 0;
	p.state.handlers.message("LLB1|FEDCBA9876543210|B|50");
	p.api.Render();
	ok(p.state.writes.length === 1 && decrypt(p.state.writes[0].data.slice(0, 512))[0] === 0x0e && decrypt(p.state.writes[0].data.slice(0, 512))[8] === 30, "applies a relayed brightness");
	p.state.writes.length = 0;
	p.state.handlers.message("LLB1|FEDCBA9876543210|2|0|1|AAAA");
	p.api.Render();
	ok(frameWrites(p).length === 0, "ignores a relayed frame that isn't a JPEG");
	p.state.now += 6000;
	p.state.writes.length = 0;
	run(p, 300);
	ok(frameWrites(p).length > 0, "bridge gone for 5 seconds: goes back to its own frames");
}

console.log("--- pump screen plugin");
{
	const ackFor = (state, data) => {
		const cmd = decrypt(data.slice(0, 504))[0];
		const r = new Array(512).fill(0);
		r[0] = cmd;
		state.replies.push(r);
	};
	const p = load(H2S_LCD, { onWrite: ackFor });
	p.api.Initialize();
	ok(p.state.lcdInit.width === 480 && p.state.lcdInit.height === 480, "asks SignalRGB for 480x480");
	const op = (w) => decrypt(w.data.slice(0, 504))[0];
	ok(p.state.writes.map(op).join() === [0x7b, 0x34, 0x0a, 0x0e].join(), "init matches the sequence tested on this model");
	p.state.writes.length = 0;
	run(p, 500);
	ok(p.state.writes.length > 0 && p.state.writes.every((w) => op(w) === 0x65), "frames use only the JPEG command");
	ok(p.state.writes[0].data.length === 512 + 7 && p.state.writes[0].data[512] === 0xff, "header and JPEG go out in one write");
}
{
	const p = load(H2S_LCD);
	p.api.Initialize();
	p.state.writes.length = 0;
	run(p, 20000);
	ok(p.state.writes.length <= 6, `no acknowledgements: backs off instead of hammering the pump (${p.state.writes.length} frames in 20 s)`);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
