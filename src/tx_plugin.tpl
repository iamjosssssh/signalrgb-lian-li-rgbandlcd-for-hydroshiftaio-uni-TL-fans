// Lian Li wireless for SignalRGB (TX dongle).
// Lights every fan group, the pump ring and the Strimer from the SignalRGB canvas,
// and runs fan and pump speed curves from SignalRGB's Cooling page. Finds the devices
// by itself through the RX monitor plugin. See the safety layer for what can be sent.
//
// Built on ShkourBashtawi/SignalRGB-HydroShift-II-TL-Wireless (MIT), which ports
// sgtaziz/lian-li-linux (MIT) and sisong/tinyuz (MIT). Not affiliated with Lian Li.

export function Name() { return "Lian Li Wireless"; }
export function VendorId() { return 0x0416; }
export function ProductId() { return 0x8040; }
export function Publisher() { return "Community"; }
export function Documentation() { return ""; }
export function Type() { return "rawusb"; }
export function Size() { return [48, 18]; }
export function DefaultPosition() { return [16, 70]; }
export function DefaultScale() { return 3.0; }
export function DeviceType() { return "aio"; }
export function SupportsFanControl() { return true; }
export function ConflictingProcesses() { return ["L-Connect 3.exe", "L-Connect-Service.exe"]; }

