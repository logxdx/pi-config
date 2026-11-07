// Types and helpers shared by the two browser backends and the tool layer.
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Words in a button, link or field that make an action hard to undo. */
export const RISKY_WORDS =
	/\b(buy|purchase|order|pay|checkout|place order|subscribe|send|submit|post|publish|tweet|reply|delete|remove|erase|destroy|discard|transfer|withdraw|confirm|sign up|register|unsubscribe|cancel (my )?(account|subscription)|reset|format|uninstall|log ?out|sign ?out)\b/i;
export const SECRET_FIELD = /\b(password|passcode|pin|otp|one[- ]time|2fa|verification code|cvc|cvv|card number|credit card|security code|ssn)\b/i;

/** The gate's verdict for one browser_act call. */
export interface Assessment {
	level: "allow" | "ask" | "block";
	reasons: string[];
	/** One line describing the target, e.g. `button "Place order" on shop.example`. */
	target?: string;
}
export function allow(target?: string): Assessment {
	return { level: "allow", reasons: [], target };
}

/** Thrown when an action may or may not have run (timeout, lost reply). The tool turns it into outcome_unknown. */
export class OutcomeUnknown extends Error {}

export interface ReadParams {
	tab?: string;
	selector?: string;
	interactive_only?: boolean;
	max_chars?: number;
	diff?: boolean;
}

export interface ActParams {
	tab?: string;
	action: string;
	ref?: string;
	text?: string;
	clear?: boolean;
	key?: string;
	value?: string;
	direction?: string;
	amount?: number;
	timeout_ms?: number;
	x?: number;
	y?: number;
	show_changes?: boolean;
	/** upload: path of the file on this machine. */
	file?: string;
	/** click with the real mouse through ydotool (needs PI_BROWSER_TRUSTED=1). */
	trusted?: boolean;
}

export interface ConsoleParams {
	tab?: string;
	level?: "error" | "warn" | "all";
	limit?: number;
	clear?: boolean;
	reload?: boolean;
}

export interface TabParams {
	action: string;
	tab?: string;
	url?: string;
	focus?: boolean;
}

/** What the safety gate needs to know about the element an action targets. */
export interface Facts {
	tag?: string;
	role?: string;
	type?: string;
	name?: string;
	placeholder?: string;
	autocomplete?: string;
	field?: string;
	host?: string;
	submit?: boolean;
	/** Origin and frame flag as the page reports them (every element). */
	origin?: string;
	inFrame?: boolean;
	/** Origin of the frame the element lives in, set only for elements inside an iframe. */
	frameOrigin?: string;
	/** Frame label like f3, set only for elements inside an iframe. */
	frame?: string;
	form?: { method: string; action?: string; textFields: number; hasSecret: boolean };
	/** The backend could not see form details (old extension): verdict rests on the label alone. */
	degraded?: boolean;
}

/** Splits a page read into its header (title, URL, ...) and body. */
export function splitRead(text: string): { header: string; body: string } {
	const i = text.indexOf("\n\n");
	return i < 0 ? { header: text, body: "" } : { header: text.slice(0, i), body: text.slice(i + 2) };
}

// Line diff: trims the common prefix and suffix, then LCS on the middle. Past a size cap it falls
// back to comparing line sets, which loses ordering but never gets slow.
export function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
	let lo = 0;
	while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
	let ea = a.length;
	let eb = b.length;
	while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
		ea--;
		eb--;
	}
	const x = a.slice(lo, ea);
	const y = b.slice(lo, eb);
	if (x.length * y.length > 4_000_000) {
		const sx = new Set(x);
		const sy = new Set(y);
		return { removed: x.filter((l) => !sy.has(l)), added: y.filter((l) => !sx.has(l)) };
	}
	const w = y.length + 1;
	const dp = new Uint32Array((x.length + 1) * w);
	for (let i = x.length - 1; i >= 0; i--) {
		for (let j = y.length - 1; j >= 0; j--) {
			dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
		}
	}
	const removed: string[] = [];
	const added: string[] = [];
	let i = 0;
	let j = 0;
	while (i < x.length && j < y.length) {
		if (x[i] === y[j]) {
			i++;
			j++;
		} else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) removed.push(x[i++]);
		else added.push(y[j++]);
	}
	while (i < x.length) removed.push(x[i++]);
	while (j < y.length) added.push(y[j++]);
	return { removed, added };
}

export function formatDiff(d: { removed: string[]; added: string[] }): string {
	return [...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)].join("\n");
}

