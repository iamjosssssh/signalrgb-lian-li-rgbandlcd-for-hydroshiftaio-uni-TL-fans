// Lian Li HydroShift II LCD-S and LCD-C pump screens for SignalRGB. USB 1CBE:A034 and 1CBE:A021.
// Shows whatever SignalRGB's LCD page is set to. The pump ring and speed are left alone: the ring
// is lit over the wireless link. Init sequence as tested on this model by
// KnxckbackWili/signalrgb-hydroshift-ii-s (MIT). Community plugin, not affiliated with Lian Li.
import LCD from "@SignalRGB/lcd";

export function Name() { return "Lian Li HydroShift II LCD"; }
export function VendorId() { return 0x1CBE; }
export function ProductId() { return [0xA021, 0xA034]; }
export function Publisher() { return "Community"; }
export function Documentation() { return ""; }
export function Size() { return [1, 1]; }
// One canvas unit is 3 mm, and this screen is about 73 mm across.
export function DefaultPosition() { return [10, 10]; }
export function DefaultScale() { return 24.0; }
export function DeviceType() { return "lcd"; }
export function Type() { return "rawusb"; }
export function ImageUrl() { return "https://raw.githubusercontent.com/iamjosssssh/signalrgb-lian-li-rgbandlcd-for-hydroshiftaio-uni-TL-fans/main/assets/devices/hydroshift-lcd.png"; }
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

export function Initialize() {
	lcdStart();
	lcdCommand(LCD_CMD_STOP_PLAY);
	lcdCommand(LCD_CMD_STOP_CLOCK);
	lcdLog(`Pump screen firmware: ${lcdFirmware(lcdCommand(LCD_CMD_GET_VER))}.`);
	// The backlight stays full, and the LCD tab's brightness slider dims the picture itself.
	lcdCommand(LCD_CMD_BRIGHTNESS, [100]);
}

export function Render() {
	lcdRender();
}

// The screen keeps its last frame.
export function Shutdown() {}

export function onJpegQualityChanged() { lcdQuality = Number(JpegQuality) || 80; }
