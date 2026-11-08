// browser-tabs test: loads the real extension into Chrome for Testing (headless, throwaway profile), runs the real
// bridge on a throwaway port and token, serves the fixtures on two origins and drives the tools through a mock `pi`.
// Never touches the user's Helium or the real token, and never sends real input (PI_BROWSER_DRYRUN=1).
// run:  node test/run.mjs                       (from the extension folder)
// env:  BT_OLD_EXT=<folder of a 0.1.0 extension copy>  also tests the old-extension fallbacks
//       BT_PORT_A / BT_PORT_B (fixture ports), BT_BRIDGE_PORT (default 17437)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const AGENT = path.join(os.homedir(), ".pi", "agent");
const PI_MODULES = path.join(AGENT, "install", "releases", readFileSync(path.join(AGENT, "install", "current-version"), "utf8").trim(), "node_modules");
const CHROME_DIR = path.join(os.homedir(), ".agent-browser/browsers");
const chromeBin = path.join(CHROME_DIR, readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-")).sort().pop(), "chrome");
const A = Number(process.env.BT_PORT_A || 18961);
const B = Number(process.env.BT_PORT_B || 18962);
const BRIDGE = Number(process.env.BT_BRIDGE_PORT || 17437);
const VL = Number(process.env.BT_VL_PORT || 18963);
const TOKEN = "bt-test-token";
const tmp = mkdtempSync(path.join(os.tmpdir(), "bt-"));
writeFileSync(path.join(tmp, "token"), TOKEN);
process.env.PI_BROWSER_PORT = String(BRIDGE);
process.env.PI_BROWSER_TOKEN_FILE = path.join(tmp, "token");
process.env.PI_BROWSER_DRYRUN = "1";
process.env.PI_BROWSER_CALIBRATION = path.join(tmp, "no-calibration.json");
delete process.env.PI_BROWSER_TRUSTED;
process.env.PI_BROWSER_VL_URL = "http://127.0.0.1:9"; // unreachable until a test points it at the mock

const { createJiti } = createRequire(import.meta.url)(`${PI_MODULES}/jiti/lib/jiti.cjs`);
const jiti = createJiti(import.meta.url, { alias: { typebox: `${PI_MODULES}/typebox/build/index.mjs` } });
const { startFixtures, events } = await import(path.join(here, "fixtures/server.mjs"));
const stopSite = startFixtures(A, B);

const tools = new Map();
const handlers = {};
const pi = { registerTool: (t) => tools.set(t.name, t), on: (e, h) => (handlers[e] ??= []).push(h) };
(await jiti.import(path.join(root, "index.ts"), { default: true }))(pi);
const trusted = await jiti.import(path.join(root, "trusted.ts"));
const bridgeMod = await jiti.import(path.join(root, "bridge.ts"));

let pass = 0;
let total = 0;
const check = (n, c, x = "") => {
	total++;
	if (c) pass++;
	console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? `  (${String(x).replace(/\s+/g, " ").slice(0, 170)})` : ""}`);
};
const lat = [];
// ctx: no UI (print mode / subagent) unless a test gives one.
const noUI = { hasUI: false };
const confirms = [];
const withUI = (answer) => ({ hasUI: true, ui: { confirm: async (t, m) => (confirms.push(m), answer) } });
const call = async (name, params, ctx = noUI) => {
	const t0 = Date.now();
	try {
		const r = await tools.get(name).execute("t", params, undefined, undefined, ctx);
		const ms = Date.now() - t0;
		lat.push(ms);
		return { text: r.content.find((c) => c.type === "text")?.text ?? "", details: r.details, ms };
	} catch (e) {
		return { error: String(e.message || e), ms: Date.now() - t0 };
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (re) => events.some((e) => re.test(JSON.stringify(e)));
const ref = (text, re) => new RegExp(`\\[((?:f\\d+:)?e\\d+) ${re}`).exec(text)?.[1];

function launch(extSrc, label) {
	const ext = path.join(tmp, `ext-${label}`);
	cpSync(extSrc, ext, { recursive: true });
	writeFileSync(path.join(ext, "preset.js"), `self.PI_PRESET = ${JSON.stringify({ token: TOKEN, port: BRIDGE })};\n`);
	// A 0.1.0 copy has no preset hook: patch its storage defaults instead.
	const bg = path.join(ext, "background.js");
	writeFileSync(bg, readFileSync(bg, "utf8").replace(`{ token: "", port: 17420, allowAll: false }`, `{ token: "${TOKEN}", port: ${BRIDGE}, allowAll: false }`));
	return spawn(chromeBin, ["--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", `--user-data-dir=${path.join(tmp, `profile-${label}`)}`, `--load-extension=${ext}`, "--window-size=1200,800", "about:blank"], { stdio: "ignore" });
}

let chrome;
let vlServer;
const finish = async () => {
	chrome?.kill("SIGKILL");
	vlServer?.close();
	stopSite();
	for (const h of handlers.session_shutdown ?? []) await h({});
	rmSync(tmp, { recursive: true, force: true });
	const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
	console.log(`${pass}/${total} passed; ${lat.length} tool calls, avg ${avg} ms`);
	process.exit(pass === total ? 0 : 1);
};
const show = (t) => console.log((t ?? "").split("\n").slice(0, 30).map((l) => `    | ${l}`).join("\n"));
const open = async (file) => {
	const r = await call("browser_tab", { action: "open", url: `http://127.0.0.1:${A}/${file}` });
	return { T: { tab: `t${/opened tab (\d+)/.exec(r.text)?.[1]}` }, r };
};
const go = (T, file) => call("browser_tab", { ...T, action: "navigate", url: `http://127.0.0.1:${A}/${file}` });
const unwrap = (t) => t ?? "";

let T;
try {
	chrome = launch(root + "/extension", "new");
	let t0 = Date.now();
	let r = await call("browser_tabs", {});
	check("extension connects to the bridge", !r.error, r.error ?? `${Date.now() - t0} ms incl. browser launch`);
	check("tab list is fenced as untrusted", /<untrusted/.test(r.text ?? "") && /data, not instructions/.test(r.text ?? ""));
	const manifest = JSON.parse(readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
	check("extension version bumped", manifest.version === "0.5.0", manifest.version);

	// ── 1. basics: list / open / read / act / close
	({ T, r } = await open("form.html"));
	check("open tab", !r.error && /opened tab/.test(r.text), r.error ?? r.text);
	r = await call("browser_tabs", {});
	check("list shows the owned tab", new RegExp(`${T.tab} \\[owned`).test(r.text ?? ""), r.error);
	r = await call("browser_read", T);
	let fm = r.text;
	show(fm);
	check("read: fenced, refs listed", /<untrusted/.test(fm) && /\[e\d+ button "Save settings"\]/.test(fm), r.error);
	r = await call("browser_act", { ...T, action: "type", ref: ref(fm, 'text input "Your name"'), text: "Ada" });
	check("act type", !r.error && /typed/.test(r.text), r.error);
	r = await call("browser_act", { ...T, action: "select", ref: ref(fm, 'select "Colour"'), value: "Green" });
	await sleep(150);
	check("select native dropdown by label, value verified", !r.error && has(/colour=g/) && /value now "g"/.test(r.text), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "select", ref: ref(fm, 'select "Colour"'), value: "Purple" });
	check("select unknown option lists the real ones", /No option "Purple".*Red/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "check", ref: ref(fm, 'checkbox input "I agree"') });
	r = await call("browser_act", { ...T, action: "click", ref: ref(fm, 'button "Save settings"') });
	await sleep(250);
	check("click Save settings (not risky: no POST form)", !r.error && has(/save name=Ada colour=g agree=true/), r.error ?? JSON.stringify(events.slice(-4)));
	check("act result fences title and url", /<untrusted/.test(r.text ?? ""), r.text);
	r = await call("browser_read", { ...T, diff: true });
	check("read diff", /No changes|Changes since|Most of the page changed/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_read", { ...T, find: "button.*save|select" });
	check("find: only matching lines, with refs", /2 lines match/.test(r.text ?? "") && /\[e\d+ button "Save settings"\]/.test(r.text ?? "") && /select "Colour"/.test(r.text ?? "") && !/Form page/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_read", { ...T, find: "no such thing" });
	check("find: no match says so", /No line matches/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_read", { ...T, find: "save(" });
	check("find: bad regex is a clear error", /not a valid regex/.test(r.error ?? ""), r.error);
	t0 = Date.now();
	r = await call("browser_read", { ...T, find: "(.*)*zzz" });
	check("find: a catastrophic pattern is stopped, not left to hang pi", /took over 2s/.test(r.error ?? "") && Date.now() - t0 < 6000, `${Date.now() - t0} ms: ${r.error ?? r.text}`);
	r = await call("browser_read", { ...T, find: "button" });
	check("find: works again after a stopped pattern", /match \/button\/i/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_read", { ...T, diff: true });
	check("find leaves the diff baseline alone", /No changes/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_tab", { ...T, action: "close" });
	check("close tab", !r.error && /closed tab/.test(r.text), r.error ?? r.text);

	// ── 2. frames
	({ T, r } = await open("frames.html"));
	r = await call("browser_read", { ...T, max_chars: 20000 });
	const fr = r.text ?? "";
	show(fr);
	check("frames: cross-origin frame merged and marked with its origin", /<frame f1 http:\/\/localhost:\d+/.test(fr) && /Inner frame heading/.test(fr), r.error);
	check("frames: nested frame (third origin) read", /Nested deep text/.test(fr));
	check("frames: srcdoc frame read, hidden frame skipped", /Srcdoc frame/.test(fr) && !/should not be read/.test(fr));
	r = await call("browser_read", { ...T, find: "inner submit|top button" });
	check("find: a match in a frame is shown under its frame line", /match [^\n]*:\n\[e\d+ button "Top button"\]/.test(r.text ?? "") && /<frame f\d+ [^\n]*>\n\s*\[f\d+:e\d+ button "Inner submit"\]/.test(r.text ?? ""), r.error ?? r.text);
	const top = ref(fr, 'button "Top button"');
	const innerBtn = ref(fr, 'button "Inner submit"');
	check("frames: top refs stay bare, frame refs are fN:eM", /^e\d+$/.test(top ?? "") && /^f\d+:e\d+$/.test(innerBtn ?? ""), `${top} ${innerBtn}`);
	r = await call("browser_act", { ...T, action: "click", ref: innerBtn }, withUI(true));
	await sleep(200);
	check("frames: click routed into the cross-origin frame", !r.error && has(/inner-click/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "type", ref: ref(fr, 'text input "Inner name"'), text: "hello frame" });
	r = await call("browser_read", { ...T, interactive_only: true });
	check("frames: type into frame field, value shown on re-read", /Inner name" value="hello frame"/.test(r.text ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "click", ref: ref(fr, 'button "Nested button"') });
	await sleep(200);
	check("frames: nested frame click", !r.error && has(/nested-click/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "click", ref: "f99:e1" });
	check("frames: unknown frame ref gives a clear error plus read-again hint", /Unknown frame/.test(r.error ?? "") && /read again|browser_read again/.test(r.error ?? ""), r.error);
	r = await call("browser_screenshot", { ...T, annotate: true });
	check("frames: annotated screenshot labels frame elements", Number(/(\d+) elements labelled/.exec(r.text ?? "")?.[1]) >= 5, r.error ?? r.text?.split("\n")[2]);

	// ── 3. closed shadow root
	await go(T, "shadow.html");
	r = await call("browser_read", T);
	const sh = r.text ?? "";
	check("closed shadow: text and controls read", /Closed root text/.test(sh) && /Closed shadow button/.test(sh) && /Closed shadow input/.test(sh), r.error ?? sh.slice(0, 200));
	r = await call("browser_act", { ...T, action: "click", ref: ref(sh, 'button "Closed shadow button"') });
	await sleep(200);
	check("closed shadow: click lands", !r.error && has(/closed-click/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "type", ref: ref(sh, 'text input "Closed shadow input"'), text: "abc" });
	check("closed shadow: type works", !r.error, r.error);

	// ── 4. widgets
	await go(T, "widgets.html");
	r = await call("browser_read", T);
	const wg = r.text ?? "";
	const cb = ref(wg, 'combobox "Fruit"');
	r = await call("browser_act", { ...T, action: "select", ref: cb, value: "Banana" });
	await sleep(250);
	check("combobox: select option by label (portal listbox)", !r.error && has(/fruit=Banana/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "select", ref: cb, value: "Zucchini" });
	check("combobox: unknown option lists the real ones", /Options: .*Apple/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "select", ref: ref(wg, 'button "Actions"'), value: "Archive" });
	await sleep(250);
	check("menu button: pick menuitem by label", !r.error && has(/menu=Archive/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "type", ref: ref(wg, "editor"), text: "Hello\nWorld" });
	await sleep(250);
	check("contenteditable: type with newline", !r.error && has(/editor=Hello\|World/), r.error ?? r.text);
	const di = ref(wg, "date input");
	r = await call("browser_act", { ...T, action: "type", ref: di, text: "Nov 6, 2026" });
	await sleep(200);
	check("date input: free text normalised to ISO", !r.error && has(/date=2026-11-06/), r.error ?? r.text);
	const rg = ref(wg, "range input");
	r = await call("browser_act", { ...T, action: "type", ref: rg, text: "7" });
	await sleep(200);
	check("range input: value set", has(/range=7/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "select", ref: ref(wg, 'text input "City"'), value: "Berlin" });
	await sleep(200);
	check("datalist input: select a suggestion", has(/city=Berlin/), r.error ?? r.text);

	// ── 5. gate, describe, stale refs, duplicate labels, wider detection
	await go(T, "gate.html");
	r = await call("browser_read", T);
	const gt = r.text ?? "";
	show(gt);
	check("duplicate labels: nearest heading added", /Add to cart" \(for "Wireless mouse"\)/.test(gt) && /Add to cart" \(for "USB-C cable"\)/.test(gt), gt.split("\n").filter((l) => /Add to cart/.test(l)).join(" | "));
	check("aria-hidden content skipped", !/Hidden decoy/.test(gt));
	check("cursor:pointer div and tabindex div are interactive", /Clicky div/.test(gt) && /Focusable div/.test(gt) && /\[e\d+ [^\]]*"?Clicky div/.test(gt));
	const pw = ref(gt, 'password input "Password"');
	const cc = ref(gt, 'text input "Card"');
	const otp = ref(gt, 'text input "Code"');
	r = await call("browser_act", { ...T, action: "type", ref: pw, text: "hunter2" }, withUI(true));
	check("gate: password typing blocked even with a UI", /Blocked/.test(r.error ?? "") && /password/i.test(r.error ?? ""), r.error);
	check("gate: password never reached the page", !has(/pw=/));
	r = await call("browser_act", { ...T, action: "type", ref: cc, text: "4111" }, withUI(true));
	check("gate: card field blocked", /Blocked/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "type", ref: otp, text: "123456" });
	check("gate: one-time-code field blocked", /Blocked/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "type", ref: ref(gt, 'text input "Username"'), text: "ada" });
	await sleep(150);
	check("gate: ordinary field allowed with no UI", !r.error && has(/user=ada/), r.error);
	r = await call("browser_act", { ...T, action: "click", ref: ref(gt, 'button "Show details"') });
	await sleep(150);
	check("gate: plain button click allowed with no UI", !r.error && has(/plain-click/), r.error);
	r = await call("browser_act", { ...T, action: "click", ref: ref(gt, 'button "Add to cart" \\(for "Wireless mouse"\\)') });
	await sleep(150);
	check("duplicate label ref clicks the right product", !r.error && has(/add=add1/), r.error);
	const signin = ref(gt, 'button "Sign in"');
	const before = events.length;
	r = await call("browser_act", { ...T, action: "click", ref: signin });
	check("gate: risky click with no UI is blocked with a reason", /Blocked/.test(r.error ?? "") && /no UI/.test(r.error ?? "") && /Do not retry/.test(r.error ?? ""), r.error);
	check("gate: blocked click did not run", events.length === before || !has(/login-submit/));
	confirms.length = 0;
	r = await call("browser_act", { ...T, action: "click", ref: signin }, withUI(false));
	check("gate: user declines -> error, nothing happened", /declined/.test(r.error ?? "") && confirms.length === 1 && !has(/login-submit/), r.error);
	check("gate: confirm message names the target and reason", /Sign in/.test(confirms[0] ?? "") && /(hard to undo|POST)/.test(confirms[0] ?? ""), confirms[0]);
	r = await call("browser_act", { ...T, action: "click", ref: signin }, withUI(true));
	await sleep(250);
	check("gate: user confirms -> click runs", !r.error && has(/login-submit/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "press", ref: ref(gt, 'text input "Username"'), key: "Enter" });
	check("gate: Enter in a POST form with data asks (blocked without UI)", /Blocked/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "scroll" });
	check("gate: scroll needs no confirmation", !r.error, r.error);
	// stale refs
	const sb = ref(gt, 'button "Refresh me"');
	r = await call("browser_act", { ...T, action: "click", ref: ref(gt, 'button "Re-render"') });
	await sleep(200);
	r = await call("browser_act", { ...T, action: "click", ref: sb });
	await sleep(200);
	check("stale ref recovery: replaced element re-found by role and name", !r.error && has(/stale-click2/), r.error ?? r.text);
	r = await call("browser_act", { ...T, action: "click", ref: "e9999" });
	check("unknown ref: says the page changed, read again", /page changed/.test(r.error ?? "") && /browser_read again/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "click", ref: ref(gt, 'link "Go to form page"') });
	check("URL change hint after navigating click", /The page changed \(URL was .*gate\.html\)/.test(r.text ?? "") && /form\.html/.test(r.text ?? ""), r.error ?? r.text);

	// ── 6. console and network
	await go(T, "debug.html");
	r = await call("browser_console", T);
	check("console: first call starts capture and says so", /Capture started/.test(r.text ?? ""), r.error ?? r.text);
	r = await call("browser_console", { ...T, reload: true, level: "all" });
	const cs = r.text ?? "";
	check("console: error, warn and log captured from page load", /\[error\] boom from page/.test(cs) && /\[warn\] careful now/.test(cs) && /\[log\] just info/.test(cs), r.error);
	check("console: uncaught exception and unhandled rejection captured", /sync failure/.test(cs) && /unhandled rejection: .*async failure/.test(cs));
	check("console: failed fetch (404) and broken image listed", /404 GET \/api\/missing/.test(cs) && /404 GET \/nope\.png/.test(cs));
	check("console: output fenced", /<untrusted/.test(cs));

	// ── 7. upload
	const sample = path.join(tmp, "notes.txt");
	writeFileSync(sample, "hello upload\n");
	await go(T, "upload.html");
	r = await call("browser_read", T);
	const fi = ref(r.text ?? "", "file input");
	check("upload: read shows the file input", !!fi && /no file/.test(r.text ?? ""), fi);
	r = await call("browser_act", { ...T, action: "upload", ref: fi, file: sample });
	check("upload: with no UI it is blocked (always asks)", /Blocked/.test(r.error ?? "") && /notes\.txt/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "upload", ref: fi, file: path.join(os.homedir(), ".ssh/id_rsa") }, withUI(true));
	check("upload: ssh key blocked even with a UI", /Blocked/.test(r.error ?? "") && /secret|credential/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...T, action: "upload", ref: fi, file: "/nonexistent/x.txt" }, withUI(true));
	check("upload: missing file blocked", /Blocked/.test(r.error ?? ""), r.error);
	confirms.length = 0;
	r = await call("browser_act", { ...T, action: "upload", ref: fi, file: sample }, withUI(true));
	await sleep(400);
	check("upload: after the user's yes the page receives a real File", !r.error && has(/file=notes\.txt:13:text\/plain:hello upload/) && /notes\.txt/.test(confirms[0] ?? ""), r.error ?? r.text);

	// ── 8. click_xy
	({ T } = await open("xy.html"));
	r = await call("browser_act", { ...T, action: "click_xy", x: 10, y: 10 });
	check("click_xy without a screenshot asks for one", /screenshot/.test(r.error ?? ""), r.error);
	r = await call("browser_screenshot", T);
	const m = /(\d+)x(\d+)/.exec(r.text ?? "");
	check("screenshot returns an image", /saved:/.test(r.text ?? "") && !!m, r.error);
	r = await call("browser_act", { ...T, action: "click_xy", x: 300, y: 200 });
	await sleep(250);
	const xy = events.map((e) => /^(\d+),(\d+)$/.exec(e.e?.replace("xy=", "") ?? "")).filter(Boolean).pop();
	check("click_xy lands at the screenshot pixel", !r.error && xy && Math.abs(xy[1] - 300 * (1200 / Number(m[1]))) < 6 && Math.abs(xy[2] - 200 * (1200 / Number(m[1]))) < 6, r.error ?? xy?.[0]);

	// ── 9. trusted click
	await go(T, "trusted.html");
	r = await call("browser_read", { ...T, interactive_only: true });
	const nb = ref(r.text ?? "", 'button "Native only"');
	r = await call("browser_act", { ...T, action: "click", ref: nb, trusted: true }, withUI(true));
	check("trusted: refused while PI_BROWSER_TRUSTED is not set", /Blocked/.test(r.error ?? "") && /PI_BROWSER_TRUSTED/.test(r.error ?? ""), r.error);
	process.env.PI_BROWSER_TRUSTED = "1";
	process.env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-test";
	r = await call("browser_act", { ...T, action: "click", ref: nb, trusted: true }, withUI(true));
	check("trusted: refused without a pointer calibration file", /Blocked/.test(r.error ?? "") && /calibration/.test(r.error ?? ""), r.error);
	writeFileSync(path.join(tmp, "no-calibration.json"), JSON.stringify({ version: 1, x: { scale: 1, offset: 0 }, y: { scale: 1, offset: 0 } }));
	const seenEyes = [];
	trusted.deps.eyes = async (label) => (seenEyes.push(label), { x: 700, y: 400 });
	trusted.deps.niri = async () => {
		throw new Error("no niri in test");
	};
	r = await call("browser_act", { ...T, action: "click", ref: nb, trusted: true });
	check("trusted: with no UI the real mouse click is blocked", /Blocked/.test(r.error ?? "") && /real mouse/.test(r.error ?? ""), r.error);
	confirms.length = 0;
	r = await call("browser_act", { ...T, action: "click", ref: nb, trusted: true }, withUI(true));
	console.log(`    | trusted: ${r.error ?? r.text} ${JSON.stringify(r.details?.trusted ?? {})}`);
	check("trusted: asks, eyes place it, dry run prints the calibrated ydotool click", !r.error && r.details?.trusted?.method === "eyes" && r.details.trusted.commands.some((c) => /ydotool mousemove --absolute -x 700 -y 400/.test(c)) && /Native only/.test(seenEyes[0] ?? "") && confirms.length === 1, r.error ?? JSON.stringify(r.details?.trusted));
	check("trusted: dry run sent no click to the page", !has(/trusted-click/));
	delete process.env.PI_BROWSER_TRUSTED;

	// ── 10. point / look degrade, then work against a mock vision model
	await go(T, "xy.html");
	r = await call("browser_look", { ...T, question: "what is shown?" });
	check("look: says no vision model is reachable", /unavailable/.test(r.error ?? "") && /vision model/.test(r.error ?? ""), r.error);
	r = await call("browser_point", { ...T, target: "blue area" });
	check("point: says no vision model is reachable", /unavailable/.test(r.error ?? ""), r.error);
	let lastQuestion = "";
	vlServer = http.createServer((req, res) => {
		if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "lfm3" }, { id: "lfm3-vl" }] }));
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const j = JSON.parse(body);
			const text = j.messages[0].content.find((c) => c.type === "text").text;
			lastQuestion = text;
			const content = /bounding box/.test(text) ? "[400, 300, 600, 500]" : "A light blue page with nothing on it.";
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content } }], model: j.model }));
		});
	}).listen(VL, "127.0.0.1");
	process.env.PI_BROWSER_VL_URL = `http://127.0.0.1:${VL}`;
	r = await call("browser_look", { ...T, question: "what is shown?" });
	check("look: answers from the vision model, fenced", /light blue page/.test(r.text ?? "") && /<untrusted/.test(r.text ?? "") && /what is shown/.test(lastQuestion), r.error ?? r.text);
	r = await call("browser_point", { ...T, target: "blue area" });
	await sleep(250);
	// the mock answers a box at 40-60 percent of the screenshot (centre 50 percent x, 40 percent y of the box 300-500)
	const clicked = /x=(\d+), y=(\d+)/.exec(r.text ?? "");
	const shotH = Number(clicked?.[2]) / 0.4;
	const xy2 = events.map((e) => /^(\d+),(\d+)$/.exec(e.e?.replace("xy=", "") ?? "")).filter(Boolean).pop();
	check("point: vision box centre clicked (500/1000 of the page)", !r.error && /Clicked "blue area"/.test(r.text ?? "") && xy2 && Math.abs(xy2[1] - 600) < 8 && Math.abs(xy2[2] - 0.4 * shotH) < 8, r.error ?? xy2?.[0]);
	check("point: reports what the page shows after the click", /The page now shows: A light blue/.test(r.text ?? ""), r.text);

	// ── 11. outcome unknown (a timeout on an act never claims success or failure)
	{
		const orig = bridgeMod.Bridge.prototype.call;
		bridgeMod.Bridge.prototype.call = async function (op, args, ...rest) {
			if (op === "act" && args.kind === "scroll") throw new Error('The browser did not answer "act" within 60s.');
			return orig.call(this, op, args, ...rest);
		};
		r = await call("browser_act", { ...T, action: "scroll" });
		bridgeMod.Bridge.prototype.call = orig;
		check("timeout on an act -> outcome unknown, read before retrying", !r.error && /outcome unknown/.test(r.text ?? "") && /Read the page/.test(r.text ?? "") && r.details.disposition === "outcome_unknown", r.error ?? r.text);
	}
} catch (e) {
	check("crashed", false, e.stack);
}

