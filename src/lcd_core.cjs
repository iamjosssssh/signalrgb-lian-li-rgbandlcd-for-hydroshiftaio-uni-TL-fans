// ---------------------------------------------------------------------------
// Shared by the Lian Li screen plugins. Frames come from SignalRGB's LCD system.
//
// Each screen command is a 512-byte DES-encrypted header, and a frame is that
// header followed by a plain JPEG. Only commands in LCD_ALLOWED can be built, so
// the startup image (flash), reboot and desktop-mode commands can't be sent.
// Protocol from sgtaziz/lian-li-linux (MIT). Not affiliated with Lian Li.
// ---------------------------------------------------------------------------

const LCD_KEY = [115, 108, 118, 51, 116, 117, 122, 120]; // ASCII "slv3tuzx", also the IV
const LCD_CMD_GET_VER = 0x0A;
const LCD_CMD_BRIGHTNESS = 0x0E;
const LCD_CMD_PUSH_JPG = 0x65;
// A short timeout cancels a transfer mid-packet, which can wedge the screen until a power cycle.
const LCD_WRITE_TIMEOUT_MS = 2000;
const LCD_READ_TIMEOUT_MS = 100;
const LCD_FAILS_BEFORE_PAUSE = 3;
const LCD_PAUSE_MS = 10000;
const LCD_MIN_QUALITY = 30;
// SignalRGB's LCD page chooses what gets drawn, its brightness and its render rate. This is only how
// often a finished frame is collected. An unchanged frame still goes out now and then, in case the
// screen lost power or the bridge restarted.
const LCD_FRAME_RATE = 30;
const LCD_RESEND_MS = 2000;
const LCD_FACE_SCAN_WAIT_MS = 30000;

