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
export function ImageUrl() { return "https://assets.signalrgb.com/devices/brands/lian-li/fan-controllers/uni-hub-controller.png"; }
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

// ---------------------------------------------------------------------------
// Lian Li L-Wireless protocol core (shared by the TX and RX plugins).
//
// Ported from sgtaziz/lian-li-linux (MIT) and sisong/tinyuz (MIT).
// This block has no SignalRGB dependencies so it can be unit-tested in Node.
// ---------------------------------------------------------------------------

const LL_USB_CMD_SEND_RF = 0x10;
const LL_USB_CMD_GET_MAC = 0x11;

const LL_RF_SELECT = 0x12;
const LL_RF_CLOCK_SYNC = 0x14;
const LL_RF_SET_RGB = 0x20;
const LL_RF_PWM_CMD = 0x10;
const LL_RF_AIO_PARAMS = 0x21;
const LL_AIO_PARAM_LEN = 32;

const LL_RF_DATA_SIZE = 240;
const LL_RF_CHUNK_SIZE = 60;
const LL_RF_CHUNKS = 4;
const LL_RGB_CHUNK_BYTES = 220;
const LL_MAX_COMPRESSED_BYTES = 12288;

const LL_LEDS_PER_RING = 24;

// ----------------------------- tinyuz encoder ------------------------------
// Emits a stream the stock tinyuz decoder accepts: 4-byte LE dict size, then
// type bits interleaved with data / match / ctrl codes, ending in streamEnd.
// Literal-line ctrl codes are never emitted, so the stream is valid whether the
// firmware decoder was built with tuz_isNeedLiteralLine or not.

const TUZ_MIN_DICT_MATCH_LEN = 2;
const TUZ_BIG_POS_FOR_LEN = (1 << 11) + (1 << 9) + (1 << 7) - 1;
const TUZ_CTRL_STREAM_END = 3;
const TUZ_DICT_WINDOW = 4096;
const TUZ_MAX_MATCH = 1024;

function tuzCompress(input) {
	const n = input.length;
	if (n === 0) {
		throw new Error("tinyuz: cannot compress empty input");
	}

	const code = [0, 0, 0, 0]; // dict size placeholder
	let typesIndex = 0;
	let typeCount = 0;
	let haveDataBack = false;
	let dictPosBack = 1;
	let dictSizeMax = 1;

	function outType(bit) {
		if (typeCount === 0) {
			typesIndex = code.length;
			code.push(0);
		}
		code[typesIndex] |= (bit & 1) << typeCount;
		typeCount++;
		if (typeCount === 8) {
			typeCount = 0;
		}
	}

	function outLen(v, packBit) {
		let count = 1;
		while (true) {
			const m = 1 << (count * packBit);
			if (v < m) {
				break;
			}
			v -= m;
			count++;
		}
		let c = count;
		while (c--) {
			for (let i = 0; i < packBit; i++) {
				outType((v >> (c * packBit + i)) & 1);
			}
			outType(c > 0 ? 1 : 0);
		}
	}

	function outDictPos(pos) {
		const isOutLen = pos >= 128 ? 1 : 0;
		if (isOutLen) {
			pos -= 128;
		}
		code.push((pos & 127) | (isOutLen << 7));
		if (isOutLen) {
			outLen(pos >> 7, 2);
		}
	}

	function outData(byte) {
		outType(1);
		code.push(byte & 0xff);
		haveDataBack = true;
	}

	function outDict(matchLen, distance) {
		outType(0);
		const saved = distance; // dict_pos + 1
		if (saved > dictSizeMax) {
			dictSizeMax = saved;
		}
		const isSavedSamePos = dictPosBack === saved && haveDataBack;
		let len = matchLen - TUZ_MIN_DICT_MATCH_LEN;
		if (!isSavedSamePos && saved > TUZ_BIG_POS_FOR_LEN) {
			len--;
		}
		outLen(len, 1);
		if (haveDataBack) {
			outType(isSavedSamePos ? 1 : 0);
		}
		if (!isSavedSamePos) {
			outDictPos(saved);
		}
		haveDataBack = false;
		dictPosBack = saved;
	}

	function outCtrl(ctrl) {
		outType(0);
		outLen(ctrl, 1);
		if (haveDataBack) {
			outType(0);
		}
		outDictPos(0);
	}

	// Greedy LZ77 with a 3-byte hash chain.
	const head = new Map();
	const prev = new Array(n).fill(-1);
	const key = (i) => (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];

	function insert(i) {
		if (i + 2 < n) {
			const k = key(i);
			prev[i] = head.has(k) ? head.get(k) : -1;
			head.set(k, i);
		}
	}

	let i = 0;
	while (i < n) {
		let bestLen = 0;
		let bestDist = 0;

		if (i + 2 < n) {
			let cand = head.has(key(i)) ? head.get(key(i)) : -1;
			let chain = 0;
			while (cand >= 0 && i - cand <= TUZ_DICT_WINDOW && chain < 64) {
				let l = 0;
				const maxL = Math.min(TUZ_MAX_MATCH, n - i);
				while (l < maxL && input[cand + l] === input[i + l]) {
					l++;
				}
				const dist = i - cand;
				const minLen = dist > TUZ_BIG_POS_FOR_LEN ? 3 : TUZ_MIN_DICT_MATCH_LEN;
				if (l >= minLen && l > bestLen) {
					bestLen = l;
					bestDist = dist;
				}
				cand = prev[cand];
				chain++;
			}
		}

		if (bestLen >= 3) {
			outDict(bestLen, bestDist);
			for (let k = 0; k < bestLen; k++) {
				insert(i + k);
			}
			i += bestLen;
		} else {
			outData(input[i]);
			insert(i);
			i++;
		}
	}

	outCtrl(TUZ_CTRL_STREAM_END);

	const dictSize = Math.max(1, dictSizeMax);
	code[0] = dictSize & 0xff;
	code[1] = (dictSize >> 8) & 0xff;
	code[2] = (dictSize >> 16) & 0xff;
	code[3] = (dictSize >> 24) & 0xff;

	return code;
}