/**
 * Lists of identical buttons ("Add to cart", "Edit", "Delete") are where a small planner clicks the wrong one (hard
 * evals: cart-two). When a ref'd button/link label occurs more than once, add the nearest text above it:
 * `[e24 button "Add to cart" (for "USB-C cable, braided 2 m")]`.
 */
export function labelDuplicates(lines: string[]): string[] {
	const label = (l: string) => /^\[(?:f\d+:)?e\d+ (button|link|menuitem|option|checkbox|radio)(?: "([^"]*)")?/.exec(l);
	const counts = new Map<string, number>();
	for (const l of lines) {
		const m = label(l);
		if (m) counts.set(`${m[1]}|${m[2] ?? ""}`, (counts.get(`${m[1]}|${m[2] ?? ""}`) ?? 0) + 1);
	}
	return lines.map((l, i) => {
		const m = label(l);
		if (!m || (counts.get(`${m[1]}|${m[2] ?? ""}`) ?? 0) < 2) return l;
		for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
			const prev = lines[j];
			const t = prev.startsWith("[") ? /^\[(?:f\d+:)?e\d+ (?:heading|link|cell|text)[^"]*"([^"]+)"/.exec(prev)?.[1] : prev.replace(/^[#\-\s]+/, "");
			if (t && /[a-z]/i.test(t) && t !== m[2] && !counts.has(`button|${t}`)) {
				const ctx = t.length > 50 ? `${t.slice(0, 49)}…` : t;
				return l.replace(/\]/, ` (for "${ctx}")]`);
			}
		}
		return l;
	});
}

/** The gate's verdict for an act, from the facts about its target. */
export function assessFacts(p: ActParams, facts: Facts[], hostHint?: string): Assessment {
	const kinds = ["click", "double_click", "click_xy", "type", "press", "upload"];
	if (!kinds.includes(p.action)) return allow();
	if (p.action === "press" && !/^enter$/i.test(p.key ?? "") && !/^(return)$/i.test(p.key ?? "")) return allow();
	const f = facts[0];
	if (!f && p.action === "upload") return assessUpload(p, "file input", hostHint);
	if (!f) return allow();
	const label = (f.name ?? "").trim();
	const host = f.host || hostHint;
	let frameHost: string | undefined;
	try {
		frameHost = f.frameOrigin ? new URL(f.frameOrigin).hostname : undefined;
	} catch {}
	const inFrame = frameHost && frameHost !== host ? ` in frame ${f.frame ?? ""} (${frameHost})`.replace("  ", " ") : "";
	const target = `${f.role || f.tag || "element"}${label ? ` "${label}"` : ""}${host ? ` on ${host}` : ""}${inFrame}`;
	const hay = [f.name, f.placeholder, f.autocomplete, f.field].filter(Boolean).join(" ");
	const reasons: string[] = [];

	if (p.action === "upload") return assessUpload(p, target, host);
	// A payment or sign-in widget inside a third-party frame: the page cannot be trusted to describe it.
	if (frameHost && frameHost !== host && PAYMENT_FRAME.test(frameHost)) {
		reasons.push(`inside a payment frame (${frameHost})`);
	}

	if (p.action === "type") {
		const secret =
			facts.some((x) => x.type === "password") ||
			SECRET_FIELD.test(hay) ||
			/\b(cc-|one-time-code)/.test(f.autocomplete ?? "");
		if (secret) {
			return {
				level: "block",
				reasons: ["This is a password, code or card field. Never type secrets: ask the user to enter it in the browser."],
				target,
			};
		}
		return reasons.length ? { level: "ask", reasons, target } : allow(target);
	}

	// click / double_click / click_xy / press Enter
	for (const x of facts) {
		const l = (x.name ?? "").trim();
		if (l && RISKY_WORDS.test(l)) reasons.push(`"${l}" is hard to undo`);
		const postForm = x.form?.method === "post";
		const dataForm = postForm && (x.form!.textFields > 0 || x.form!.hasSecret);
		if (dataForm && (x.submit || p.action === "press")) reasons.push("submits a form (POST) with typed data");
		else if (postForm && x.submit && RISKY_WORDS.test(l)) reasons.push("submits a POST form");
	}
	if (p.action === "press" && !reasons.length && f.form?.method === "post" && f.form.textFields > 0 && f.tag !== "textarea") {
		reasons.push("Enter submits a form (POST)");
	}
	return reasons.length ? { level: "ask", reasons: [...new Set(reasons)], target } : allow(target);
}

const PAYMENT_FRAME = /(^|\.)(stripe|paypal|braintree|adyen|checkout|payments?|pay|card|squareup|klarna|authorize)\b/i;

/** Files that must never leave this machine through a web form. */
const SENSITIVE_FILE =
	/(^|\/)(\.ssh|\.gnupg|\.aws|\.pi|\.config\/(pi-browser-tabs)|\.password-store)(\/|$)|(^|\/)(id_(rsa|ed25519|ecdsa|dsa)|\.env[^/]*|\.netrc|credentials[^/]*|.*\.(pem|key|p12|kdbx))$/i;

export const UPLOAD_LIMIT = 5 * 1024 * 1024;

/** Uploading a local file always asks, and some files are refused outright. */
function assessUpload(p: ActParams, target: string, host?: string): Assessment {
	const file = p.file ? path.resolve(p.file.replace(/^~(?=\/|$)/, os.homedir())) : "";
	if (!file) return { level: "block", reasons: ["upload needs a file path"], target };
	if (SENSITIVE_FILE.test(file)) {
		return { level: "block", reasons: [`${path.basename(file)} looks like a secret or credential file: never upload it`], target };
	}
	let size = -1;
	try {
		const st = statSync(file);
		if (!st.isFile()) return { level: "block", reasons: [`${file} is not a regular file`], target };
		size = st.size;
	} catch {
		return { level: "block", reasons: [`${file} does not exist`], target };
	}
	if (size > UPLOAD_LIMIT) return { level: "block", reasons: [`${path.basename(file)} is ${Math.round(size / 1024)} KB: the limit is ${UPLOAD_LIMIT / 1024 / 1024} MB`], target };
	return { level: "ask", reasons: [`uploads ${file} (${size} bytes) to ${host ?? "the page"}`], target };
}

export interface DebugReport {
	console: { l: string; t: string; s?: string; at: number; frame?: string }[];
	net: { at: number; m?: string; u: string; type?: string; s?: number; e?: string; f?: number }[];
	counts: { console: number; net: number };
	started?: boolean;
	info?: string;
}

/** Short text for browser_console: repeated lines are counted, urls lose the origin of the page. */
export function formatConsole(r: DebugReport, level: string): { text: string; counts: { console: number; net: number } } {
	const [title = "", url = ""] = (r.info ?? "").split("\n");
	const lines: string[] = [];
	if (title || url) lines.push(`${title}\n${url}`);
	if (r.started) {
		lines.push("Capture started for this tab just now: only what happens from here on is recorded. Reproduce the problem, or call again with reload: true to capture the page load.");
	}
	const short = (u: string) => {
		try {
			const x = new URL(u);
			const base = url && new URL(url).origin === x.origin ? "" : x.origin;
			const rest = `${x.pathname}${x.search}`;
			return `${base}${rest.length > 90 ? `${rest.slice(0, 89)}…` : rest}`;
		} catch {
			return u.slice(0, 100);
		}
	};
	const groups = new Map<string, { n: number; text: string }>();
	for (const m of r.console) {
		const text = `[${m.l}] ${m.t.replace(/\s+/g, " ").slice(0, 200)}${m.frame ? ` (frame ${m.frame})` : ""}`;
		const g = groups.get(text) ?? { n: 0, text };
		g.n++;
		groups.set(text, g);
	}
	lines.push(`console (${level}): ${r.console.length === 0 ? "nothing" : `${r.console.length}${r.counts.console > r.console.length ? ` of ${r.counts.console}` : ""}`}`);
	for (const g of groups.values()) lines.push(`  ${g.text}${g.n > 1 ? ` x${g.n}` : ""}`);
	const net = new Map<string, number>();
	for (const n of r.net) {
		const k = `${n.s ?? "ERR"} ${n.m ?? ""} ${short(n.u)}${n.e ? ` ${n.e.replace(/^net::/, "")}` : ""}${n.type ? ` (${n.type})` : ""}`.replace(/  +/g, " ");
		net.set(k, (net.get(k) ?? 0) + 1);
	}
	lines.push(`failed requests (status 400+ or network error): ${net.size === 0 ? "none" : r.net.length}`);
	for (const [k, n] of net) lines.push(`  ${k}${n > 1 ? ` x${n}` : ""}`);
	return { text: lines.join("\n"), counts: { console: r.console.length, net: r.net.length } };
}
