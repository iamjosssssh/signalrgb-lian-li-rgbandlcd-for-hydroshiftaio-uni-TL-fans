// Lian Li HydroShift II LCD-S pump screen for SignalRGB. USB 1CBE:A034.
// Shows whatever SignalRGB's LCD page is set to. The pump ring and speed are left alone: the ring
// is lit over the wireless link. Init sequence as tested on this model by
// KnxckbackWili/signalrgb-hydroshift-ii-s (MIT). Community plugin, not affiliated with Lian Li.
import LCD from "@SignalRGB/lcd";

export function Name() { return "Lian Li HydroShift II LCD"; }
export function VendorId() { return 0x1CBE; }
export function ProductId() { return 0xA034; }
export function Publisher() { return "Community"; }
export function Documentation() { return ""; }
export function Size() { return [1, 1]; }
export function DeviceType() { return "lcd"; }
export function Type() { return "rawusb"; }
export function ConflictingProcesses() { return ["L-Connect 3.exe", "L-Connect-Service.exe"]; }
export function Validate(endpoint) { return endpoint.interface === 0; }

/* global
FrameRate:readonly
JpegQuality:readonly
ScreenBrightness:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"FrameRate", "group":"", "label":"Frame Rate", "description":"Higher rates use more CPU.", "type":"combobox", "values":["5", "10", "15", "20", "30"], "default":"20"},
		{"property":"JpegQuality", "group":"", "label":"JPEG Quality", "type":"number", "min":"30", "max":"95", "step":"5", "default":"75"},
		{"property":"ScreenBrightness", "group":"", "label":"Screen Brightness", "type":"number", "min":"0", "max":"100", "step":"5", "default":"100"},
	];
}

//@@LCD_CORE@@

const LCD_WIDTH = 480;
const LCD_HEIGHT = 480;
const LCD_PLAIN_BYTES = 500;
const LCD_TRAILER = [0, 0, 0, 0, 0, 0, 0xA1, 0x1A];
const LCD_CMD_STOP_CLOCK = 0x34;
const LCD_CMD_STOP_PLAY = 0x7B;
const LCD_ALLOWED = [LCD_CMD_GET_VER, LCD_CMD_BRIGHTNESS, LCD_CMD_STOP_CLOCK, LCD_CMD_PUSH_JPG, LCD_CMD_STOP_PLAY];
const LCD_MAX_JPEG = 153600;
const H2S_ACK_TRIES = 32;

function lcdSendFrame(jpeg) {
	const n = jpeg.length;
	const packet = lcdHeader(LCD_CMD_PUSH_JPG, [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]).concat(jpeg);
	if (!lcdWrite(packet, packet.length)) {
		return false;
	}
	return !!lcdReadReply(LCD_CMD_PUSH_JPG, H2S_ACK_TRIES);
}

function h2sBrightness() {
	return Math.max(0, Math.min(100, Number(ScreenBrightness)));
}

export function Initialize() {
	lcdStart();
	lcdCommand(LCD_CMD_STOP_PLAY);
	lcdCommand(LCD_CMD_STOP_CLOCK);
	lcdLog(`Pump screen firmware: ${lcdFirmware(lcdCommand(LCD_CMD_GET_VER))}.`);
	lcdCommand(LCD_CMD_BRIGHTNESS, [h2sBrightness()]);
}

export function Render() {
	lcdRender();
}

// The screen keeps its last frame.
export function Shutdown() {}

export function onFrameRateChanged() { device.setFrameRateTarget(lcdFrameRate()); }
export function onJpegQualityChanged() { lcdQuality = Number(JpegQuality) || 75; }
export function onScreenBrightnessChanged() { lcdCommand(LCD_CMD_BRIGHTNESS, [h2sBrightness()]); }