const DES_IP = [
	58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
	62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
	57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
	61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const DES_P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const DES_PC1 = [
	57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
	63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const DES_PC2 = [
	14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
	41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const DES_S = [
	[14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
	[15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
	[10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
	[7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
	[2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
	[12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
	[4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
	[13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

// Per-byte lookups for a 64-bit permutation, so a block takes 16 ORs instead of 64 bit moves.
function desByteTables(perm) {
	const tables = [];
	for (let at = 0; at < 8; at++) {
		const hi = new Array(256);
		const lo = new Array(256);
		for (let v = 0; v < 256; v++) {
			let h = 0;
			let l = 0;
			for (let out = 0; out < 64; out++) {
				const bit = perm[out] - 1;
				if ((bit >> 3) === at && (v >> (7 - (bit & 7))) & 1) {
					if (out < 32) {
						h |= 1 << (31 - out);
					} else {
						l |= 1 << (63 - out);
					}
				}
			}
			hi[v] = h;
			lo[v] = l;
		}
		tables.push({ hi, lo });
	}
	return tables;
}

function desInverse(perm) {
	const out = new Array(64);
	perm.forEach((from, to) => { out[from - 1] = to + 1; });
	return out;
}

// S-box then P permutation for every 6-bit input of each round's eight groups.
function desSpTables() {
	return DES_S.map((box, s) => {
		const table = new Array(64);
		for (let v = 0; v < 64; v++) {
			const row = ((v >> 4) & 2) | (v & 1);
			const col = (v >> 1) & 15;
			const word = box[row * 16 + col] << (28 - 4 * s);
			let out = 0;
			for (let i = 0; i < 32; i++) {
				if ((word >>> (32 - DES_P[i])) & 1) {
					out |= 1 << (31 - i);
				}
			}
			table[v] = out;
		}
		return table;
	});
}

const DES_IP_TABLES = desByteTables(DES_IP);
const DES_FP_TABLES = desByteTables(desInverse(DES_IP));
const DES_SP = desSpTables();

function desSubkeys(key) {
	const bits = [];
	for (let i = 0; i < 64; i++) {
		bits.push((key[i >> 3] >> (7 - (i & 7))) & 1);
	}
	const cd = DES_PC1.map((p) => bits[p - 1]);
	let c = cd.slice(0, 28);
	let d = cd.slice(28);
	return DES_SHIFTS.map((shift) => {
		c = c.slice(shift).concat(c.slice(0, shift));
		d = d.slice(shift).concat(d.slice(0, shift));
		const joined = c.concat(d);
		const round = DES_PC2.map((p) => joined[p - 1]);
		const groups = new Array(8);
		for (let s = 0; s < 8; s++) {
			groups[s] = (round[6 * s] << 5) | (round[6 * s + 1] << 4) | (round[6 * s + 2] << 3) | (round[6 * s + 3] << 2) | (round[6 * s + 4] << 1) | round[6 * s + 5];
		}
		return groups;
	});
}

let desKeyCache = { id: "", subkeys: null };

function desBlock(block, subkeys) {
	let l = 0;
	let r = 0;
	for (let i = 0; i < 8; i++) {
		l |= DES_IP_TABLES[i].hi[block[i]];
		r |= DES_IP_TABLES[i].lo[block[i]];
	}
	for (let round = 0; round < 16; round++) {
		const k = subkeys[round];
		let f = 0;
		for (let s = 0; s < 8; s++) {
			// Each group is six bits of R, overlapping its neighbours: the E expansion.
			const shift = (4 * s + 31) % 32;
			const rotated = shift ? (r << shift) | (r >>> (32 - shift)) : r;
			f |= DES_SP[s][(rotated >>> 26) ^ k[s]];
		}
		const next = l ^ f;
		l = r;
		r = next;
	}
	const pre = [r >>> 24, (r >>> 16) & 255, (r >>> 8) & 255, r & 255, l >>> 24, (l >>> 16) & 255, (l >>> 8) & 255, l & 255];
	let hi = 0;
	let lo = 0;
	for (let i = 0; i < 8; i++) {
		hi |= DES_FP_TABLES[i].hi[pre[i]];
		lo |= DES_FP_TABLES[i].lo[pre[i]];
	}
	return [hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255];
}

// DES-CBC with PKCS#7 padding.
function desCbcEncrypt(data, key, iv) {
	const id = key.join();
	if (desKeyCache.id !== id) {
		desKeyCache = { id, subkeys: desSubkeys(key) };
	}
	const pad = 8 - (data.length % 8);
	const out = [];
	let chain = iv;
	for (let at = 0; at < data.length + pad; at += 8) {
		const block = new Array(8);
		for (let i = 0; i < 8; i++) {
			const byte = at + i < data.length ? data[at + i] : pad;
			block[i] = byte ^ chain[i];
		}
		chain = desBlock(block, desKeyCache.subkeys);
		for (let i = 0; i < 8; i++) {
			out.push(chain[i]);
		}
	}
	return out;
}

let lcdEpoch = Date.now();
let lcdStamp = 0;

function lcdHeader(command, params = []) {
	if (!LCD_ALLOWED.includes(command)) {
		throw new Error(`guard: screen command 0x${command.toString(16)} is not allowed`);
	}
	const plain = new Array(LCD_PLAIN_BYTES).fill(0);
	plain[0] = command;
	plain[2] = 0x1A;
	plain[3] = 0x6D;
	lcdStamp = Math.max(Date.now() - lcdEpoch, lcdStamp + 1);
	plain[4] = lcdStamp & 255;
	plain[5] = (lcdStamp >>> 8) & 255;
	plain[6] = (lcdStamp >>> 16) & 255;
	plain[7] = (lcdStamp >>> 24) & 255;
	params.forEach((v, i) => { plain[8 + i] = v; });
	return desCbcEncrypt(plain, LCD_KEY, LCD_KEY).concat(LCD_TRAILER);
}

let lcdLastWrite = "";
let lcdLastWriteOk = false;

function lcdWrite(packet, length) {
	const r = device.bulk_transfer(0x01, packet, length, LCD_WRITE_TIMEOUT_MS);
	lcdLastWrite = r ? `${r.length} of ${length}` : "no result";
	lcdLastWriteOk = !!r && r.length === length;
	return lcdLastWriteOk;
}

function lcdRead() {
	const r = device.bulk_transfer(0x81, new Array(512).fill(0), 512, LCD_READ_TIMEOUT_MS);
	return r && r.length > 0 && r.data ? r.data : null;
}

function lcdReadReply(command, tries) {
	for (let i = 0; i < tries; i++) {
		const reply = lcdRead();
		if (reply && reply[0] === command) {
			return reply;
		}
		device.pause(1);
	}
	return null;
}

function lcdCommand(command, params = []) {
	const header = lcdHeader(command, params);
	if (!lcdWrite(header, header.length)) {
		return null;
	}
	return lcdReadReply(command, 16);
}

function lcdLog(msg) {
	device.log(`[LianLiLCD] ${msg}`, {toFile: true});
}

let lcdQuality = 80;
let lcdLastFrame = 0;
let lcdPausedUntil = 0;
let lcdFails = 0;
let lcdSent = 0;
let lcdLastJpeg = null;
let lcdLastSentAt = 0;
let lcdStartedAt = 0;
let lcdJoined = false;

function lcdStart() {
	lcdStartedAt = Date.now();
	lcdQuality = Number(JpegQuality) || 80;
	device.setFrameRateTarget(LCD_FRAME_RATE);
}

// SignalRGB looks up a screen's saved face when LCD.initialize runs. If it hasn't scanned its face
// list yet, which takes about 10 seconds after it starts, it resets the screen to the default face
// for good. So the screen joins after the scan, and keeps showing its last picture until then.
function lcdJoinWhenFacesReady(now) {
	if (lcdJoined) {
		return true;
	}
	if (now - lcdStartedAt < LCD_FACE_SCAN_WAIT_MS) {
		return false;
	}
	LCD.initialize({ width: LCD_WIDTH, height: LCD_HEIGHT });
	lcdJoined = true;
	return true;
}

function lcdSameAsLast(jpeg) {
	if (!lcdLastJpeg || lcdLastJpeg.length !== jpeg.length) {
		return false;
	}
	for (let i = 0; i < jpeg.length; i++) {
		if (lcdLastJpeg[i] !== jpeg[i]) {
			return false;
		}
	}
	return true;
}

function lcdFirmware(reply) {
	if (!reply) {
		return "unknown";
	}
	const text = [];
	for (let i = 8; i < reply.length && reply[i] !== 0 && i < 40; i++) {
		text.push(String.fromCharCode(reply[i]));
	}
	return text.join("") || "unknown";
}

function lcdRender() {
	const now = Date.now();
	if (!lcdJoinWhenFacesReady(now) || now < lcdPausedUntil || now - lcdLastFrame < 1000 / LCD_FRAME_RATE) {
		return;
	}
	lcdLastFrame = now;
	const jpeg = LCD.getFrame({ format: "JPEG", quality: lcdQuality });
	if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) {
		return;
	}
	if (jpeg.length > LCD_MAX_JPEG) {
		lcdQuality = Math.max(LCD_MIN_QUALITY, lcdQuality - 10);
		lcdLog(`Frame of ${jpeg.length} bytes is over the ${LCD_MAX_JPEG}-byte limit. JPEG quality now ${lcdQuality}.`);
		return;
	}
	if (lcdSameAsLast(jpeg) && now - lcdLastSentAt < LCD_RESEND_MS) {
		return;
	}
	if (lcdSendFrame(jpeg)) {
		lcdLastJpeg = jpeg.slice();
		lcdLastSentAt = now;
		lcdFails = 0;
		lcdSent++;
		if (lcdSent === 1 || lcdSent % 1000 === 0) {
			lcdLog(`Frames sent: ${lcdSent}, last ${jpeg.length} bytes.`);
		}
		return;
	}
	lcdFails++;
	if (lcdFails >= LCD_FAILS_BEFORE_PAUSE) {
		lcdFails = 0;
		lcdPausedUntil = now + LCD_PAUSE_MS;
		lcdLog(`Screen stopped answering (last write: ${lcdLastWrite}). Trying again in ${LCD_PAUSE_MS / 1000} s.`);
	}
}
