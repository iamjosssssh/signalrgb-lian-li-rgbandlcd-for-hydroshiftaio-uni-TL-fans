// ---------------------------------------------------------------------------
// Safety layer. Every USB write in the wireless plugins goes through this file.
//
// On the air: clock heartbeat, RGB uploads and fan and pump speed only. LCD theme,
// picture, reboot, bind and firmware frames are rejected here, not just unused.
// Speed frames can't stop a fan or take the pump under LLS_PUMP_MIN_SAFE_RPM.
// Targets: only devices the RX reports as bound to this PC's own TX dongle.
// ---------------------------------------------------------------------------

const LLS_BROADCAST = 0xff;
const LLS_STRIMER_LEDS = { 1: 116, 2: 132, 3: 174, 4: 88 };
const LLS_PUMP_MIN_RPM = 1000;
const LLS_PUMP_MIN_SAFE_RPM = 2000;
const LLS_COOLING_GRACE_MS = 5000;

const llsRoster = { master: "", masterBytes: null, channel: 0, groups: {} };

function llsMacHex(bytes) {
	return Array.from(bytes).map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(":");
}

function llsSetMaster(bytes, channel) {
	llsRoster.masterBytes = bytes.slice();
	llsRoster.master = llsMacHex(bytes);
	llsRoster.channel = channel;
}

function llsFanLabel(rec) {
	const family = llFanFamily((rec.fanTypes || []).find((b) => b !== 0) || 0);
	const name = family ? family.name.replace("UNI FAN ", "").replace(" Wireless", "") : "fan";
	return { label: `${rec.fans}x ${name} (slot ${rec.rx})`, ledsPerFan: family ? family.leds : 26 };
}

// The group an RX record describes, or why it can't be addressed.
function llsGroupFromRecord(rec) {
	if (rec.master !== llsRoster.master) return { problem: `bound to master ${rec.master}` };
	if (!(rec.rx >= 1 && rec.rx <= 13)) return { problem: `on RX slot ${rec.rx}` };
	if (!(rec.ch >= 1 && rec.ch <= 39)) return { problem: `on channel ${rec.ch}` };
	const base = { key: rec.mac, mac: rec.mac, macBytes: llParseMac(rec.mac), rx: rec.rx, ch: rec.ch, type: rec.type, fanTypes: rec.fanTypes || [], right: !!rec.right, fans: 0 };
	if (rec.type === 10 || rec.type === 11) {
		return { group: Object.assign(base, { kind: "pump", leds: LL_LEDS_PER_RING, ledsPerFan: 0, label: `Pump (slot ${rec.rx})` }) };
	}
	if (rec.type === 0 && rec.fans >= 1) {
		const { label, ledsPerFan } = llsFanLabel(rec);
		return { group: Object.assign(base, { kind: "fans", fans: rec.fans, leds: rec.fans * ledsPerFan, ledsPerFan, label }) };
	}
	if (LLS_STRIMER_LEDS[rec.type]) {
		return { group: Object.assign(base, { kind: "strip", leds: LLS_STRIMER_LEDS[rec.type], ledsPerFan: 0, label: `Strimer (slot ${rec.rx})` }) };
	}
	return { problem: `unknown device type ${rec.type}` };
}

function llsAssertTarget(rf, channel, rxTarget, what) {
	const group = llsRoster.groups[llsMacHex(rf.slice(2, 8))];
	if (!group) {
		throw new Error(`guard: ${what} target ${llsMacHex(rf.slice(2, 8))} is not bound to this dongle`);
	}
	if (llsMacHex(rf.slice(8, 14)) !== llsRoster.master) {
		throw new Error(`guard: ${what} frame has the wrong master`);
	}
	if (rxTarget !== group.rx) {
		throw new Error(`guard: ${group.label} must be sent on RX slot ${group.rx}, not ${rxTarget}`);
	}
	if (channel !== group.ch) {
		throw new Error(`guard: ${group.label} listens on channel ${group.ch}, not ${channel}`);
	}
	return group;
}

function llsAssertRgbFrame(rf, channel, rxTarget) {
	const group = llsAssertTarget(rf, channel, rxTarget, "RGB");
	// Keeps leftover bytes from ever reading as a valid RX slot (see lian-li-linux rgb.rs).
	if ((rf[14] & 0x80) === 0) {
		throw new Error("guard: effect index high bit must be set");
	}
	if (rf[18] === 0 && rf[27] !== group.leds) {
		throw new Error(`guard: ${group.label} header must carry ${group.leds} LEDs`);
	}
}

