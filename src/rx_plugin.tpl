// Lian Li wireless monitor for SignalRGB (RX dongle). Read-only, no LEDs.
// Reads the device list and shares it with the wireless plugin over 127.0.0.1,
// so it can find the devices and watch fan and pump speeds.
//
// Built on ShkourBashtawi/SignalRGB-HydroShift-II-TL-Wireless (MIT), which ports
// sgtaziz/lian-li-linux (MIT). Not affiliated with Lian Li.

export function Name() { return "Lian Li Wireless Monitor"; }
export function VendorId() { return 0x0416; }
export function ProductId() { return 0x8041; }
export function Publisher() { return "Community"; }
export function Documentation() { return ""; }
export function Type() { return "rawusb"; }
export function ImageUrl() { return "https://raw.githubusercontent.com/iamjosssssh/signalrgb-lian-li-rgbandlcd-for-hydroshiftaio-uni-TL-fans/main/assets/devices/lian-li-dongle.png"; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 1.0; }
export function ConflictingProcesses() { return ["L-Connect 3.exe", "L-Connect-Service.exe"]; }
export function ControllableParameters() { return []; }
export function LedNames() { return []; }
export function LedPositions() { return []; }

import udp from "@SignalRGB/udp";

//@@CORE@@

//@@GUARD@@

const POLL_MS = 250;
const STATUS_MS = 60000;
const MONITOR_PORT = 51871;
// A device sometimes misses one reply (radio noise), so remember it for a while.
const REMEMBER_MS = 15000;

let lastPoll = 0;
let lastStatus = 0;
let missed = 0;
let socket = null;
let seen = new Map();

export function Validate(endpoint) {
	return endpoint.interface === 0;
}

export function Initialize() {
	llsLog("Monitor started.");
	poll();
}

export function Render() {
	if (Date.now() - lastPoll >= POLL_MS) {
		poll();
	}
}

export function Shutdown() {
	try {
		if (socket) {
			socket.close();
		}
	} catch (e) { /* ignore */ }
	socket = null;
}

function poll() {
	lastPoll = Date.now();
	let records = null;
	try {
		records = getDevices();
	} catch (e) {
		llsLog(`Device list failed: ${e}`);
	}
	if (!records) {
		missed++;
		if (missed === 3) {
			llsLog("The RX did not answer. L-Connect probably still owns the dongle.");
			llsMessage("lls_rx", "RX dongle gave no reply", "L-Connect probably still owns the dongle.");
		}
		return;
	}
	missed = 0;
	llsClearMessage("lls_rx");
	records = remember(records, lastPoll);
	share(records);
	if (lastPoll - lastStatus >= STATUS_MS) {
		lastStatus = lastPoll;
		for (const r of records) {
			llsLog(`${llMacToString(r.mac)} type ${r.deviceType} fan types ${r.fanTypes.join(",")} rx ${r.rxType} ch ${r.channel} fans ${r.fanCount} rpm ${r.fanRpm.join("/")} duty ${r.currentPwm.join("/")} coolant ${r.coolantC}`);
		}
	}
}

function getDevices() {
	const packet = new Array(64).fill(0);
	packet[0] = LL_USB_CMD_SEND_RF;
	packet[1] = 1; // one page = up to 10 devices
	llsAssertGetDev(packet);
	llsWrite(packet);

	let resp = [];
	for (let i = 0; i < 40; i++) {
		const chunk = llsRead(i === 0 ? 300 : 50);
		if (!chunk.length) {
			break;
		}
		if (!resp.length && chunk[0] !== LL_USB_CMD_SEND_RF) {
			continue; // stale packet from an earlier request
		}
		resp = resp.concat(chunk);
		if (resp.length >= 4 + Math.min(resp[1], 10) * 42) {
			break;
		}
	}
	return llParseGetDev(resp);
}

// Fresh records plus those missing for less than REMEMBER_MS, marked stale.
function remember(records, now) {
	const fresh = new Map(records.map((r) => [llMacToString(r.mac), r]));
	for (const [mac, r] of fresh) {
		seen.set(mac, { rec: r, at: now });
	}
	const out = [];
	for (const [mac, entry] of seen) {
		if (fresh.has(mac)) {
			out.push(fresh.get(mac));
		} else if (now - entry.at > REMEMBER_MS) {
			seen.delete(mac);
		} else {
			out.push(Object.assign({}, entry.rec, { stale: true }));
		}
	}
	return out;
}

function share(records) {
	try {
		if (!socket) {
			socket = udp.createSocket();
			socket.on("error", () => {});
		}
		socket.write(JSON.stringify({
			kind: "lls-monitor",
			t: Date.now(),
			devices: records.filter((r) => !r.isMaster).map((r) => ({
				mac: llMacToString(r.mac),
				master: llMacToString(r.masterMac),
				type: r.deviceType,
				rx: r.rxType,
				ch: r.channel,
				fans: r.fanCount,
				fanTypes: r.fanTypes,
				right: r.rightAttach,
				rpm: r.fanRpm,
				pumpRpm: r.fanRpm[3],
				pwm: r.currentPwm,
				coolant: r.coolantC,
				fx: Array.from(r.effectIndex || []),
				stale: !!r.stale,
			})),
		}), "127.0.0.1", MONITOR_PORT);
	} catch (e) {
		socket = null;
	}
}
