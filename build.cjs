// Builds dist/*.js from src/. Takes the framing, compression, fan and pump speed and stored effect
// parts of the upstream core. Its LCD theme switch and picture builders are left out on purpose.
const fs = require("fs");
const path = require("path");

const here = __dirname;
const read = (p) => fs.readFileSync(path.join(here, p), "utf8").replace(/\r\n/g, "\n");

const upstream = read("vendor/core.cjs");
const at = (marker) => {
	const i = upstream.indexOf(marker);
	if (i < 0) {
		throw new Error(`upstream core layout changed: ${marker}`);
	}
	return i;
};
const between = (from, to) => upstream.slice(at(from), at(to));
const fn = (name) => {
	const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`).exec(upstream);
	if (!m) {
		throw new Error(`upstream core layout changed: ${name}`);
	}
	return m[0];
};

const core = [
	upstream.slice(0, at("// ------------------------------ AIO LCD")),
	between("// ------------------------------ AIO LCD", "// Switches the LCD to the built-in sensor theme"),
	between("// ------------------------------ Fan speed", "// Pump RPM <->"),
	fn("llPumpRpmFromLevel"),
	between("// RF pacing:", "// --------------------------- Stored"),
	between("// --------------------------- Stored", "if (typeof module"),
].join("\n")
	.split("\n")
	.filter((line) => !/^const LL_(RF_SEND_PIC|PIC_CHUNK_BYTES|MAX_AIO_IMAGE_BYTES|RF_AIO_SWITCH_WIRELESS)\b/.test(line))
	.join("\n");
const guard = read("src/guard.cjs");
const lcdCore = read("src/lcd_core.cjs");

fs.mkdirSync(path.join(here, "dist"), { recursive: true });
const outputs = [
	["tx_plugin.tpl", "LianLi_Wireless.js"],
	["rx_plugin.tpl", "LianLi_Wireless_Monitor.js"],
	["lcd_tl.tpl", "LianLi_TL_Wireless_LCD.js"],
	["lcd_h2s.tpl", "LianLi_HydroShift_LCD.js"],
];
for (const [tpl, out] of outputs) {
	const body = read(`src/${tpl}`)
		.replace("//@@CORE@@", () => core)
		.replace("//@@GUARD@@", () => guard)
		.replace("//@@LCD_CORE@@", () => lcdCore);
	fs.writeFileSync(path.join(here, "dist", out), body);
	console.log(`built dist/${out} (${body.length} bytes)`);
}
for (const stale of ["LianLi_Wireless_Lighting.js"]) {
	fs.rmSync(path.join(here, "dist", stale), { force: true });
}