/* global
LightingMode:readonly
forcedColor:readonly
HwEffect:readonly
HwSpeed:readonly
HwColor:readonly
OnExit:readonly
shutdownColor:readonly
FanControl:readonly
FanFloor:readonly
PumpControl:readonly
PumpFloor:readonly
UpdateRate:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "description":"Canvas follows the active effect. Hardware Effect stores an animation on the devices, which play it smoothly by themselves.", "type":"combobox", "values":["Canvas", "Forced", "Hardware Effect"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
		{"property":"HwEffect", "group":"lighting", "label":"Hardware Effect", "description":"Canvas Loop records 4 seconds of the current SignalRGB effect.", "type":"combobox", "values":["Rainbow Wave", "Rainbow Spin", "Color Cycle", "Breathing", "Spinner", "Static", "Canvas Loop"], "default":"Rainbow Wave"},
		{"property":"HwSpeed", "group":"lighting", "label":"Effect Speed", "type":"number", "min":"1", "max":"10", "step":"1", "default":"5"},
		{"property":"HwColor", "group":"lighting", "label":"Effect Color", "description":"For Breathing, Spinner and Static.", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
		{"property":"OnExit", "group":"lighting", "label":"When SignalRGB Closes", "type":"combobox", "values":["Keep Last Colors", "Shutdown Color", "Hardware Effect"], "default":"Keep Last Colors"},
		{"property":"shutdownColor", "group":"lighting", "label":"Shutdown Color", "min":"0", "max":"360", "type":"color", "default":"#000000"},
		{"property":"FanControl", "group":"", "label":"Fan Speeds", "description":"SignalRGB Fan Control runs each fan group from a curve on the Cooling page. Off leaves the speeds the fans already have.", "type":"combobox", "values":["Off (keep current speeds)", "SignalRGB Fan Control"], "default":"Off (keep current speeds)"},
		{"property":"FanFloor", "group":"", "label":"Lowest Fan Speed (%)", "description":"No curve can take a fan below this, including a new curve that reads 0%.", "type":"number", "min":"11", "max":"100", "step":"1", "default":"30"},
		{"property":"PumpControl", "group":"", "label":"Pump Speed", "description":"SignalRGB Fan Control runs the pump from a curve on the Cooling page. Off leaves the speed it already has.", "type":"combobox", "values":["Off (keep current speed)", "SignalRGB Fan Control"], "default":"Off (keep current speed)"},
		{"property":"PumpFloor", "group":"", "label":"Lowest Pump Speed (%)", "description":"Percent of the pump's speed range. No curve can take the pump below this, or below 2000 rpm at any setting.", "type":"number", "min":"40", "max":"100", "step":"1", "default":"50"},
		{"property":"UpdateRate", "group":"", "label":"Updates per Second", "description":"Shared across all groups, so animated effects run slower on each one.", "type":"combobox", "values":["5", "10", "15", "18"], "default":"15"},
	];
}

import udp from "@SignalRGB/udp";

//@@CORE@@

//@@GUARD@@

const HEARTBEAT_MS = 1000;
const REFRESH_MS = 2000;
const PROBE_MS = 150;
const PROBE_TRIES_BEFORE_NOTICE = 8;
const MONITOR_PORT = 51871;
const MONITOR_STALE_MS = 20000;
const STATUS_MS = 30000;

// Fans drop to their own default speed if commands stop, so each group gets one a second.
const FAN_SEND_MS = 1000;
const FAN_GAP_MS = 150;
const FAN_SETTLE_MS = 3000;
const FAN_NO_LEVEL_MS = 30000;
const PWM_QUIET_MS = 40;
const COOLANT_SENSOR = "Coolant";

const HW_RECORD_FRAMES = 80;
const HW_BLEND_FRAMES = 12;
const HW_RETRY_MS = 4000;
const HW_MAX_TRIES = 5;

let layout = emptyLayout();
let masterOk = false;
let probeQueue = [];
let probeTries = 0;
let lastProbe = 0;
let lastHeartbeat = 0;
let lastSend = 0;
let rgbHoldUntil = 0;
let lastFrame = null;
let nextGroup = 0;
let monitor = null;
let monitorAt = 0;
let socket = null;
let guardTripped = false;
let lowSince = {};
let coolingShown = "";
let recordProblems = {};
let sent = {};
let lastStatus = 0;
let fan = freshFanState();
let fanRestore = [];
let hw = freshHwState();

export function LedNames() { return layout.names; }
export function LedPositions() { return layout.positions; }

export function Validate(endpoint) {
	return endpoint.interface === 0;
}

export function Initialize() {
	masterOk = false;
	probeQueue = channelsToProbe();
	probeTries = 0;
	lastHeartbeat = 0;
	lowSince = {};
	coolingShown = "";
	recordProblems = {};
	sent = {};
	fan = freshFanState();
	fanRestore = [];
	hw = freshHwState();
	llsRoster.groups = {};
	openSocket();
	llsLog("Wireless plugin started.");
}

export function Render() {
	if (guardTripped) {
		return;
	}
	const now = Date.now();

	if (!masterOk) {
		if (now - lastProbe >= PROBE_MS) {
			lastProbe = now;
			safely(probeMaster);
		}
		return;
	}

	if (now - lastHeartbeat >= HEARTBEAT_MS) {
		lastHeartbeat = now;
		safely(() => sendRf(llBuildClockFrame(llsRoster.masterBytes), llsRoster.channel, LLS_BROADCAST));
	}

	syncRoster();
	fanTick(now);
	reportFans();
	checkCooling(now);
	logStatus(now);

	const groups = groupList();
	if (!groups.length) {
		return;
	}
	if (LightingMode === "Hardware Effect") {
		hwTick(now);
		return;
	}
	hw.key = "";
	hwRoll(now);
	if (now < rgbHoldUntil || now - lastSend < 1000 / Math.max(1, parseInt(UpdateRate, 10) || 15)) {
		return;
	}

	// One group per Render, so a full pass never blocks SignalRGB's other devices.
	for (let tries = 0; tries < groups.length; tries++) {
		const group = groups[nextGroup % groups.length];
		nextGroup = (nextGroup + 1) % groups.length;
		if (sendGroupIfDue(group, now)) {
			lastSend = Date.now();
			return;
		}
	}
}

export function Shutdown(SystemSuspending) {
	stopFanControl("shutdown");
	if (masterOk) {
		if (OnExit === "Shutdown Color") {
			sendAllOnce(SystemSuspending ? "#000000" : shutdownColor);
		} else if (OnExit === "Hardware Effect" && !SystemSuspending) {
			hwOnExit();
		}
	}
	try {
		if (socket) {
			socket.close();
		}
	} catch (e) { /* ignore */ }
	socket = null;
}

// ---------------------------- devices and layout ---------------------------

function channelsToProbe() {
	return [8, 8].concat(llChannelProbeOrder());
}

