import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Bridge, TOKEN_FILE } from "./bridge.ts";

const BROWSER_BIN = process.env.PI_BROWSER_BIN || "helium-browser";
const LAUNCH_WAIT_MS = 25000;

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

const TabParam = Type.String({ description: 'Tab id from browser_tabs, like "t123"' });

export default function (pi: ExtensionAPI) {
	const bridge = new Bridge();

	pi.on("session_shutdown", () => bridge.stop());

	pi.registerTool({
		name: "browser_tabs",
		label: "Browser Tabs",
		description:
			"List the tabs open in the user's real browser (Helium) with title, URL and whether pi may use each one. " +
			"Works through an extension, not the DevTools protocol, so sites see an ordinary browser.",
		promptSnippet: "List the user's open browser tabs (their real, logged-in browser).",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const tabs = (await bridge.call("list", {}, 15000, signal)) as TabInfo[];
			return ok(formatTabs(tabs), { count: tabs.length });
		},
	});

	pi.registerTool({
		name: "browser_read",
		label: "Browser Read",
		description:
			"Read a shared tab as text. Interactive elements are shown as [e5 button \"Save\"] and the ref (e5) is what " +
			"browser_act takes. Refs go stale after navigation or big page changes, so read again.",
		promptSnippet: "Read a shared browser tab as text with element refs for clicking and typing.",
		promptGuidelines: [
			"Read the tab before acting on it, and read again after anything that changes the page.",
			"Use selector or interactive_only to keep big pages small.",
		],
		parameters: Type.Object({
			tab: TabParam,
			selector: Type.Optional(Type.String({ description: "CSS selector: read only this part of the page" })),
			interactive_only: Type.Optional(
				Type.Boolean({ description: "Only list links, buttons and form fields (much shorter)" }),
			),
			max_chars: Type.Optional(Type.Number({ description: "Output cap, default 30000", minimum: 1000 })),
		}),
		async execute(_id, p: { tab: string; selector?: string; interactive_only?: boolean; max_chars?: number }, signal) {
			const text = (await bridge.call(
				"read",
				{ tab: tabId(p.tab), selector: p.selector, interactiveOnly: p.interactive_only, maxChars: p.max_chars },
				30000,
				signal,
			)) as string;
			return ok(text, { tab: p.tab, chars: text.length });
		},
	});

	pi.registerTool({
		name: "browser_act",
		label: "Browser Act",
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
			return ok(text, { tab: p.tab, action: p.action });
		},
	});

	pi.registerTool({
		name: "browser_tab",
		label: "Browser Tab",
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