function llsAssertPwmFrame(rf, channel, rxTarget) {
	const group = llsAssertTarget(rf, channel, rxTarget, "speed");
	if (group.kind !== "fans") {
		throw new Error(`guard: speed frames may only go to fans, not ${group.label}`);
	}
	// Fans adopt the channel in byte 15, so it must be the one they already listen on.
	if (rf[14] !== group.rx || rf[15] !== group.ch) {
		throw new Error("guard: speed frame carries the wrong slot or channel");
	}
	const min = Math.trunc(Math.fround(Math.fround(llMinDutyPercent(group.type, group.fanTypes) / 100) * 255));
	for (let i = 0; i < 4; i++) {
		const duty = rf[17 + i];
		if (i < group.fans ? (duty < min || duty === LL_PWM_FOLLOW_MB) : duty !== 0) {
			throw new Error(`guard: duty ${duty} is not allowed on slot ${i} of ${group.label}`);
		}
	}
	if (rf.slice(21).some((b) => b !== 0)) {
		throw new Error("guard: speed frame carries extra data");
	}
}

// The pump's speed travels in the AIO parameter block, as a timer where lower is faster.
function llsAssertPumpFrame(rf, channel, rxTarget) {
	const group = llsAssertTarget(rf, channel, rxTarget, "pump");
	if (group.kind !== "pump") {
		throw new Error(`guard: pump frames may only go to the pump, not ${group.label}`);
	}
	if (rf[14] !== group.rx || rf[15] !== group.ch) {
		throw new Error("guard: pump frame carries the wrong slot or channel");
	}
	const timer = (rf[46] << 8) | rf[47];
	if (timer > llPumpTimer(LLS_PUMP_MIN_SAFE_RPM, group.type === 10 ? "circle" : "square")) {
		throw new Error(`guard: pump timer ${timer} is below the safe speed`);
	}
	if (rf.slice(50).some((b) => b !== 0)) {
		throw new Error("guard: pump frame carries extra data");
	}
}

function llsAssertRf(rf, channel, rxTarget) {
	if (!rf || rf.length !== LL_RF_DATA_SIZE || rf[0] !== LL_RF_SELECT) {
		throw new Error("guard: malformed RF frame");
	}
	if (rf[1] === LL_RF_SET_RGB) {
		llsAssertRgbFrame(rf, channel, rxTarget);
		return;
	}
	if (rf[1] === LL_RF_PWM_CMD) {
		llsAssertPwmFrame(rf, channel, rxTarget);
		return;
	}
	if (rf[1] === LL_RF_AIO_PARAMS) {
		llsAssertPumpFrame(rf, channel, rxTarget);
		return;
	}
	if (rf[1] === LL_RF_CLOCK_SYNC) {
		if (rxTarget !== LLS_BROADCAST || channel !== llsRoster.channel) {
			throw new Error("guard: clock frame must be a broadcast on the master channel");
		}
		if (llsMacHex(rf.slice(8, 14)) !== llsRoster.master) {
			throw new Error("guard: clock frame has the wrong master");
		}
		return;
	}
	throw new Error(`guard: RF opcode 0x${rf[1].toString(16)} is not allowed`);
}

function llsAssertGetMac(packet) {
	if (packet.length !== 64 || packet[0] !== LL_USB_CMD_GET_MAC || !(packet[1] >= 1 && packet[1] <= 39)
		|| packet.slice(2).some((b) => b !== 0)) {
		throw new Error("guard: GetMac packet is not the expected query");
	}
}

function llsAssertGetDev(packet) {
	if (packet.length !== 64 || packet[0] !== LL_USB_CMD_SEND_RF || packet[1] !== 1
		|| packet.slice(2).some((b) => b !== 0)) {
		throw new Error("guard: RX only accepts the device list query");
	}
}

function llsWrite(packet) {
	const r = device.bulk_transfer(0x01, packet, packet.length, 100);
	if (r && typeof r.length === "number" && r.length < 0) {
		throw new Error("USB write failed");
	}
}

function llsRead(timeoutMs) {
	const r = device.bulk_transfer(0x81, new Array(64).fill(0), 64, timeoutMs);
	if (!r || typeof r.length !== "number" || r.length <= 0 || !r.data) {
		return [];
	}
	return Array.from(r.data).slice(0, r.length).map((b) => b & 0xff);
}

function llsLog(msg) {
	device.log(`[LianLi] ${msg}`, {toFile: true});
}

function llsMessage(id, text, tip) {
	try {
		device.addMessage(id, text, tip);
	} catch (e) { /* older SignalRGB builds */ }
}

function llsClearMessage(id) {
	try {
		device.removeMessage(id);
	} catch (e) { /* older SignalRGB builds */ }
}

// Why cooling looks wrong for this record right now, or "".
function llsCoolingProblem(group, rec) {
	if (!rec || rec.stale) return "";
	if (group.kind === "pump" && rec.pumpRpm < LLS_PUMP_MIN_RPM) {
		return `pump at ${rec.pumpRpm} rpm`;
	}
	if (group.kind === "fans") {
		const speeds = rec.rpm.slice(0, group.fans);
		if (speeds.some((v) => v === 0)) {
			return `${group.label} at ${speeds.join("/")} rpm`;
		}
	}
	return "";
}
