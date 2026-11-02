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
const LL_RF_SEND_PIC = 0x22;
const LL_PIC_CHUNK_BYTES = 220;
const LL_MAX_AIO_IMAGE_BYTES = 20480;
const LL_RF_AIO_SWITCH_WIRELESS = 0x19;
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

// Switches the LCD to the built-in sensor theme. The AIO acknowledges by
// reporting `sequence` as its cmd_seq (record byte 40) in the RX device list.
function llThemeSwitchFrame(mac, master, rxSlot, masterChannel, slotIndex, sequence) {
	const rf = llAioHeader(LL_RF_AIO_SWITCH_WIRELESS, mac, master, rxSlot, masterChannel, slotIndex);
	rf[17] = sequence & 0xff;
	return rf;
}

function llNextSequence(previous, observed) {
	const v = previous === null || previous === undefined ? observed : previous;
	return v <= 253 ? v + 1 : 1;
}

// Slot index = 1-based position among the devices bound to this TX master
// (the RX list order, master entry excluded), as lian-li-linux next_slot_index.
function llSlotIndex(records, mac, masterMac) {
	let slot = 1;
	for (const r of records) {
		if (r.isMaster || !r.masterMac.every((b, k) => b === masterMac[k])) {
			continue;
		}
		if (r.mac.every((b, k) => b === mac[k])) {
			return slot;
		}
		slot++;
	}
	return slot;
}

// Sensor packet from the helper: {"cpu_temp":51,"cpu_load":12,"gpu_temp":44,"gpu_load":3}
// Missing / null / out-of-range fields mean "not available".
function llParseSensorMessage(text) {
	let j;
	try {
		j = JSON.parse(text);
	} catch (e) {
		return null;
	}
	if (!j || typeof j !== "object") {
		return null;
	}
	const pick = (k) => {
		const v = j[k];
		return typeof v === "number" && isFinite(v) && v >= 0 && v <= 150 ? v : null;
	};
	return {
		cpuTemp: pick("cpu_temp"),
		cpuLoad: pick("cpu_load"),
		gpuTemp: pick("gpu_temp"),
		gpuLoad: pick("gpu_load"),
		source: typeof j.source === "string" ? j.source.slice(0, 40) : "",
	};
}

// Finder -> TX plugin status packet (local UDP). Carries what only the RX can see.
function llParseFinderMessage(text) {
	let j;
	try {
		j = JSON.parse(text);
	} catch (e) {
		return null;
	}
	if (!j || j.kind !== "finder" || !Array.isArray(j.devices)) {
		return null;
	}
	return j;
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

// Pump RPM <-> SignalRGB 0..1 fan level, inside the variant's range.
function llPumpRpmFromLevel(level, shape) {
	const [lo, hi] = LL_PUMP_RANGE[shape === "circle" ? "circle" : "square"];
	const l = Math.min(Math.max(typeof level === "number" && isFinite(level) ? level : 1, 0), 1);
	return Math.round(lo + l * (hi - lo));
}

// ------------------------------ LCD picture ----------------------------------
// RF_SEND_PIC (0x22): a JPEG (480x480, at most 20 KB) in 220-byte chunks, then a
// terminator (index 0xFF) carrying the total length. Every frame carries a fresh
// sequence number and must be acknowledged (AIO cmd_seq) before the next one.
// Ported from lian-li-linux wireless/opcodes.rs (picture_packets, send_aio_pic).

function llPicFrame(mac, master, rxSlot, masterChannel, sequence, index, data) {
	if (data.length > LL_PIC_CHUNK_BYTES) {
		throw new Error("picture chunk exceeds 220 bytes");
	}
	const rf = llAioHeader(LL_RF_SEND_PIC, mac, master, rxSlot, masterChannel, 0);
	rf[17] = sequence & 0xff;
	rf[18] = index & 0xff;
	for (let k = 0; k < data.length; k++) {
		rf[19 + k] = data[k] & 0xff;
	}
	return rf;
}

// [{index, data}] for every chunk plus the terminator.
function llPicChunks(jpeg) {
	if (!jpeg || jpeg.length < 1 || jpeg.length > LL_MAX_AIO_IMAGE_BYTES) {
		throw new Error(`LCD image must be 1..${LL_MAX_AIO_IMAGE_BYTES} bytes`);
	}
	const out = [];
	for (let i = 0; i * LL_PIC_CHUNK_BYTES < jpeg.length; i++) {
		out.push({ index: i, data: jpeg.slice(i * LL_PIC_CHUNK_BYTES, (i + 1) * LL_PIC_CHUNK_BYTES) });
	}
	out.push({ index: 0xff, data: [(jpeg.length >> 8) & 0xff, jpeg.length & 0xff] });
	return out;
}

function llToBase64(bytes) {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
		out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
	}
	return out;
}