// geometry, pure
{
	const base = { cx: 100, cy: 50, w: 80, h: 30, name: "x", iw: 1280, ih: 700, ow: 1280, oh: 800, sx: 0, sy: 0, dpr: 1, focused: true };
	check("geometry: screenX/Y = 0 is unknown, not top-left", trusted.fromScreenXY(base) === undefined);
	const p = trusted.fromScreenXY({ ...base, sx: 200, sy: 100 });
	check("geometry: X11 style position (100px browser chrome on top)", p?.x === 300 && p?.y === 250, JSON.stringify(p));
	const win = { id: 1, title: "Fixture - Helium", app_id: "helium", workspace_id: 1, is_focused: true, layout: { tile_pos_in_workspace_view: [10, 40], window_size: [1000, 800], window_offset_in_tile: [0, 0] } };
	const n = trusted.fromNiri({ ...base, iw: 1000, ih: 700 }, win, { x: 0, y: 0, scale: 1 });
	check("geometry: niri tile position + 100px browser chrome", n?.x === 110 && n?.y === 190, JSON.stringify(n));
	check("geometry: picks the browser window by title", trusted.pickBrowserWindow([{ ...win, app_id: "kitty", title: "Fixture" }, win], "Fixture")?.app_id === "helium");
	check("calibration: corrects ydotool coordinates", JSON.stringify(trusted.correct({ x: { scale: 2, offset: 10 }, y: { scale: 1, offset: 0 } }, 110, 50)) === "[50,50]");
}