function probeMaster() {
	if (!probeQueue.length) {
		probeQueue = channelsToProbe();
	}
	const channel = probeQueue.shift();
	for (let i = 0; i < 16 && llsRead(5).length; i++) { /* drop stale replies */ }
	const packet = llGetMacPacket(channel);
	llsAssertGetMac(packet);
	llsWrite(packet);
	let r = [];
	for (let i = 0; i < 4 && !r.length; i++) {
		r = llsRead(i === 0 ? 150 : 100);
	}
	if (!llValidMasterResponse(r)) {
		if (++probeTries === PROBE_TRIES_BEFORE_NOTICE) {
			llsMessage("lls_master", "Wireless TX did not answer", "L-Connect probably still owns the dongle. Nothing is being sent.");
		}
		return;
	}
	llsSetMaster(r.slice(1, 7), channel);
	masterOk = true;
	lastHeartbeat = 0;
	llsClearMessage("lls_master");
	llsLog(`TX ${llsRoster.master} answered on channel ${channel}.`);
}

function openSocket() {
	try {
		socket = udp.createSocket();
		socket.on("message", onMonitorMessage);
		socket.on("error", (e) => llsLog(`Monitor socket error: ${e}`));
		socket.bind(MONITOR_PORT);
	} catch (e) {
		socket = null;
		llsLog(`Could not open UDP port ${MONITOR_PORT}: ${e}`);
	}
	llsMessage("lls_wait", "Waiting for the Lian Li Wireless Monitor", "Enable it too. It finds your devices.");
}

function onMonitorMessage(msg) {
	const text = typeof msg === "string" ? msg : (msg && typeof msg.data === "string" ? msg.data : "");
	try {
		const j = JSON.parse(text);
		if (j && j.kind === "lls-monitor" && Array.isArray(j.devices)) {
			monitor = j;
			monitorAt = Date.now();
			llsClearMessage("lls_wait");
		}
	} catch (e) { /* not ours */ }
}

function monitorRecords() {
	return monitor && Date.now() - monitorAt <= MONITOR_STALE_MS ? monitor.devices : [];
}

function recordFor(group) {
	return monitorRecords().find((d) => d.mac === group.mac) || null;
}

// Groups stay once found, so a device that misses a few replies keeps its speed commands.
function syncRoster() {
	let added = false;
	for (const rec of monitorRecords()) {
		if (rec.stale || rec.master !== llsRoster.master) {
			continue;
		}
		const { group, problem } = llsGroupFromRecord(rec);
		if ((problem || "") !== (recordProblems[rec.mac] || "")) {
			recordProblems[rec.mac] = problem || "";
			if (problem) {
				llsLog(`Skipping ${rec.mac}: ${problem}.`);
			}
		}
		if (!group) {
			continue;
		}
		const known = llsRoster.groups[group.key];
		if (known) {
			known.rx = group.rx;
			known.ch = group.ch;
		} else {
			llsRoster.groups[group.key] = group;
			llsLog(`Found ${group.label}: ${group.mac}, channel ${group.ch}, ${group.leds} LEDs.`);
			added = true;
		}
	}
	if (added) {
		layout = buildLayout(groupList());
		try {
			device.setSize(layout.size);
			device.setControllableLeds(layout.names, layout.positions);
		} catch (e) {
			llsLog(`Could not update the layout: ${e}`);
		}
		sent = {};
		hw = freshHwState();
	}
}

function groupList() {
	const order = { fans: 0, pump: 1, strip: 2 };
	return Object.values(llsRoster.groups).sort((a, b) => order[a.kind] - order[b.kind] || a.rx - b.rx);
}

function emptyLayout() {
	return { names: [], positions: [], meta: [], size: [48, 18], ranges: {} };
}

function buildLayout(groups) {
	const out = emptyLayout();
	const rings = groups.reduce((n, g) => n + (g.kind === "fans" ? g.fans : g.kind === "pump" ? 1 : 0), 0);
	const width = Math.max(12 * rings, 24);
	const hasStrip = groups.some((g) => g.kind === "strip");
	out.size = [width, hasStrip ? 18 : 12];
	let cell = 0;
	const ring = (count, label) => {
		const cx = 6 + 12 * cell;
		for (let i = 0; i < count; i++) {
			const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
			out.names.push(`${label} LED ${i + 1}`);
			out.positions.push([Math.round(cx + 5 * Math.cos(a)), Math.round(6 + 5 * Math.sin(a))]);
			out.meta.push({ step: i, count, x: (cx + 5 * Math.cos(a)) / width });
		}
		cell++;
	};
	for (const g of groups) {
		const start = out.names.length;
		if (g.kind === "pump") {
			ring(g.leds, g.label);
		} else if (g.kind === "fans") {
			for (let f = 0; f < g.fans; f++) {
				ring(g.ledsPerFan, `${g.label} fan ${f + 1}`);
			}
		} else {
			const cols = Math.ceil(g.leds / 4);
			for (let i = 0; i < g.leds; i++) {
				const x = 2 + Math.floor((i % cols) * (width - 4) / cols);
				out.names.push(`${g.label} LED ${i + 1}`);
				out.positions.push([x, 13 + Math.floor(i / cols)]);
				out.meta.push({ step: i, count: g.leds, x: x / width });
			}
		}
		out.ranges[g.key] = [start, out.names.length];
	}
	return out;
}

