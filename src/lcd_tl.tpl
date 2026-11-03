// Lian Li UNI FAN TL and SL V3 Wireless LCD screens for SignalRGB. USB 1CBE:0006 and 1CBE:0005.
// Shows whatever SignalRGB's LCD page is set to. Community plugin, not affiliated with Lian Li.
import LCD from "@SignalRGB/lcd";
import udp from "@SignalRGB/udp";

export function Name() { return "Lian Li Wireless LCD Fan"; }
export function VendorId() { return 0x1CBE; }
export function ProductId() { return [0x0005, 0x0006]; }
export function Publisher() { return "Community"; }
export function Documentation() { return ""; }
export function Size() { return [1, 1]; }
// One canvas unit is 3 mm, and this screen is about 54 mm across.
export function DefaultPosition() { return [10, 10]; }
export function DefaultScale() { return 18.0; }
export function DeviceType() { return "lcd"; }
export function Type() { return "rawusb"; }
export function ImageUrl() { return "https://assets.signalrgb.com/devices/brands/lian-li/fans/tl-lcd-fan.png"; }
export function ConflictingProcesses() { return ["L-Connect 3.exe", "L-Connect-Service.exe"]; }
export function Validate(endpoint) { return endpoint.interface === 0; }

/* global
JpegQuality:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"JpegQuality", "group":"", "label":"Picture Quality", "description":"Higher looks better and uses more CPU. Everything else is on the LCD tab.", "type":"number", "min":"30", "max":"95", "step":"5", "default":"80"},
	];
}

//@@LCD_CORE@@

const LCD_WIDTH = 400;
const LCD_HEIGHT = 400;
const LCD_BLANK_JPEG = "@@BLANK_400@@";
const LCD_PLAIN_BYTES = 504;
const LCD_TRAILER = [];
const LCD_CMD_FRAME_RATE = 0x0F;
const LCD_ALLOWED = [LCD_CMD_GET_VER, LCD_CMD_BRIGHTNESS, LCD_CMD_FRAME_RATE, LCD_CMD_PUSH_JPG];
// The firmware expects a fixed-size transfer per frame: 512-byte header plus up to this much JPEG.
const LCD_MAX_JPEG = 101888;
const TL_FRAME_BYTES = 102400;
const TL_FIRMWARE_FRAME_RATE = 120;
// Maps 0-100 to what this firmware expects. Values from lian-li-linux.
const TL_BRIGHTNESS = [[0, 0], [25, 10], [50, 30], [75, 40], [100, 100]];

const TL_BRIDGE_PORT = 51872;
const TL_BRIDGE_CHUNK = 48000;
const TL_RELAY_PORT = 51873;
const TL_BRIDGE_GONE_MS = 5000;

const tlPacket = new Array(TL_FRAME_BYTES).fill(0);
let tlLastLength = 512;
let tlNative = false;
let tlSocket = null;
let tlFrameId = 0;
let tlRelay = null;
let tlHelloAt = 0;
let tlRelayPart = null;
let tlRelayJpeg = "";
let tlRelayBrightness = -1;
let tlRelayed = 0;
let tlWasOnBridge = false;

function tlBrightness(percent) {
	const v = Math.max(0, Math.min(100, Number(percent)));
	for (let i = 1; i < TL_BRIGHTNESS.length; i++) {
		const [loIn, loOut] = TL_BRIGHTNESS[i - 1];
		const [hiIn, hiOut] = TL_BRIGHTNESS[i];
		if (v <= hiIn) {
			return Math.round(loOut + ((v - loIn) * (hiOut - loOut)) / (hiIn - loIn));
		}
	}
	return 100;
}

// SignalRGB opens a raw USB handle on only one of several identical devices, and gives it to
// whichever instance of this plugin wins a startup race, so it may not match this instance's screen.
// So every instance sends its frames to the bridge program over 127.0.0.1, labelled with its serial.
// The bridge writes them through WinUSB, except for the one screen SignalRGB holds: those frames
// come back here to the instance with the handle. Without the bridge running, that instance shows
// its own frames.
function tlSerial() {
	return String(device.Uid).split(":").pop();
}

function tlBase64(bytes) {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const out = [];
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
		out.push(abc[(n >> 18) & 63], abc[(n >> 12) & 63], i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=", i + 2 < bytes.length ? abc[n & 63] : "=");
	}
	return out.join("");
}

function tlBridgeSend(text) {
	if (!tlSocket) {
		tlSocket = udp.createSocket();
		tlSocket.on("error", (e) => lcdLog(`Bridge socket error: ${e}`));
	}
	tlSocket.write(text, "127.0.0.1", TL_BRIDGE_PORT);
}

function tlBridgeFrame(jpeg) {
	const encoded = tlBase64(jpeg);
	tlFrameId = (tlFrameId + 1) % 100000;
	const count = Math.ceil(encoded.length / TL_BRIDGE_CHUNK);
	for (let i = 0; i < count; i++) {
		tlBridgeSend(`LLB1|${tlSerial()}|${tlFrameId}|${i}|${count}|${encoded.slice(i * TL_BRIDGE_CHUNK, (i + 1) * TL_BRIDGE_CHUNK)}`);
	}
	return true;
}

function tlBridgeRunning() {
	return tlHelloAt > 0 && Date.now() - tlHelloAt < TL_BRIDGE_GONE_MS;
}

function tlOnRelay(msg) {
	const text = typeof msg === "string" ? msg : (msg && typeof msg.data === "string" ? msg.data : "");
	const p = text.split("|");
	if (p[0] !== "LLB1") {
		return;
	}
	if (p[1] === "hello") {
		tlHelloAt = Date.now();
	} else if (p[2] === "B") {
		tlRelayBrightness = Number(p[3]);
	} else if (p.length === 6) {
		if (!tlRelayPart || tlRelayPart.frame !== p[2]) {
			tlRelayPart = { frame: p[2], chunks: new Array(Number(p[4])).fill(""), left: Number(p[4]) };
		}
		const at = Number(p[3]);
		if (at >= 0 && at < tlRelayPart.chunks.length && !tlRelayPart.chunks[at]) {
			tlRelayPart.chunks[at] = p[5];
			tlRelayPart.left--;
		}
		if (tlRelayPart.left === 0) {
			tlRelayJpeg = tlRelayPart.chunks.join("");
			tlRelayPart = null;
		}
	}
}

function tlOpenRelay() {
	try {
		tlRelay = udp.createSocket();
		tlRelay.on("message", tlOnRelay);
		tlRelay.on("error", (e) => lcdLog(`Relay socket error: ${e}`));
		tlRelay.bind(TL_RELAY_PORT);
	} catch (e) {
		tlRelay = null;
		lcdLog(`Could not open UDP port ${TL_RELAY_PORT}: ${e}`);
	}
}

// Writes what the bridge couldn't reach itself to the screen this instance has the handle for.
function tlWriteRelayed() {
	if (tlRelayBrightness >= 0) {
		lcdCommand(LCD_CMD_BRIGHTNESS, [tlBrightness(tlRelayBrightness)]);
		tlRelayBrightness = -1;
	}
	if (tlRelayJpeg) {
		const jpeg = lcdFromBase64(tlRelayJpeg);
		tlRelayJpeg = "";
		if (jpeg.length <= LCD_MAX_JPEG && jpeg[0] === 0xFF && jpeg[1] === 0xD8) {
			tlWriteUsb(jpeg);
			if (++tlRelayed === 1) {
				lcdLog(`Showing relayed frames on the held screen, ${jpeg.length} bytes.`);
			}
		}
	}
}

function lcdSendFrame(jpeg) {
	if (!tlNative || tlBridgeRunning()) {
		return tlBridgeFrame(jpeg);
	}
	return tlWriteUsb(jpeg);
}

function tlWriteUsb(jpeg) {
	const n = jpeg.length;
	const header = lcdHeader(LCD_CMD_PUSH_JPG, [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
	for (let i = 0; i < 512; i++) {
		tlPacket[i] = header[i];
	}
	for (let i = 0; i < n; i++) {
		tlPacket[512 + i] = jpeg[i];
	}
	for (let i = 512 + n; i < tlLastLength; i++) {
		tlPacket[i] = 0;
	}
	tlLastLength = 512 + n;
	if (!lcdWrite(tlPacket, TL_FRAME_BYTES)) {
		return false;
	}
	lcdRead();
	return true;
}

// The backlight stays full, and the LCD tab's brightness slider dims the picture itself.
function tlApplyBrightness() {
	if (tlNative && !tlBridgeRunning()) {
		lcdCommand(LCD_CMD_BRIGHTNESS, [tlBrightness(100)]);
	}
	tlBridgeSend(`LLB1|${tlSerial()}|B|100`);
}

export function Initialize() {
	lcdStart();
	device.setName(`Lian Li ${device.productId() === 0x0005 ? "SL" : "TL"} LCD ${tlSerial().slice(0, 4)}`);
	lcdCommand(LCD_CMD_FRAME_RATE, [TL_FIRMWARE_FRAME_RATE]);
	tlNative = lcdLastWriteOk;
	if (tlNative) {
		lcdLog(`TL screen firmware: ${lcdFirmware(lcdCommand(LCD_CMD_GET_VER))}. Instance ${tlSerial()} has the USB handle.`);
		tlOpenRelay();
	} else {
		lcdLog(`No raw USB handle for instance ${tlSerial()}. Using the bridge program.`);
	}
	tlApplyBrightness();
}

export function Render() {
	if (tlNative) {
		tlWriteRelayed();
	}
	// A new route has never seen the picture, so it shouldn't wait for the next resend.
	const onBridge = tlBridgeRunning();
	if (onBridge !== tlWasOnBridge) {
		tlWasOnBridge = onBridge;
		lcdLastJpeg = null;
	}
	lcdRender();
}

// The screen keeps its last frame.
export function Shutdown() {
	for (const socket of [tlSocket, tlRelay]) {
		if (socket) {
			socket.close();
		}
	}
	tlSocket = null;
	tlRelay = null;
}

export function onJpegQualityChanged() { lcdQuality = Number(JpegQuality) || 80; }
