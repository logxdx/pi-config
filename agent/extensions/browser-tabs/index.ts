import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Bridge, TOKEN_FILE } from "./bridge.ts";

const BROWSER_BIN = process.env.PI_BROWSER_BIN || "helium-browser";
const LAUNCH_WAIT_MS = 25000;

// Deferred: hidden until the browser-tabs skill loads it with tool_search. A --tools allowlist only
// activates direct tools, so stay direct when one is given (e.g. subagents with a tools: list).
const EXPOSURE = process.argv.some((a) => a === "--tools" || a === "-t" || a.startsWith("--tools=")) ? "direct" : "deferred";

interface TabInfo {
	id: number;
	windowId: number;
	active: boolean;
	title: string;
	url: string;
	access: "none" | "shared" | "owned";
}

function ok(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatTabs(tabs: TabInfo[]): string {
	if (!tabs.length) return "No open tabs.";
	const lines = [`${tabs.length} tabs. Access: shared/owned = pi can read and act; none = listed only.`];
	for (const t of tabs) {
		const flags = [t.access, t.active && "active"].filter(Boolean).join(", ");
		const title = t.title.length > 80 ? `${t.title.slice(0, 79)}…` : t.title;
		lines.push(`\nt${t.id} [${flags}] w${t.windowId}\n  ${title}\n  ${t.url}`);
	}
	return lines.join("\n");
}

function tabId(value: string | number): number {
	const n = Number(String(value).replace(/^t/i, ""));
	if (!Number.isInteger(n)) throw new Error(`Bad tab id "${value}". Use an id from browser_tabs, like t123.`);
	return n;
}

// Latest page text of each tab is also written under here (a file per tab plus tabs.md and a
// .diff.md), so other agents and subagents can read or grep it. Removed when the session ends.
const SNAP_DIR = path.join(os.homedir(), ".cache", "pi-browser-tabs", String(process.pid));

interface Seen {
	url: string;
	lines: string[];
}

interface ReadParams {
	selector?: string;
	interactive_only?: boolean;
	max_chars?: number;
}

// Splits a page read into its header (title, URL, scroll) and body.
function splitRead(text: string): { header: string; body: string } {
	const i = text.indexOf("\n\n");
	return i < 0 ? { header: text, body: "" } : { header: text.slice(0, i), body: text.slice(i + 2) };
}

// Line diff: trims the common prefix and suffix, then LCS on the middle. Past a size cap it falls
// back to comparing line sets, which loses ordering but never gets slow.
function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
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

function formatDiff(d: { removed: string[]; added: string[] }): string {
	return [...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)].join("\n");
}

const TabParam = Type.String({ description: 'Tab id from browser_tabs, like "t123"' });