// ------------------------------- lighting ----------------------------------

function grabColors(a, b, override) {
	const forced = override ? hexToRgb(override) : (LightingMode === "Forced" ? hexToRgb(forcedColor) : null);
	const colors = [];
	for (let i = a; i < b; i++) {
		const [x, y] = layout.positions[i];
		const c = forced || device.color(x, y);
		colors.push([c[0] & 0xff, c[1] & 0xff, c[2] & 0xff]);
	}
	return colors;
}

function hexToRgb(hex) {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
	return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

function sendGroupIfDue(group, now) {
	const [a, b] = layout.ranges[group.key];
	const colors = grabColors(a, b);
	const signature = colors.join(",");
	const last = sent[group.key];
	if (last && last.signature === signature && now - last.at < REFRESH_MS) {
		return false;
	}
	const upload = llBuildRgbUpload([colors], 5000, null);
	sent[group.key] = { signature, at: now, count: (last ? last.count : 0) + 1, color: colors[0], effect: upload.effectIndex };
	safely(() => sendUpload(group, upload));
	return true;
}

function sendAllOnce(color) {
	for (const group of groupList()) {
		const [a, b] = layout.ranges[group.key];
		safely(() => sendUpload(group, llBuildRgbUpload([grabColors(a, b, color)], 5000, null)));
	}
}

function sendUpload(group, upload) {
	for (let index = 0; index < upload.packetCount; index++) {
		const rf = llRgbPacket(upload, group.macBytes, llsRoster.masterBytes, index);
		sendRf(rf, group.ch, group.rx);
		if (index === 0) {
			device.pause(2);
			sendRf(rf, group.ch, group.rx);
		}
	}
}

function sendRf(rf, channel, rxTarget) {
	llsAssertRf(rf, channel, rxTarget);
	const target = rf.slice(2, 8);
	const wait = llGapBefore(lastFrame, target, rf[1], Date.now());
	if (wait > 0) {
		device.pause(wait);
	}
	for (const p of llRfToUsbPackets(rf, channel, rxTarget)) {
		llsWrite(p);
		device.pause(1);
	}
	lastFrame = { target, opcode: rf[1], sentAt: Date.now() };
}

function safely(fn) {
	try {
		fn();
	} catch (e) {
		const text = String(e);
		llsLog(`Send failed: ${text}`);
		if (text.indexOf("guard:") >= 0) {
			guardTripped = true;
			llsMessage("lls_guard", "Stopped by the safety check", text);
		}
	}
}

function safeCall(fn) {
	try {
		return fn();
	} catch (e) {
		return undefined;
	}
}

// --------------------------------- fans -------------------------------------
// SignalRGB's Cooling page owns the curves. Each group's level is read once a
// second and sent as a duty. Anything uncertain holds the last speed, and a fan
// is never asked to stop.

function freshFanState() {
	return { active: false, groups: {}, lastSendAt: 0, sensor: false, disabledLogged: false };
}

function fanControlOn() {
	return FanControl === "SignalRGB Fan Control";
}

function pumpControlOn() {
	return PumpControl === "SignalRGB Fan Control";
}

function fanFloor(group) {
	if (group.kind === "pump") {
		const floor = Number(PumpFloor);
		return (floor >= 40 && floor <= 100 ? floor : 50) / 100;
	}
	const floor = Number(FanFloor);
	return (floor >= 11 && floor <= 100 ? floor : 30) / 100;
}

function dutiesFor(group, duty) {
	return [0, 1, 2, 3].map((i) => (i < group.fans ? duty : 0));
}

function pumpShape(group) {
	return group.type === 10 ? "circle" : "square";
}

// The speed to put a group back to: duties for fans, RPM for a pump. A fan that was barely turning
// goes back at 60% instead, and a pump whose speed isn't plausible goes back to full speed.
function handBack(group, rec) {
	if (!rec) {
		return null;
	}
	if (group.kind === "pump") {
		return rec.pumpRpm >= LLS_PUMP_MIN_SAFE_RPM ? rec.pumpRpm : LL_PUMP_RANGE[pumpShape(group)][1];
	}
	return rec.pwm ? llSafeHandBack(rec.pwm, group.fans) : null;
}

function wantsCurve(group) {
	return group.kind === "pump" ? pumpControlOn() : group.kind === "fans" && fanControlOn();
}

function syncFanControls(now) {
	for (const g of groupList()) {
		if (g.kind === "pump" && !fan.sensor) {
			fan.sensor = true;
			fan.active = true;
			safeCall(() => device.createTemperatureSensor(COOLANT_SENSOR));
		}
		if (!wantsCurve(g) || fan.groups[g.key]) {
			continue;
		}
		const rec = recordFor(g);
		safeCall(() => device.createFanControl(g.label));
		fan.groups[g.key] = {
			name: g.label,
			createdAt: now,
			history: [],
			lastDuty: null,
			sentAt: 0,
			noLevelSince: 0,
			rpm: 0,
			original: handBack(g, rec),
		};
		fan.active = true;
		llsLog(`Speed curve available for ${g.label}${rec && rec.pwm ? ` (speed before: ${rec.pwm.join("/")})` : ""}.`);
	}
}

function stopFanControl(reason) {
	if (!fan.active) {
		return;
	}
	const restore = [];
	for (const [key, st] of Object.entries(fan.groups)) {
		safeCall(() => device.removeFanControl(st.name));
		if (st.original && llsRoster.groups[key]) {
			restore.push({ group: llsRoster.groups[key], pwm: st.original, left: 3 });
		}
	}
	if (fan.sensor) {
		safeCall(() => device.removeTemperatureSensor(COOLANT_SENSOR));
	}
	fan = freshFanState();
	llsLog(`Fan control off (${reason}).`);
	if (reason === "shutdown") {
		for (const r of restore) {
			sendSpeed(r.group, r.pwm);
		}
	} else {
		fanRestore = restore;
	}
}

function fanTick(now) {
	const anyOn = fanControlOn() || pumpControlOn();
	const changed = Object.keys(fan.groups).some((key) => !wantsCurve(llsRoster.groups[key]));
	if (anyOn && !changed && !safeCall(() => device.fanControlDisabled())) {
		syncFanControls(now);
	} else if (fan.active) {
		// A disabled Cooling system reads 0 for every fan, so hand the speeds back instead.
		stopFanControl(changed || !anyOn ? "turned off" : "disabled in SignalRGB");
	} else if (anyOn && !fan.disabledLogged) {
		fan.disabledLogged = true;
		llsLog("Speed control is on here but disabled in SignalRGB. Speeds are left alone.");
	}

	// Stay clear of the clock heartbeat, and leave a gap so one group's commands never pile up.
	const sinceBeat = now - lastHeartbeat;
	if (sinceBeat < 200 || sinceBeat > 850 || now - fan.lastSendAt < FAN_GAP_MS) {
		return;
	}
	if (fanRestore.length) {
		const r = fanRestore[0];
		sendSpeed(r.group, r.pwm);
		fan.lastSendAt = now;
		if (--r.left === 0) {
			fanRestore.shift();
		}
		return;
	}
	const due = Object.entries(fan.groups).find(([, st]) => now - st.sentAt >= FAN_SEND_MS - FAN_GAP_MS);
	if (!due) {
		return;
	}
	const [key, st] = due;
	const group = llsRoster.groups[key];
	st.sentAt = now;
	fan.lastSendAt = now;
	if (group.kind === "pump") {
		st.lastDuty = pumpTarget(group, st, now);
		sendPump(group, st.lastDuty);
		return;
	}
	const duty = fanDuty(group, st, now);
	const smooth = llSmoothPwm(st.history, dutiesFor(group, duty));
	st.history = smooth.history;
	const prepared = sendPwm(group, smooth.out);
	if (prepared) {
		st.lastDuty = prepared[0];
	}
}

// lastDuty holds RPM for a pump. Same rules as a fan: hold on anything uncertain, full speed if
// that lasts, and never below the floor.
function pumpTarget(group, st, now) {
	const shape = pumpShape(group);
	const [low, high] = LL_PUMP_RANGE[shape];
	const floorRpm = Math.max(llPumpRpmFromLevel(fanFloor(group), shape), LLS_PUMP_MIN_SAFE_RPM);
	const rec = recordFor(group);
	const current = st.lastDuty === null ? (rec && rec.pumpRpm >= low ? rec.pumpRpm : high) : st.lastDuty;
	const hold = Math.max(current, floorRpm);
	if (now - st.createdAt < FAN_SETTLE_MS) {
		return hold;
	}
	const level = safeCall(() => device.getNormalizedFanlevel(st.name));
	if (typeof level !== "number" || !isFinite(level) || level < 0) {
		st.noLevelSince = st.noLevelSince || now;
		return now - st.noLevelSince >= FAN_NO_LEVEL_MS ? high : hold;
	}
	st.noLevelSince = 0;
	return Math.max(llPumpRpmFromLevel(level, shape), floorRpm);
}

function sendSpeed(group, target) {
	if (group.kind === "pump") {
		sendPump(group, target);
	} else {
		sendPwm(group, target);
	}
}

// The rest of the block is what the theme needs. Without a theme switch command the screen stays
// under USB control, so only the pump timer matters here.
function sendPump(group, rpm) {
	const param = llBuildAioParam({ pumpRpm: rpm, pumpShape: pumpShape(group), brightness: 100, theme: 0, rotation: 0, loopInterval: 3 });
	const frame = llAioParamsFrame(group.macBytes, llsRoster.masterBytes, group.rx, group.ch, slotIndex(group), param);
	safely(() => sendRf(frame, group.ch, group.rx));
	rgbHoldUntil = Date.now() + 30;
}

// getNormalizedFanlevel advances SignalRGB's interpolator, so this runs once per send.
function fanDuty(group, st, now) {
	const rec = recordFor(group);
	const current = rec && rec.pwm && rec.pwm[0] ? rec.pwm[0] : 255;
	const floor = Math.round(fanFloor(group) * 255);
	const hold = Math.max(st.lastDuty === null ? current : st.lastDuty, floor);
	if (now - st.createdAt < FAN_SETTLE_MS) {
		return hold;
	}
	const level = safeCall(() => device.getNormalizedFanlevel(st.name));
	if (typeof level !== "number" || !isFinite(level) || level < 0) {
		st.noLevelSince = st.noLevelSince || now;
		if (now - st.noLevelSince >= FAN_NO_LEVEL_MS) {
			if (st.lastDuty !== 255) {
				llsLog(`No usable fan level for ${st.name} for 30 s: running at full speed.`);
			}
			return 255;
		}
		return hold;
	}
	st.noLevelSince = 0;
	return Math.max(Math.round(Math.min(level, 1) * 255), floor);
}

function sendPwm(group, pwm) {
	const prepared = llPreparePwm(pwm, { deviceType: group.type, fanCount: group.fans, rightAttach: group.right, fanTypes: group.fanTypes });
	const frame = llPwmFrame(group.macBytes, llsRoster.masterBytes, group.rx, group.ch, slotIndex(group), prepared);
	// Fans drop a command that lands while they are still applying a colour upload,
	// so leave a quiet gap after the last RGB frame and send it twice.
	const quiet = PWM_QUIET_MS - (Date.now() - lastSend);
	if (quiet > 0) {
		device.pause(quiet);
	}
	safely(() => sendRf(frame, group.ch, group.rx));
	device.pause(15);
	safely(() => sendRf(frame, group.ch, group.rx));
	rgbHoldUntil = Date.now() + 30;
	return prepared;
}

// 1-based position among devices bound to this master, in RX list order.
function slotIndex(group) {
	const ours = monitorRecords().filter((d) => d.master === llsRoster.master);
	const at = ours.findIndex((d) => d.mac === group.mac);
	return at >= 0 ? at + 1 : Object.keys(llsRoster.groups).indexOf(group.key) + 1;
}

// SignalRGB locks a fan's speed if its RPM stops being reported, so this runs every frame.
function reportFans() {
	for (const [key, st] of Object.entries(fan.groups)) {
		const group = llsRoster.groups[key];
		const rec = recordFor(group);
		if (rec && rec.rpm) {
			const speeds = group.kind === "pump" ? [rec.pumpRpm] : rec.rpm.slice(0, group.fans);
			st.rpm = Math.round(speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length));
		}
		safeCall(() => device.setRPM(st.name, st.rpm));
	}
	if (fan.sensor) {
		const pump = groupList().find((g) => g.kind === "pump");
		const rec = pump ? recordFor(pump) : null;
		if (rec && rec.coolant > 0) {
			safeCall(() => device.SetTemperature(COOLANT_SENSOR, rec.coolant));
		}
	}
}