// old extension (BT_OLD_EXT = a 0.1.0 copy): the protocol still works, new things say what to do
if (process.env.BT_OLD_EXT && existsSync(process.env.BT_OLD_EXT)) {
	chrome?.kill("SIGKILL");
	await sleep(1500);
	chrome = launch(process.env.BT_OLD_EXT, "old");
	await sleep(4000);
	let { T: OT, r } = await open("gate.html");
	check("old extension: connects and opens a tab", !r.error, r.error);
	r = await call("browser_read", { ...OT, interactive_only: true });
	check("old extension: read works", /input/.test(r.text ?? ""), r.error);
	const g = r.text ?? "";
	r = await call("browser_act", { ...OT, action: "type", ref: ref(g, 'password input "Password"'), text: "x" }, withUI(true));
	check("old extension: password still blocked (degraded facts from the read)", /Blocked/.test(r.error ?? ""), r.error);
	r = await call("browser_act", { ...OT, action: "click", ref: ref(g, 'button "Show details"') });
	await sleep(150);
	check("old extension: plain click works", !r.error, r.error);
	r = await call("browser_act", { ...OT, action: "upload", ref: "e1", file: path.join(tmp, "notes.txt") }, withUI(true));
	check("old extension: upload says to reload the extension", /reload the extension at helium:\/\/extensions/.test(r.error ?? ""), r.error);
	r = await call("browser_console", OT);
	check("old extension: console says to reload the extension", /reload the extension/.test(r.error ?? ""), r.error);
	r = await call("browser_screenshot", OT);
	r = await call("browser_act", { ...OT, action: "click_xy", x: 5, y: 5 }, withUI(true));
	check("old extension: click_xy says to reload the extension", /reload the extension/.test(r.error ?? ""), r.error);
}
await finish();