export default function (pi: ExtensionAPI) {
	const bridge = new Bridge();
	const seen = new Map<string, Seen>();
	const lastParams = new Map<number, ReadParams>();

	pi.on("session_shutdown", () => {
		bridge.stop();
		try {
			rmSync(SNAP_DIR, { recursive: true, force: true });
		} catch {}
	});

	const writeSnap = (name: string, content: string) => {
		try {
			mkdirSync(SNAP_DIR, { recursive: true });
			writeFileSync(path.join(SNAP_DIR, name), content);
		} catch {}
	};

	/** Reads a tab; with `diff`, returns only the lines that changed since this tab was last read the same way. */
	async function readTab(tab: number, p: ReadParams, diff: boolean, signal?: AbortSignal) {
		const full = (await bridge.call(
			"read",
			{ tab, selector: p.selector, interactiveOnly: p.interactive_only, maxChars: p.max_chars },
			30000,
			signal,
		)) as string;
		const { header, body } = splitRead(full);
		const url = header.split("\n")[1] ?? "";
		const key = `${tab}|${p.selector ?? ""}|${p.interactive_only ? 1 : 0}`;
		const prev = seen.get(key);
		const lines = body.split("\n");
		seen.set(key, { url, lines });
		lastParams.set(tab, p);

		let text = full;
		let changed: string | undefined;
		if (prev && prev.url === url) {
			const d = lineDiff(prev.lines, lines);
			changed = formatDiff(d);
			if (diff) {
				if (!changed) text = `${header}\n\nNo changes since the last read.`;
				else if (d.added.length + d.removed.length > lines.length * 0.6) text = `${full}\n\n(Most of the page changed, so it is shown in full.)`;
				else text = `${header}\n\nChanges since the last read (- removed, + added; unchanged lines omitted):\n${changed}`;
			}
		} else if (diff) {
			text = `${full}\n\n(No earlier read of this page to compare with, so it is shown in full.)`;
		}

		if (!p.selector && !p.interactive_only) {
			let host = "page";
			try {
				host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_") || host;
			} catch {}
			const base = `${host}-t${tab}`;
			writeSnap(`${base}.md`, `<!-- updated ${new Date().toISOString()} -->\n${full}\n`);
			if (changed !== undefined) writeSnap(`${base}.diff.md`, `${header}\n\n${changed || "(no changes)"}\n`);
		}
		return { text };
	}

	pi.registerTool({
		name: "browser_tabs",
		label: "Browser Tabs",
		exposure: EXPOSURE,
		description:
			"List the tabs open in the user's real browser (Helium) with title, URL and whether pi may use each one. " +
			"Works through an extension, not the DevTools protocol, so sites see an ordinary browser.",
		promptSnippet: "List the user's open browser tabs (their real, logged-in browser).",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const tabs = (await bridge.call("list", {}, 15000, signal)) as TabInfo[];
			const listing = formatTabs(tabs);
			writeSnap("tabs.md", `${listing}\n`);
			return ok(`${listing}\n\nPage snapshots: ${SNAP_DIR}`, { count: tabs.length });
		},
	});

	pi.registerTool({
		name: "browser_read",
		label: "Browser Read",
		exposure: EXPOSURE,
		description:
			"Read a shared tab as text. Interactive elements are shown as [e5 button \"Save\"] and the ref (e5) is what " +
			"browser_act takes. Refs go stale after navigation or big page changes, so read again.",
		promptSnippet: "Read a shared browser tab as text with element refs for clicking and typing.",
		promptGuidelines: [
			"Read the tab before acting on it, and read again after anything that changes the page.",
			"After the first read of a tab, pass diff: true to see only what changed.",
			"Use selector or interactive_only to keep big pages small.",
		],
		parameters: Type.Object({
			tab: TabParam,
			selector: Type.Optional(Type.String({ description: "CSS selector: read only this part of the page" })),
			interactive_only: Type.Optional(
				Type.Boolean({ description: "Only list links, buttons and form fields (much shorter)" }),
			),
			max_chars: Type.Optional(Type.Number({ description: "Output cap, default 30000", minimum: 1000 })),
			diff: Type.Optional(
				Type.Boolean({
					description:
						"Return only the lines that changed since this tab was last read with the same selector and interactive_only (much shorter). Refs stay valid across reads.",
				}),
			),
		}),
		async execute(
			_id,
			p: { tab: string; selector?: string; interactive_only?: boolean; max_chars?: number; diff?: boolean },
			signal,
		) {
			const { text } = await readTab(tabId(p.tab), p, !!p.diff, signal);
			return ok(text, { tab: p.tab, chars: text.length, diff: !!p.diff });
		},
	});

	pi.registerTool({
		name: "browser_act",
		label: "Browser Act",
		exposure: EXPOSURE,
		description:
			"Act on a shared tab with human-paced input: click, hover, type, press a key, select an option, check/uncheck, " +
			"scroll, or wait for text. Returns the tab's title and URL afterwards. Input is synthetic DOM events, so " +
			"very strict sites may not accept it.",
		promptSnippet: "Click, type, scroll and fill forms in a shared browser tab using refs from browser_read.",
		promptGuidelines: [
			"Ask the user before submitting a form, sending a message, buying, deleting, or any other action that is hard to undo.",
			"Never type passwords or secrets; ask the user to enter them in the browser themselves.",
		],
		parameters: Type.Object({
			tab: TabParam,
			action: Type.Union(
				[
					Type.Literal("click"),
					Type.Literal("double_click"),
					Type.Literal("hover"),
					Type.Literal("type"),
					Type.Literal("press"),
					Type.Literal("select"),
					Type.Literal("check"),
					Type.Literal("uncheck"),
					Type.Literal("scroll"),
					Type.Literal("wait_text"),
				],
				{ description: "What to do" },
			),
			ref: Type.Optional(
				Type.String({ description: 'Element ref from browser_read, like "e5". Needed for all but press, scroll and wait_text' }),
			),
			text: Type.Optional(Type.String({ description: "type: the text. wait_text: the text to wait for" })),
			clear: Type.Optional(Type.Boolean({ description: "type: replace existing content (default true)" })),
			key: Type.Optional(Type.String({ description: 'press: e.g. "Enter", "Tab", "Escape", "Control+a"' })),
			value: Type.Optional(Type.String({ description: "select: option value or visible label" })),
			direction: Type.Optional(
				Type.Union([Type.Literal("down"), Type.Literal("up")], { description: "scroll: default down" }),
			),
			amount: Type.Optional(Type.Number({ description: "scroll: pixels (default 80% of the window)" })),
			timeout_ms: Type.Optional(Type.Number({ description: "wait_text: how long to wait (default 10000)" })),
			show_changes: Type.Optional(
				Type.Boolean({ description: "Also re-read the tab afterwards and append only what changed since its last read" }),
			),
		}),
		async execute(_id, p: Record<string, any>, signal) {
			const kind = p.action === "double_click" ? "click" : p.action === "wait_text" ? "wait-text" : p.action;
			const needsRef = !["press", "scroll", "wait_text"].includes(p.action);
			if (needsRef && !p.ref) throw new Error(`'ref' is required for ${p.action}.`);
			if (p.action === "type" && p.text === undefined) throw new Error("'text' is required for type.");
			if (p.action === "press" && !p.key) throw new Error("'key' is required for press.");
			const text = (await bridge.call(
				"act",
				{
					tab: tabId(p.tab),
					kind,
					double: p.action === "double_click",
					ref: p.ref,
					text: p.text,
					clear: p.clear,
					key: p.key,
					value: p.value,
					direction: p.direction,
					amount: p.amount,
					ms: p.timeout_ms,
				},
				60000,
				signal,
			)) as string;
			if (!p.show_changes) return ok(text, { tab: p.tab, action: p.action });
			const after = await readTab(tabId(p.tab), lastParams.get(tabId(p.tab)) ?? {}, true, signal);
			return ok(`${text}\n---\n${after.text}`, { tab: p.tab, action: p.action });
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		exposure: EXPOSURE,
		description:
			"Screenshot the visible part of a shared tab. A background tab is briefly brought to the front for the shot " +
			"and the previous tab is restored. With annotate, every interactive element on screen is boxed and labelled " +
			"with its browser_read ref. The image is also saved to a file whose path is returned.",
		promptSnippet: "Take a screenshot of a shared browser tab, optionally labelled with element refs.",
		promptGuidelines: [
			"Use browser_read for text and browser_screenshot only when layout, images or charts matter.",
		],
		parameters: Type.Object({
			tab: TabParam,
			annotate: Type.Optional(Type.Boolean({ description: "Box and label interactive elements with their refs" })),
		}),
		async execute(_id, p: { tab: string; annotate?: boolean }, signal) {
			const shot = (await bridge.call("screenshot", { tab: tabId(p.tab), annotate: p.annotate }, 60000, signal)) as {
				data: string;
				mimeType: string;
				width: number;
				height: number;
				labelled: number;
				info: string;
			};
			const file = path.join(SNAP_DIR, `shot-t${tabId(p.tab)}-${Date.now()}.jpg`);
			try {
				mkdirSync(SNAP_DIR, { recursive: true });
				writeFileSync(file, Buffer.from(shot.data, "base64"));
			} catch {}
			const note = `${shot.info}\n${shot.width}x${shot.height}${p.annotate ? `, ${shot.labelled} elements labelled` : ""}\nsaved: ${file}`;
			return {
				content: [
					{ type: "text" as const, text: note },
					{ type: "image" as const, data: shot.data, mimeType: shot.mimeType },
				],
				details: { tab: p.tab, file },
			};
		},
	});

	pi.registerTool({
		name: "browser_tab",
		label: "Browser Tab",
		exposure: EXPOSURE,
		description:
			"Manage tabs: launch the browser, open a new tab (put in a blue \"Pi\" tab group and usable right away), " +
			"navigate, go back/forward, reload, focus, or close a tab pi opened. To use a tab the user already has " +
			"open, they share it first with the extension's toolbar button.",
		promptSnippet: "Launch the user's browser, open or navigate tabs, go back/forward, reload, close tabs pi opened.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("launch"),
					Type.Literal("open"),
					Type.Literal("navigate"),
					Type.Literal("back"),
					Type.Literal("forward"),
					Type.Literal("reload"),
					Type.Literal("focus"),
					Type.Literal("close"),
				],
				{ description: "launch starts the browser if it is not running" },
			),
			tab: Type.Optional(TabParam),
			url: Type.Optional(Type.String({ description: "open, navigate: the URL" })),
			focus: Type.Optional(Type.Boolean({ description: "open: bring the new tab to the front (default false)" })),
		}),
		async execute(_id, p: { action: string; tab?: string; url?: string; focus?: boolean }, signal) {
			if (p.action === "launch") {
				await bridge.start();
				if (bridge.connected()) return ok("The browser is already running and connected.");
				const child = spawn(BROWSER_BIN, [], { detached: true, stdio: "ignore" });
				child.on("error", () => {});
				child.unref();
				if (await bridge.waitConnected(LAUNCH_WAIT_MS)) return ok(`Launched ${BROWSER_BIN}; the extension is connected.`);
				throw new Error(
					`Started ${BROWSER_BIN}, but the extension did not connect within ${LAUNCH_WAIT_MS / 1000}s. ` +
						`Check it is loaded in Helium and its options token matches ${TOKEN_FILE}.`,
				);
			}
			if (p.action !== "open" && p.tab === undefined) throw new Error(`'tab' is required for ${p.action}.`);
			if ((p.action === "navigate") && !p.url) throw new Error("'url' is required for navigate.");
			const text = (await bridge.call(
				"tab",
				{ action: p.action, tab: p.tab === undefined ? undefined : tabId(p.tab), url: p.url, focus: p.focus },
				60000,
				signal,
			)) as string;
			return ok(text, { action: p.action });
		},
	});
}