// A warning only. This plugin can't change the pump, and lighting doesn't affect cooling.
function checkCooling(now) {
	let shown = "";
	for (const group of groupList()) {
		const problem = llsCoolingProblem(group, recordFor(group));
		if (!problem) {
			delete lowSince[group.key];
			continue;
		}
		if (lowSince[group.key] === undefined) {
			lowSince[group.key] = now;
		}
		if (now - lowSince[group.key] >= LLS_COOLING_GRACE_MS) {
			shown = problem;
		}
	}
	if (shown !== coolingShown) {
		coolingShown = shown;
		if (shown) {
			llsLog(`COOLING WARNING: ${shown}.`);
			llsMessage("lls_cooling", `Cooling warning: ${shown}`, "Check the device. L-Connect Service can take over if needed.");
		} else {
			llsClearMessage("lls_cooling");
		}
	}
}

function logStatus(now) {
	if (now - lastStatus < STATUS_MS || !monitorRecords().length) {
		return;
	}
	lastStatus = now;
	const parts = groupList().map((g) => {
		const rec = recordFor(g);
		if (!rec) {
			return `${g.label} no report`;
		}
		const hex = (bytes) => (bytes || []).map((b) => b.toString(16).padStart(2, "0")).join("");
		const out = sent[g.key];
		const effect = `${hex(rec.fx)}${out ? ` (sent ${hex(out.effect)} x${out.count}, color ${out.color.join(",")})` : ""}`;
		if (g.kind === "pump") {
			const st = fan.groups[g.key];
			return `${g.label} ${rec.pumpRpm} rpm${st && st.lastDuty ? `, target ${st.lastDuty}` : ""}, coolant ${rec.coolant} C, effect ${effect}`;
		}
		return g.kind === "fans" ? `${g.label} ${rec.rpm.slice(0, g.fans).join("/")} rpm, duty ${rec.pwm ? rec.pwm[0] : "?"}, effect ${effect}` : `${g.label} effect ${effect}`;
	});
	llsLog(`Status: ${parts.join(" | ")}`);
}