function llFromBase64(text) {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const out = [];
	const clean = String(text || "").replace(/[^A-Za-z0-9+/]/g, "");
	for (let i = 0; i < clean.length; i += 4) {
		const n = (abc.indexOf(clean[i]) << 18) | (abc.indexOf(clean[i + 1]) << 12) | ((abc.indexOf(clean[i + 2]) & 63) << 6) | (abc.indexOf(clean[i + 3]) & 63);
		out.push((n >> 16) & 255);
		if (i + 2 < clean.length) out.push((n >> 8) & 255);
		if (i + 3 < clean.length) out.push(n & 255);
	}
	return out;
}

// ------------------------- SignalRGB glue helpers --------------------------

function llLog(msg) {
	try {
		device.log(`[LianLi] ${msg}`, {toFile: true});
	} catch (e) {
		device.log(`[LianLi] ${msg}`);
	}
}

// SignalRGB rawusb bulk_transfer returns {length, data}; length < 0 = failure.
function llToArray(r) {
	if (r === undefined || r === null) {
		return [];
	}
	if (Array.isArray(r)) {
		return r;
	}
	if (typeof r === "object") {
		const n = typeof r.length === "number" ? r.length : -1;
		if (n <= 0) {
			return [];
		}
		const d = r.data;
		if (d && typeof d.length === "number") {
			return Array.from(d).slice(0, n).map((b) => b & 0xff);
		}
		return Array.from(r).slice(0, n);
	}
	return [];
}

// IN transfers need a pre-sized buffer, one 64-byte USB packet at a time.
function llBulkRead(timeoutMs) {
	return llToArray(device.bulk_transfer(0x81, new Array(64).fill(0), 64, timeoutMs));
}

function llBulkWrite(packet) {
	device.bulk_transfer(0x01, packet, packet.length, 100);
}

function llFlushIn() {
	for (let i = 0; i < 16; i++) {
		if (!llBulkRead(5).length) {
			return;
		}
	}
}

function llHex(a) {
	return (a || []).slice(0, 64).map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(" ");
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

if (typeof module !== "undefined") {
	module.exports = {
		tuzCompress,
		llParseMac,
		llMacToString,
		llRfToUsbPackets,
		llBuildClockFrame,
		llGetMacPacket,
		llValidMasterResponse,
		llChannelProbeOrder,
		llBuildRgbUpload,
		llRgbPacket,
		llParseDeviceRecord,
		llParseGetDev,
		llBuildLayout,
		llFanFamily,
		llGapBefore,
		llSquarePumpTimer,
		llCirclePumpTimer,
		llPumpTimer,
		llBuildAioParam,
		llAioParamsFrame,
		llThemeSwitchFrame,
		llNextSequence,
		llSlotIndex,
		llParseSensorMessage,
		llParseFinderMessage,
		llMinDutyPercent,
		llPreparePwm,
		llPwmFrame,
		llPumpRpmFromLevel,
		llPicFrame,
		llPicChunks,
		llToBase64,
		llFromBase64,
		llU16BE,
		llU32BE,
		llBuildRgbUploadTicks,
		llDeviceTypeName,
		llF32Curve,
		llAioHeader,
		llIsClFan,
		llSmoothPwm,
		llSafeHandBack,
		llLog,
		llToArray,
		llBulkRead,
		llBulkWrite,
		llFlushIn,
		llHex,
		llHsvToRgb,
		llScale,
		llEffectPeriod,
		llEffectColor,
		llEffectPlan,
		llEffectFrames,
		llBuildRgbUploadFrac,
		llFitAnimation,
		llLoopFrames,
		llEffectUpload,
		LL_USB_CMD_SEND_RF,
		LL_USB_CMD_GET_MAC,
		LL_RF_SELECT,
		LL_RF_CLOCK_SYNC,
		LL_RF_SET_RGB,
		LL_RF_PWM_CMD,
		LL_RF_SEND_PIC,
		LL_PIC_CHUNK_BYTES,
		LL_MAX_AIO_IMAGE_BYTES,
		LL_RF_AIO_SWITCH_WIRELESS,
		LL_RF_AIO_PARAMS,
		LL_AIO_PARAM_LEN,
		LL_RF_DATA_SIZE,
		LL_RF_CHUNK_SIZE,
		LL_RF_CHUNKS,
		LL_RGB_CHUNK_BYTES,
		LL_MAX_COMPRESSED_BYTES,
		LL_LEDS_PER_RING,
		LL_PUMP_RANGE,
		LL_PWM_FOLLOW_MB,
		LL_HW_FRAME_MS,
		LL_HW_MAX_FRAMES,
		LL_HW_EFFECTS,
	};
}