// ------------------------------ helpers ------------------------------------

function llParseMac(text) {
	if (typeof text !== "string") {
		return null;
	}
	const parts = text.trim().split(/[:\-\s]/).filter((p) => p.length > 0);
	if (parts.length !== 6) {
		return null;
	}
	const mac = [];
	for (const p of parts) {
		if (!/^[0-9a-fA-F]{1,2}$/.test(p)) {
			return null;
		}
		mac.push(parseInt(p, 16));
	}
	if (mac.every((b) => b === 0)) {
		return null;
	}
	return mac;
}

function llMacToString(mac) {
	return mac.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

function llU16BE(v) {
	return [(v >> 8) & 0xff, v & 0xff];
}

function llU32BE(v) {
	return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

// ---------------------------- RF frames -------------------------------------

// Split a 240-byte RF frame into the four 64-byte USB packets the TX expects.
function llRfToUsbPackets(rf, channel, rxTarget) {
	if (rf.length !== LL_RF_DATA_SIZE) {
		throw new Error("RF frame must be 240 bytes");
	}
	const packets = [];
	for (let idx = 0; idx < LL_RF_CHUNKS; idx++) {
		const p = new Array(64).fill(0);
		p[0] = LL_USB_CMD_SEND_RF;
		p[1] = idx;
		p[2] = channel & 0xff;
		p[3] = rxTarget & 0xff;
		for (let k = 0; k < LL_RF_CHUNK_SIZE; k++) {
			p[4 + k] = rf[idx * LL_RF_CHUNK_SIZE + k];
		}
		packets.push(p);
	}
	return packets;
}

// RF_ClockSync heartbeat. Byte layout mirrors master_clock_rf_data(); the
// per-receiver block is all zeros, as the reference daemon sends it.
function llBuildClockFrame(masterMac) {
	const rf = new Array(LL_RF_DATA_SIZE).fill(0);
	rf[0] = LL_RF_SELECT;
	rf[1] = LL_RF_CLOCK_SYNC;
	for (let k = 0; k < 6; k++) {
		rf[8 + k] = masterMac[k];
	}
	for (let k = 14; k < 64; k++) {
		rf[k] = 0x14;
	}
	return rf;
}

function llGetMacPacket(channel) {
	const p = new Array(64).fill(0);
	p[0] = LL_USB_CMD_GET_MAC;
	p[1] = channel & 0xff;
	return p;
}

function llValidMasterResponse(r) {
	if (!r || r.length < 13 || r[0] !== LL_USB_CMD_GET_MAC) {
		return false;
	}
	let nonZero = false;
	for (let k = 1; k < 7; k++) {
		if (r[k] !== 0) {
			nonZero = true;
		}
	}
	const clock = ((r[7] << 24) | (r[8] << 16) | (r[9] << 8) | r[10]) >>> 0;
	return nonZero && clock > 1;
}

// Channel probe order used by the reference daemon: 8 first, then the even
// channels, then the odd ones.
function llChannelProbeOrder() {
	const order = [8];
	for (let ch = 2; ch <= 38; ch += 2) {
		if (ch !== 8) {
			order.push(ch);
		}
	}
	for (let ch = 1; ch <= 39; ch += 2) {
		order.push(ch);
	}
	return order;
}

// Build every RF frame for one RGB upload (header + data chunks).
// frames: array of frames, each an array of [r,g,b] for every LED.
function llBuildRgbUpload(frames, intervalMs, effectIndex) {
	if (intervalMs < 1 || intervalMs > 40959) {
		throw new Error("RGB interval must be 1..40959 ms");
	}
	return llBuildRgbUploadTicks(frames, intervalMs * 160, effectIndex);
}

// Same, with the interval in hundredths of a 0.625 ms RF tick.
function llBuildRgbUploadTicks(frames, hundredths, effectIndex) {
	if (!frames.length || frames.length > 4096) {
		throw new Error("RGB upload needs 1..4096 frames");
	}
	const ledCount = frames[0].length;
	if (ledCount < 1 || ledCount > 255) {
		throw new Error("RGB upload needs 1..255 LEDs per frame");
	}
	if (hundredths < 100 || hundredths > 6553599) {
		throw new Error("RGB interval out of range");
	}

	const raw = [];
	for (const frame of frames) {
		if (frame.length !== ledCount) {
			throw new Error("RGB frames must have equal LED counts");
		}
		for (const c of frame) {
			raw.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff);
		}
	}

	const compressed = tuzCompress(raw);
	if (compressed.length > LL_MAX_COMPRESSED_BYTES) {
		throw new Error("compressed RGB animation is too large");
	}

	const intervalTicks = Math.floor(hundredths / 100);
	const intervalFraction = hundredths % 100;
	const dataPackets = Math.ceil(compressed.length / LL_RGB_CHUNK_BYTES);

	// FNV-1a over the payload + timing, as the vendor uploader does. The high
	// bit keeps the first byte from ever looking like a valid RX slot.
	let hash = 0x811c9dc5;
	const feed = (b) => {
		hash = Math.imul(hash ^ (b & 0xff), 0x01000193) >>> 0;
	};
	compressed.forEach(feed);
	llU16BE(intervalTicks).forEach(feed);
	feed(intervalFraction);
	llU16BE(frames.length).forEach(feed);
	feed(ledCount);
	[0, 0, 0, 0, 0].forEach(feed); // secondary interval (u16), secondary frames (u16), outer_longest
	const autoIndex = llU32BE(hash);
	autoIndex[0] |= 0x80;

	return {
		compressed,
		ledCount,
		frameCount: frames.length,
		intervalTicks,
		intervalFraction,
		effectIndex: (effectIndex || autoIndex).slice(0, 4),
		packetCount: dataPackets + 1,
	};
}

function llRgbPacket(upload, mac, master, index) {
	const p = new Array(LL_RF_DATA_SIZE).fill(0);
	p[0] = LL_RF_SELECT;
	p[1] = LL_RF_SET_RGB;
	for (let k = 0; k < 6; k++) {
		p[2 + k] = mac[k];
		p[8 + k] = master[k];
	}
	for (let k = 0; k < 4; k++) {
		p[14 + k] = upload.effectIndex[k];
	}
	p[18] = index & 0xff;
	p[19] = upload.packetCount & 0xff;

	if (index === 0) {
		const len = llU32BE(upload.compressed.length);
		for (let k = 0; k < 4; k++) {
			p[20 + k] = len[k];
		}
		const fc = llU16BE(upload.frameCount);
		p[25] = fc[0];
		p[26] = fc[1];
		p[27] = upload.ledCount;
		const it = llU16BE(upload.intervalTicks);
		p[32] = it[0];
		p[33] = it[1];
		p[34] = upload.intervalFraction;
		// [35..40] secondary timing: unused (zero)
	} else {
		const offset = (index - 1) * LL_RGB_CHUNK_BYTES;
		const end = Math.min(upload.compressed.length, offset + LL_RGB_CHUNK_BYTES);
		for (let k = offset; k < end; k++) {
			p[20 + (k - offset)] = upload.compressed[k];
		}
	}
	return p;
}

// Discovery: one 42-byte record from the RX GetDev reply.
function llParseDeviceRecord(d) {
	if (!d || d.length < 42 || d[41] !== 0x1c) {
		return null;
	}
	const mac = d.slice(0, 6);
	if (mac.every((b) => b === 0)) {
		return null;
	}
	const rawFans = d[19];
	const status = d[28];
	return {
		mac,
		masterMac: d.slice(6, 12),
		channel: d[12],
		rxType: d[13],
		deviceType: d[18],
		isMaster: d[18] === 0xff,
		fanCount: Math.min(rawFans >= 10 ? rawFans - 10 : rawFans, 4),
		coolantC: d[27],
		fanRpm: [
			((d[28] & 0x0f) << 8) | d[29],
			((d[30] & 0x0f) << 8) | d[31],
			((d[32] & 0x0f) << 8) | d[33],
			((d[34] & 0x0f) << 8) | d[35],
		],
		mbRgbSync: (status & 0x40) !== 0,
		pwmLineOn: (status & 0x20) !== 0,
		rightAttach: rawFans >= 10,
		currentPwm: d.slice(36, 40),
		cmdSeq: d[40],
		fanTypes: d.slice(24, 28),
		effectIndex: d.slice(20, 24),
	};
}

function llParseGetDev(resp) {
	if (!resp || resp.length < 4 || resp[0] !== LL_USB_CMD_SEND_RF) {
		return null;
	}
	const count = resp[1];
	const out = [];
	let off = 4;
	for (let i = 0; i < count && off + 42 <= resp.length; i++, off += 42) {
		const rec = llParseDeviceRecord(resp.slice(off, off + 42));
		if (rec) {
			out.push(rec);
		}
	}
	return out;
}

function llDeviceTypeName(t) {
	switch (t) {
	case 10: return "HydroShift II LCD-C (Wireless)";
	case 11: return "HydroShift II LCD-S (Wireless)";
	case 65: return "Lancool 217";
	case 66: return "Lancool V150";
	case 88: return "Universal Screen 8.8\"";
	case 0xff: return "Wireless master (TX)";
	default:
		return t >= 1 && t <= 9 ? "Strimer Wireless" : "Wireless fans";
	}
}

// Wireless fan family from the per-slot fan type byte (lian-li-linux fan_type.rs).
function llFanFamily(typeByte) {
	const b = typeByte;
	if (b >= 20 && b <= 22) return { name: "UNI FAN SL V3 Wireless", leds: 40 };
	if (b >= 23 && b <= 26) return { name: "UNI FAN SL V3 Wireless LCD", leds: 40 };
	if (b === 27 || (b >= 32 && b <= 35)) return { name: "UNI FAN TL Wireless LCD", leds: 26 };
	if (b >= 28 && b <= 31) return { name: "UNI FAN TL Wireless", leds: 26 };
	if (b >= 36 && b <= 39) return { name: "UNI FAN SL-INF Wireless", leds: 44 };
	if (b >= 40 && b <= 42) return { name: "UNI FAN CL Wireless", leds: 24 };
	if (b >= 43 && b <= 50) return { name: "UNI FAN SL-INF V3 Wireless", leds: 44 };
	if (b >= 51 && b <= 58) return { name: "UNI FAN TL V3 Wireless", leds: 26 };
	if (b >= 59 && b <= 62) return { name: "UNI FAN SL V4 Wireless", leds: 52 };
	if (b === 63) return { name: "UNI FAN P28 V2 Wireless", leds: 9 };
	if (b === 126 || b === 127) return { name: "UNI FAN CL V2 Wireless", leds: 24 };
	return null;
}

// Canvas layout. Index order matches what each device's firmware expects:
// [0..24) pump-head ring, then fan 1, fan 2, ... (ledsPerFan each).
function llBuildLayout(fanCount, ledsPerFan, rotation, reverse) {
	const names = [];
	const positions = [];
	const meta = []; // per LED: ring step / count (exact), x across the canvas 0..1
	const width = 12 * (fanCount + 1);
	const ring = (count, cx, cy, r, label) => {
		for (let i = 0; i < count; i++) {
			let step = reverse ? (count - i) % count : i;
			step = (step + Math.round((rotation * count) / LL_LEDS_PER_RING)) % count;
			const a = -Math.PI / 2 + (2 * Math.PI * step) / count;
			names.push(`${label} LED ${i + 1}`);
			const x = Math.round(cx + r * Math.cos(a));
			positions.push([x, Math.round(cy + r * Math.sin(a))]);
			meta.push({ step, count, x: (cx + r * Math.cos(a)) / width });
		}
	};
	ring(LL_LEDS_PER_RING, 6 + 12 * fanCount, 6, 5, "Pump");
	for (let f = 0; f < fanCount; f++) {
		ring(ledsPerFan, 6 + 12 * f, 6, 5, `Fan ${f + 1}`);
	}
	return {
		names,
		positions,
		meta,
		size: [12 * (fanCount + 1), 12],
		pumpCount: LL_LEDS_PER_RING,
		fanLedCount: fanCount * ledsPerFan,
	};
}


// ------------------------------ AIO LCD -------------------------------------
// The HydroShift II LCD has a built-in "wireless theme" mode that draws CPU/GPU
// values the host sends in a 32-byte aio_param block (RF_AIO_PARAMS). The block
// also carries the pump speed, so every send sets the pump too.
// Ported from lian-li-linux: wireless/aio.rs + daemon controllers/aio.rs.

const LL_PUMP_RANGE = {
	square: [1600, 3200], // LCD-S (WaterBlock2)
	circle: [1600, 2500], // LCD-C (WaterBlock)
};

// Rust computes these curves in f32; Math.fround keeps the truncation identical.
function llF32Curve(rpm, lo, hi, segments) {
	const f = Math.fround;
	const r = f(Math.min(Math.max(rpm, lo), hi));
	for (const [upTo, base, start, slope] of segments) {
		if (r <= upTo) {
			const t = f(f(base) - f(f(r - start) * f(slope)));
			return Math.min(Math.max(Math.trunc(t), 0), 0xffff);
		}
	}
	return 0;
}

function llSquarePumpTimer(rpm) {
	return llF32Curve(rpm, 1600, 3200, [
		[1800, 1590, 1600, 0.95],
		[2000, 1400, 1800, 1],
		[2200, 1200, 2000, 1],
		[2400, 1000, 2200, 1],
		[2600, 800, 2400, 1],
		[2800, 580, 2600, 1.11],
		[3000, 330, 2800, 1.2],
		[Infinity, 90, 3000, 0.45],
	]);
}

function llCirclePumpTimer(rpm) {
	return llF32Curve(rpm, 1600, 2500, [
		[1720, 1500, 1600, 1.667],
		[1870, 1300, 1720, 2],
		[2000, 1000, 1870, 1.23],
		[2300, 840, 2000, 2],
		[2400, 240, 2300, 1.8],
		[Infinity, 60, 2400, 0.5],
	]);
}

function llPumpTimer(rpm, shape) {
	return shape === "circle" ? llCirclePumpTimer(rpm) : llSquarePumpTimer(rpm);
}

// Colors are [r, g, b] (alpha is always 255) and written as A, R, G, B.
function llBuildAioParam(o) {
	const p = new Array(LL_AIO_PARAM_LEN).fill(0);
	const val = (v) => (typeof v === "number" && isFinite(v) ? Math.trunc(Math.min(Math.max(v, 0), 99)) : null); // Rust: clamp(0,99) as u8
	const sensors = [o.cpuTemp, o.cpuLoad, o.gpuTemp, o.gpuLoad].map(val);
	for (let k = 0; k < 4; k++) {
		p[k] = sensors[k] === null ? 0 : sensors[k];
		p[8 + k] = sensors[k] === null ? 0 : 1;
	}
	p[6] = Math.min(Math.max(o.loopInterval || 3, 1), 30);
	p[7] = 1;
	const argb = (at, c) => {
		const rgb = c || [255, 255, 255];
		p[at] = 255;
		p[at + 1] = rgb[0] & 0xff;
		p[at + 2] = rgb[1] & 0xff;
		p[at + 3] = rgb[2] & 0xff;
	};
	argb(13, o.labelColor);
	argb(17, o.valueColor);
	argb(21, o.unitColor);
	p[25] = Math.min(Math.max(o.brightness === undefined ? 80 : o.brightness, 0), 100);
	p[26] = 1;
	p[27] = Math.min(Math.max(o.theme || 0, 0), 12);
	const timer = llPumpTimer(o.pumpRpm, o.pumpShape);
	p[28] = (timer >> 8) & 0xff;
	p[29] = timer & 0xff;
	p[30] = Math.min(Math.max(o.rotation || 0, 0), 3);
	return p;
}

function llAioHeader(opcode, mac, master, rxSlot, masterChannel, slotIndex) {
	const rf = new Array(LL_RF_DATA_SIZE).fill(0);
	rf[0] = LL_RF_SELECT;
	rf[1] = opcode;
	for (let k = 0; k < 6; k++) {
		rf[2 + k] = mac[k];
		rf[8 + k] = master[k];
	}
	rf[14] = rxSlot & 0xff;
	rf[15] = masterChannel & 0xff;
	rf[16] = slotIndex & 0xff;
	return rf;
}

function llAioParamsFrame(mac, master, rxSlot, masterChannel, slotIndex, param) {
	const rf = llAioHeader(LL_RF_AIO_PARAMS, mac, master, rxSlot, masterChannel, slotIndex);
	for (let k = 0; k < LL_AIO_PARAM_LEN; k++) {
		rf[18 + k] = param[k] & 0xff;
	}
	return rf;
}


// ------------------------------ Fan speed ------------------------------------
// RF_PWM_CMD (0x10): four PWM duties (0-255), one per fan slot; slot 3 is the
// pump on an AIO. Wireless fans fall back to their default speed when the host
// goes quiet, so the target is re-sent every second.
// Ported from lian-li-linux wireless/fan_speed.rs (prepare_pwm, build_pwm_packet).

function llMinDutyPercent(deviceType, fanTypes) {
	if (deviceType === 10 || deviceType === 11 || deviceType === 66) return 10;
	if ((deviceType >= 1 && deviceType <= 9) || deviceType === 65 || deviceType === 88) return 0;
	const b = (fanTypes || []).find((x) => x !== 0) || 0;
	if ((b >= 20 && b <= 26) || (b >= 59 && b <= 62)) return 14;
	if ((b >= 28 && b <= 31) || (b >= 36 && b <= 39) || (b >= 51 && b <= 58)) return 11;
	if (b === 63) return 8;
	return 10; // TL LCD, CL, SL-INF V3, unknown
}

function llIsClFan(fanTypes) {
	const b = (fanTypes || []).find((x) => x !== 0) || 0;
	return (b >= 40 && b <= 42) || b === 126 || b === 127;
}

// rec: {deviceType, fanCount, rightAttach, fanTypes}
function llPreparePwm(pwm, rec) {
	const out = [0, 1, 2, 3].map((i) => Math.min(Math.max(Math.round(pwm[i] || 0), 0), 255));
	const isAio = rec.deviceType === 10 || rec.deviceType === 11;
	const f = Math.fround;
	const minPwm = Math.trunc(f(f(llMinDutyPercent(rec.deviceType, rec.fanTypes) / 100) * 255));
	const cl = isAio || rec.deviceType !== 0 ? false : llIsClFan(rec.fanTypes);
	for (let i = 0; i < 4; i++) {
		if (i >= rec.fanCount && !(i === 3 && isAio)) {
			out[i] = 0;
			continue;
		}
		if (out[i] > 0 && out[i] < minPwm) {
			out[i] = minPwm;
		}
		if (cl) {
			if (out[i] === 153 || out[i] === 154) out[i] = 152;
			else if (out[i] === 155) out[i] = 156;
		}
	}
	if (rec.rightAttach) {
		const n = Math.min(rec.fanCount, 4);
		if (n > 1) {
			const head = out.slice(0, n).reverse();
			for (let i = 0; i < n; i++) out[i] = head[i];
		}
	}
	return out;
}

// L-Connect never sends the raw value a curve produced: it averages the last
// ten requests (and drops the history on a big jump), so a temperature that
// wanders a little does not make the fans hunt. 6 is reserved by the firmware
// ("follow the motherboard header"), so a real request for it becomes 7.
const LL_PWM_FOLLOW_MB = 6;

function llSmoothPwm(history, target, size, resetJump) {
	const n = size || 10;
	const jump = resetJump || 100;
	let h = history || [];
	if (h.length && target.some((v, k) => Math.abs(v - h[0][k]) > jump)) {
		h = [];
	}
	h = h.concat([target.slice()]);
	while (h.length > n) {
		h.shift();
	}
	const out = [0, 1, 2, 3].map((k) => {
		const mean = Math.round(h.reduce((sum, row) => sum + (row[k] || 0), 0) / h.length);
		return mean === LL_PWM_FOLLOW_MB ? LL_PWM_FOLLOW_MB + 1 : mean;
	});
	return { history: h, out };
}

// Duty to hand the fans back at when control stops. A fan that was stopped
// (or barely turning) when control started is handed back at 60 % instead,
// so switching Fan Control off never leaves the fans standing still.
function llSafeHandBack(pwm, fanCount) {
	const n = fanCount > 0 ? fanCount : 4;
	return [0, 1, 2, 3].map((i) => {
		const v = pwm[i] || 0;
		return i < n && v < 51 ? 153 : v;
	});
}

function llPwmFrame(mac, master, rxSlot, masterChannel, slotIndex, pwm) {
	const rf = llAioHeader(LL_RF_PWM_CMD, mac, master, rxSlot, masterChannel, slotIndex);
	for (let k = 0; k < 4; k++) {
		rf[17 + k] = pwm[k] & 0xff;
	}
	return rf;
}


function llPumpRpmFromLevel(level, shape) {
	const [lo, hi] = LL_PUMP_RANGE[shape === "circle" ? "circle" : "square"];
	const l = Math.min(Math.max(typeof level === "number" && isFinite(level) ? level : 1, 0), 1);
	return Math.round(lo + l * (hi - lo));
}

// RF pacing: frames to a new target or of a new kind wait out the air gap.
function llGapBefore(last, target, opcode, nowMs) {
	if (!last) {
		return 0;
	}
	const same = last.opcode === opcode && last.target.every((b, k) => b === target[k]);
	if (same) {
		return 0;
	}
	const gap = last.opcode === LL_RF_SET_RGB ? 10 : 5;
	return Math.max(0, gap - (nowMs - last.sentAt));
}



// --------------------------- Stored (hardware) effects -----------------------
// A multi-frame RGB upload is stored on the device, which then loops it by
// itself at up to 20 frames per second: smooth, no radio traffic, and it keeps
// running after SignalRGB closes. lian-li-linux limits playback to 50 ms per
// frame and the compressed animation to 12288 bytes.

const LL_HW_FRAME_MS = 50;
const LL_HW_MAX_FRAMES = 400;
const LL_HW_EFFECTS = ["Rainbow Wave", "Rainbow Spin", "Color Cycle", "Breathing", "Spinner", "Static"];

function llHsvToRgb(h, s, v) {
	h = ((h % 1) + 1) % 1;
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function llScale(color, k) {
	return color.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
}

// Effect period in ms for speed 1 (slow) .. 10 (fast).
function llEffectPeriod(name, speed) {
	const s = Math.min(10, Math.max(1, Math.round(Number(speed) || 5)));
	const slow = name === "Breathing" || name === "Color Cycle" ? 12000 : 9000;
	const fast = name === "Breathing" || name === "Color Cycle" ? 2500 : 1300;
	return Math.round(slow + ((fast - slow) * (s - 1)) / 9);
}

// One looping colour function per effect; phase runs 0..1 over the period.
// steps: frames in the loop; the wave's hue is snapped to the same grid so each
// frame reuses the previous frames' colours (about 2x smaller upload).
function llEffectColor(name, led, phase, color, steps) {
	const angle = led.step / led.count;
	switch (name) {
	case "Rainbow Wave": {
		const h = led.x - phase;
		return llHsvToRgb(steps ? Math.round(h * steps) / steps : h, 1, 1);
	}
	case "Rainbow Spin":
		return llHsvToRgb(angle - phase, 1, 1);
	case "Color Cycle":
		return llHsvToRgb(phase, 1, 1);
	case "Breathing": {
		const b = (1 - Math.cos(2 * Math.PI * phase)) / 2;
		return llScale(color, b * b);
	}
	case "Spinner": {
		const d = (((phase - angle) % 1) + 1) % 1; // distance behind the head
		const k = Math.max(0, 1 - d * 2.5);
		return llScale(color, k * k);
	}
	default:
		return color.slice();
	}
}

// Frame plan for one device. Spinning effects use a whole number of frames per
// LED step so every frame is an exact rotation of the last (compresses well).
function llEffectPlan(name, leds, speed) {
	if (name === "Static") {
		return { frames: 1, intervalMs: 1000 };
	}
	const period = llEffectPeriod(name, speed);
	let frames = Math.max(2, Math.round(period / LL_HW_FRAME_MS));
	if (name === "Rainbow Spin" || name === "Spinner") {
		const count = leds.length ? leds[0].count : 24;
		frames = Math.max(1, Math.round(frames / count)) * count;
	}
	frames = Math.min(frames, LL_HW_MAX_FRAMES);
	return { frames, intervalMs: Math.max(LL_HW_FRAME_MS, period / frames) };
}

function llEffectFrames(name, leds, frames, color) {
	const out = [];
	for (let f = 0; f < frames; f++) {
		out.push(leds.map((led) => llEffectColor(name, led, f / frames, color, frames)));
	}
	return out;
}

// Builds the upload, halving the frame rate until it fits the device memory.
// intervalMs may be fractional; the RF timing has 1/100 tick precision.
function llBuildRgbUploadFrac(frames, intervalMs) {
	return llBuildRgbUploadTicks(frames, Math.round(intervalMs * 160), null);
}

function llFitAnimation(frames, intervalMs) {
	let f = frames;
	let interval = intervalMs;
	for (;;) {
		try {
			const up = llBuildRgbUploadFrac(f, interval);
			return { upload: up, frames: f.length, intervalMs: interval };
		} catch (e) {
			if (!/too large/.test(String(e)) || f.length <= 1) {
				throw e;
			}
			const half = f.filter((_, i) => i % 2 === 0);
			interval = (interval * f.length) / half.length;
			f = half;
		}
	}
}

// Turns a recording into a seamless loop: the last `blend` frames are faded
// into the first ones, so the end runs straight back into the start.
function llLoopFrames(recorded, blend) {
	const b = Math.max(0, Math.min(blend, Math.floor(recorded.length / 2)));
	const n = recorded.length - b;
	const out = [];
	for (let i = 0; i < n; i++) {
		if (i < b) {
			const k = (i + 1) / (b + 1);
			out.push(recorded[i].map((c, j) => c.map((v, ch) => Math.round(recorded[n + i][j][ch] * (1 - k) + v * k))));
		} else {
			out.push(recorded[i]);
		}
	}
	return out;
}

function llEffectUpload(name, leds, speed, color) {
	const plan = llEffectPlan(name, leds, speed);
	const frames = llEffectFrames(name, leds, plan.frames, color);
	return llFitAnimation(frames, plan.intervalMs);
}



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


const HEARTBEAT_MS = 1000;
const REFRESH_MS = 2000;
const CONFIRM_RETRY_MS = 130;
const CONFIRM_WINDOW_MS = 10000;
const RETRY_REPEATS = 3;
const RETRY_GAP_MS = 10;

// A solid color is still a one-frame animation to the device. A short frame means a new upload has no long frame to wait out.
const SOLID_FRAME_MS = LL_HW_FRAME_MS;
const PROBE_MS = 150;
const PROBE_TRIES_BEFORE_NOTICE = 8;
const MONITOR_PORT = 51871;
const MONITOR_STALE_MS = 20000;
const STEADY_REPORTS = 3;
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
let lastCounted = null;
let recordCounts = {};
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
	logLanding(now);
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

// The RX can return a record while it's being updated, with part of the address or type zeroed.
// So a record only counts once it has looked the same in several reports running.
function steadyRecords() {
	if (monitor === lastCounted) {
		return [];
	}
	lastCounted = monitor;
	const counts = {};
	const steady = [];
	for (const rec of monitorRecords()) {
		if (rec.stale) {
			continue;
		}
		const id = [rec.mac, rec.master, rec.rx, rec.ch, rec.type, rec.fans].join("|");
		counts[id] = (recordCounts[id] || 0) + 1;
		if (counts[id] >= STEADY_REPORTS) {
			steady.push(rec);
		}
	}
	recordCounts = counts;
	return steady;
}

// Groups stay once found, so a device that misses a few replies keeps its speed commands.
function syncRoster() {
	let added = false;
	for (const rec of steadyRecords()) {
		if (rec.master !== llsRoster.master) {
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
	const changed = !last || last.signature !== signature;
	// Uploads get lost on the radio, so a new color is resent quickly until the device reports it.
	const unconfirmed = !changed && !last.landed && now - last.changedAt < CONFIRM_WINDOW_MS;
	if (!changed && now - last.at < (unconfirmed ? CONFIRM_RETRY_MS : REFRESH_MS)) {
		return false;
	}
	const upload = llBuildRgbUpload([colors], SOLID_FRAME_MS, null);
	sent[group.key] = {
		signature,
		at: now,
		count: (last ? last.count : 0) + 1,
		color: colors[0],
		effect: upload.effectIndex,
		changedAt: changed ? now : last.changedAt,
		landed: changed ? false : last.landed,
		sends: changed ? 1 : last.sends + 1,
	};
	// Animations replace each upload right away, so only a color that stays put gets the slower, surer form.
	safely(() => sendUpload(group, upload, unconfirmed));
	return true;
}

function sendAllOnce(color) {
	for (const group of groupList()) {
		const [a, b] = layout.ranges[group.key];
		safely(() => sendUpload(group, llBuildRgbUpload([grabColors(a, b, color)], SOLID_FRAME_MS, null)));
	}
}

// A retry repeats each frame with gaps between, because a repeat sent straight away is lost along with the first.
function sendUpload(group, upload, sure = false) {
	for (let index = 0; index < upload.packetCount; index++) {
		const rf = llRgbPacket(upload, group.macBytes, llsRoster.masterBytes, index);
		if (sure && index === 1) {
			device.pause(RETRY_GAP_MS);
		}
		sendRf(rf, group.ch, group.rx);
		if (sure) {
			for (let repeat = 1; repeat < RETRY_REPEATS; repeat++) {
				device.pause(RETRY_GAP_MS);
				sendRf(rf, group.ch, group.rx);
			}
		} else if (index === 0) {
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
// goes back at 60% instead. A pump whose speed isn't plausible goes back to full speed, and one
// never goes back below its floor, so a floor of 100% holds after SignalRGB closes too.
function handBack(group, rec) {
	if (!rec) {
		return null;
	}
	if (group.kind === "pump") {
		const shape = pumpShape(group);
		return rec.pumpRpm >= LLS_PUMP_MIN_SAFE_RPM ? Math.max(rec.pumpRpm, llPumpRpmFromLevel(fanFloor(group), shape)) : LL_PUMP_RANGE[shape][1];
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

// Logs how long a new color took to reach each device, going by what the device reports.
function logLanding(now) {
	for (const group of groupList()) {
		const out = sent[group.key];
		if (!out || out.landed) {
			continue;
		}
		const rec = recordFor(group);
		if (rec && !rec.stale && sameEffect(rec, { effectIndex: out.effect })) {
			out.landed = true;
			llsLog(`Landed ${group.label}: ${now - out.changedAt} ms, ${out.sends} uploads.`);
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