// ---------------------------- stored effects --------------------------------
// The whole animation is uploaded once and each device loops it by itself at up
// to 20 fps. Each device reports the effect it is playing, which confirms the upload.

function freshHwState() {
	return { key: "", targets: [], recording: null, recordStart: 0, lastRecord: 0, checkedAt: 0, loop: null, rolling: [], rollingAt: 0, gaveUp: false };
}

function hwKey() {
	const loop = HwEffect === "Canvas Loop";
	return JSON.stringify([HwEffect, loop ? 0 : HwSpeed, loop ? 0 : HwColor, Object.keys(llsRoster.groups).sort()]);
}

function hwTargets(name, loop) {
	return groupList().map((group) => {
		const [a, b] = layout.ranges[group.key];
		const fit = loop
			? llFitAnimation(loop.frames.map((f) => f.slice(a, b)), Math.max(LL_HW_FRAME_MS, loop.intervalMs))
			: llEffectUpload(name, layout.meta.slice(a, b), HwSpeed, hexToRgb(HwColor));
		return { group, upload: fit.upload, frames: fit.frames, intervalMs: fit.intervalMs, sentAt: 0, tries: 0, ok: false, lostSince: 0 };
	});
}

function hwSend(t, now) {
	t.sentAt = now;
	t.tries++;
	safely(() => sendUpload(t.group, t.upload));
	lastSend = Date.now();
}

function hwStart(name, loop, now) {
	try {
		hw.targets = hwTargets(name, loop);
	} catch (e) {
		hw.targets = [];
		llsLog(`Hardware effect ${name} could not be built: ${e}`);
		return;
	}
	hw.gaveUp = false;
	for (const t of hw.targets) {
		llsLog(`Hardware effect ${name} -> ${t.group.label}: ${t.frames} frames, ${t.upload.compressed.length} bytes.`);
		hwSend(t, now);
	}
	llsClearMessage("lls_hw");
}

function sameEffect(rec, upload) {
	return rec && Array.isArray(rec.fx) && rec.fx.length === 4 && rec.fx.every((b, i) => b === upload.effectIndex[i]);
}

function hwVerify(now) {
	if (now - hw.checkedAt < 1000) {
		return;
	}
	hw.checkedAt = now;
	for (const t of hw.targets) {
		const rec = recordFor(t.group);
		if (t.ok) {
			// A power cycle or another app clears the effect, so send it again.
			if (rec && !rec.stale && !sameEffect(rec, t.upload) && now - t.sentAt > HW_RETRY_MS) {
				if (!t.lostSince) {
					t.lostSince = now;
				} else if (now - t.lostSince > 3000) {
					llsLog(`${t.group.label} stopped playing the hardware effect; uploading it again.`);
					t.ok = false;
					t.tries = 0;
					t.lostSince = 0;
					hwSend(t, now);
				}
			} else {
				t.lostSince = 0;
			}
			continue;
		}
		if (sameEffect(rec, t.upload)) {
			t.ok = true;
			llsLog(`Hardware effect playing on ${t.group.label}.`);
			continue;
		}
		if (now - t.sentAt < HW_RETRY_MS) {
			continue;
		}
		if (t.tries < HW_MAX_TRIES) {
			hwSend(t, now);
		} else if (!hw.gaveUp) {
			hw.gaveUp = true;
			llsLog(`${t.group.label} did not take the hardware effect after ${t.tries} tries. Trying again in 30 s.`);
			llsMessage("lls_hw", "Hardware effect not confirmed", "The device did not report the stored effect. Check the monitor plugin and the wireless link.");
			t.tries = HW_MAX_TRIES - 1;
			t.sentAt = now + 26000;
		}
	}
}

function allColors() {
	return grabColors(0, layout.names.length);
}

function hwTick(now) {
	const key = hwKey();
	if (key !== hw.key) {
		hw.key = key;
		hw.targets = [];
		hw.recording = null;
		if (HwEffect === "Canvas Loop") {
			hw.recording = [];
			hw.lastRecord = 0;
			llsLog("Recording 4 seconds of the SignalRGB canvas for the hardware effect...");
		} else {
			hwStart(HwEffect, null, now);
		}
	}
	if (hw.recording) {
		if (now - hw.lastRecord >= LL_HW_FRAME_MS) {
			if (!hw.recording.length) {
				hw.recordStart = now;
			}
			hw.lastRecord = now;
			hw.recording.push(allColors());
		}
		if (hw.recording.length >= HW_RECORD_FRAMES + HW_BLEND_FRAMES) {
			hw.loop = { frames: llLoopFrames(hw.recording, HW_BLEND_FRAMES), intervalMs: (now - hw.recordStart) / (hw.recording.length - 1) };
			hw.recording = null;
			hwStart("Canvas Loop", hw.loop, now);
		}
		return;
	}
	hwVerify(now);
}

// While the live canvas runs, keep the last few seconds so Canvas Loop can be stored on exit.
function hwRoll(now) {
	if (OnExit !== "Hardware Effect" || HwEffect !== "Canvas Loop") {
		hw.rolling = [];
		return;
	}
	if (now - hw.rollingAt < LL_HW_FRAME_MS || !layout.names.length) {
		return;
	}
	hw.rollingAt = now;
	hw.rolling.push({ at: now, colors: allColors() });
	while (hw.rolling.length > HW_RECORD_FRAMES + HW_BLEND_FRAMES) {
		hw.rolling.shift();
	}
}

function hwOnExit() {
	if (LightingMode === "Hardware Effect" && hw.targets.length && hw.key === hwKey()) {
		return;
	}
	let name = HwEffect;
	let loop = null;
	if (name === "Canvas Loop") {
		const r = hw.rolling;
		if (r.length >= 2 * HW_BLEND_FRAMES) {
			loop = { frames: llLoopFrames(r.map((x) => x.colors), HW_BLEND_FRAMES), intervalMs: (r[r.length - 1].at - r[0].at) / (r.length - 1) };
		} else {
			loop = hw.loop;
			name = loop ? name : "Rainbow Wave";
		}
	}
	try {
		for (const t of hwTargets(name, loop)) {
			safely(() => sendUpload(t.group, t.upload));
		}
		llsLog(`SignalRGB is closing: ${name} stored on the devices.`);
	} catch (e) {
		llsLog(`Could not store the hardware effect on exit: ${e}`);
	}
}
