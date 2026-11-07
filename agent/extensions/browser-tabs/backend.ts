// Talks to the Pi Browser Bridge extension through the bridge: one method per browser capability. Detects an old
// (0.1.0) copy of the extension, which lacks describe, click_xy, upload, console and screenpos, and answers those
// with "reload the extension" instead of crashing.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge, TOKEN_FILE } from "./bridge.ts";
import { OutcomeUnknown, UPLOAD_LIMIT, formatConsole } from "./shared.ts";
import type { ActParams, ConsoleParams, Facts, ReadParams, TabParams } from "./shared.ts";
import { type ScreenPos, resolvePoint, realClick } from "./trusted.ts";

const MIME: Record<string, string> = {
	txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf",
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	zip: "application/zip", html: "text/html", xml: "application/xml",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

interface TabInfo {
	id: number;
	windowId: number;
	active: boolean;
	title: string;
	url: string;
	access: "none" | "shared" | "owned";
}

export function formatTabs(tabs: TabInfo[]): string {
	if (!tabs.length) return "No open tabs.";
	const lines = [`${tabs.length} tabs. Access: shared/owned = pi can read and act; none = listed only.`];
	for (const t of tabs) {
		const flags = [t.access, t.active && "active"].filter(Boolean).join(", ");
		const title = t.title.length > 80 ? `${t.title.slice(0, 79)}…` : t.title;
		lines.push(`\nt${t.id} [${flags}] w${t.windowId}\n  ${title}\n  ${t.url}`);
	}
	return lines.join("\n");
}

export function tabId(value: string | number | undefined): number {
	const n = Number(String(value).replace(/^t/i, ""));
	if (value === undefined || !Number.isInteger(n)) throw new Error(`Bad tab id "${value}". Use an id from browser_tabs, like t123.`);
	return n;
}

const isTimeout = (e: unknown) => /did not answer/.test(String((e as Error)?.message));

export class Tabs {
	readonly bridge = new Bridge();
	/** The tab used when a call names none: the one this session opened or touched last. */
	lastTab: number | undefined;
	/** Width of the last screenshot per tab, so click_xy can map screenshot pixels to the viewport. */
	private shotWidth = new Map<number, number>();
	/** undefined = not probed yet. A 0.1.0 extension lacks describe and click_xy. */
	private newCommands: boolean | undefined;
	/** Features of the connected extension (op "info", added in 0.5.0). A 0.1.0 copy has no such op: features = []. */
	private caps: { at: number; version: string; features: string[] } | undefined;

	constructor(private snapDir: string) {}

	private async has(feature: string, signal?: AbortSignal): Promise<boolean> {
		if (!this.caps || Date.now() - this.caps.at > 30000) {
			try {
				const r = (await this.bridge.call("info", {}, 15000, signal)) as { version: string; features: string[] };
				this.caps = { at: Date.now(), version: r.version, features: r.features ?? [] };
			} catch (e) {
				if (!/Unknown operation/.test(String((e as Error).message))) throw e;
				this.caps = { at: Date.now(), version: "0.1.0", features: [] };
			}
		}
		return this.caps.features.includes(feature);
	}

	/** Extension version as far as known ("0.1.0" when it has no info op). */
	async version(signal?: AbortSignal): Promise<string> {
		await this.has("frames", signal);
		return this.caps?.version ?? "unknown";
	}

	private needsUpdate(what: string) {
		return new Error(
			`${what} needs the newer Pi Browser Bridge extension (this one is ${this.caps?.version ?? "old"}). ` +
				"Ask the user to reload the extension at helium://extensions (the reload arrow on its card). " +
				"Meanwhile use a ref from browser_read instead.",
		);
	}

	tabOf(t?: string): number {
		if (t !== undefined && t !== "") return (this.lastTab = tabId(t));
		if (this.lastTab !== undefined) return this.lastTab;
		throw new Error('No tab given. Use browser_tabs to find one (t123), or browser_tab with action "open" and a url.');
	}

	async list(signal?: AbortSignal) {
		const tabs = (await this.bridge.call("list", {}, 15000, signal)) as TabInfo[];
		return { text: formatTabs(tabs), count: tabs.length };
	}

	async read(p: ReadParams, signal?: AbortSignal) {
		const tab = this.tabOf(p.tab);
		const full = (await this.bridge.call(
			"read",
			{ tab, selector: p.selector, interactiveOnly: p.interactive_only, maxChars: p.max_chars },
			30000,
			signal,
		)) as string;
		return { full, tab: `t${tab}` };
	}

	private async actOp(tab: number, cmd: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
		let raw: string;
		try {
			raw = (await this.bridge.call("act", { tab, ...cmd }, timeoutMs, signal)) as string;
		} catch (e) {
			if (isTimeout(e)) throw new OutcomeUnknown((e as Error).message);
			throw e;
		}
		const i = raw.indexOf("\n---\n");
		const result = i < 0 ? raw : raw.slice(0, i);
		const [title = "", url = ""] = (i < 0 ? "" : raw.slice(i + 5)).split("\n");
		return { text: result, title, url };
	}

	async act(p: ActParams, signal?: AbortSignal) {
		const tab = this.tabOf(p.tab);
		const kind = p.action === "double_click" ? "click" : p.action === "wait_text" ? "wait-text" : p.action;
		const cmd: Record<string, unknown> = {
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
		};
		if (p.action === "click_xy") {
			if (this.newCommands === false) throw this.needsUpdate("click_xy");
			Object.assign(cmd, { kind: "click_xy", x: p.x, y: p.y, shotWidth: this.shotWidth.get(tab) });
			if (!this.shotWidth.has(tab)) throw new Error("click_xy takes pixel coordinates of the last browser_screenshot of this tab. Take one first.");
		}
		if (p.action === "upload") {
			if (!(await this.has("upload", signal))) throw this.needsUpdate("upload");
			Object.assign(cmd, { kind: "upload", files: [readUpload(p.file)] });
		}
		try {
			const r = await this.actOp(tab, cmd, p.action === "wait_text" ? Math.max(60000, (p.timeout_ms ?? 10000) + 15000) : 60000, signal);
			if (p.action === "click_xy") this.newCommands = true;
			return r;
		} catch (e) {
			if (/Unknown page command/.test(String((e as Error).message))) {
				if (p.action === "upload") {
					this.caps = undefined;
					throw this.needsUpdate("upload");
				}
				if (p.action === "click_xy") {
					this.newCommands = false;
					throw this.needsUpdate("click_xy");
				}
			}
			throw e;
		}
	}

	/** Click with the real mouse: work out the screen point of the element, then click it. */
	async trustedClick(p: ActParams, signal?: AbortSignal) {
		const tab = this.tabOf(p.tab);
		if (!p.ref) throw new Error("trusted needs a ref from browser_read.");
		if (!(await this.has("screenpos", signal))) throw this.needsUpdate("trusted click");
		// The real mouse hits what is on screen: bring the tab and its window to the front first.
		await this.bridge.call("tab", { action: "focus", tab }, 20000, signal);
		await new Promise((r) => setTimeout(r, 350));
		const at = await this.actOp(tab, { kind: "screenpos", ref: p.ref }, 20000, signal);
		const where = await resolvePoint(JSON.parse(at.text) as ScreenPos, at.title, signal);
		const commands = await realClick(where.x, where.y, p.action === "double_click");
		await new Promise((r) => setTimeout(r, 500));
		const after = await this.actOp(tab, { kind: "header" }, 15000, signal);
		return {
			text: `clicked with the real mouse at (${where.x}, ${where.y}) [${where.method}]`,
			title: after.title,
			url: after.url,
			trusted: { x: where.x, y: where.y, method: where.method, exact: where.exact, note: where.note, commands },
		};
	}

	/** Facts about the element an act targets, for the gate. */
	async describe(p: ActParams, signal?: AbortSignal): Promise<Facts[]> {
		const tab = this.tabOf(p.tab);
		if (this.newCommands !== false) {
			const cmd: Record<string, unknown> = { kind: "describe" };
			if (p.ref) cmd.ref = p.ref;
			else if (p.x !== undefined) Object.assign(cmd, { x: p.x, y: p.y, shotWidth: this.shotWidth.get(tab) });
			try {
				const r = await this.actOp(tab, cmd, 15000, signal);
				this.newCommands = true;
				const f = JSON.parse(r.text) as Facts;
				try {
					f.host = new URL(r.url).hostname;
				} catch {}
				if (f.inFrame) f.frameOrigin = f.origin;
				return [f];
			} catch (e) {
				if (!/Unknown page command/.test(String((e as Error).message))) throw e;
				this.newCommands = false;
			}
		}
		// Old extension: find the ref's line in an interactive-only read. Label and field type only, no form facts.
		if (!p.ref) return [];
		const full = (await this.bridge.call("read", { tab, interactiveOnly: true, maxChars: 30000 }, 30000, signal)) as string;
		const id = p.ref.replace(/^@/, "");
		const line = full.split("\n").find((l) => l.includes(`[${id} `));
		if (!line) return [];
		const kind = (/\[(?:f\d+:)?e\d+ ([^"\]]*)/.exec(line)?.[1] ?? "").trim();
		const name = /"([^"]*)"/.exec(line)?.[1] ?? "";
		return [{ role: kind, type: /^password input/.test(kind) ? "password" : undefined, name, degraded: true }];
	}

	async console(p: ConsoleParams, signal?: AbortSignal) {
		const tab = this.tabOf(p.tab);
		if (!(await this.has("console", signal))) throw this.needsUpdate("browser_console");
		const level = p.level ?? "error";
		const limit = p.limit ?? 30;
		let r: Parameters<typeof formatConsole>[0];
		try {
			r = (await this.bridge.call("console", { tab, level, limit, clear: p.clear, reload: p.reload }, 60000, signal)) as Parameters<typeof formatConsole>[0];
		} catch (e) {
			if (/Unknown operation/.test(String((e as Error).message))) {
				this.caps = undefined;
				throw this.needsUpdate("browser_console");
			}
			throw e;
		}
		return formatConsole(r, level);
	}

	async screenshot(p: { tab?: string; annotate?: boolean }, signal?: AbortSignal) {
		const tab = this.tabOf(p.tab);
		const shot = (await this.bridge.call("screenshot", { tab, annotate: p.annotate }, 60000, signal)) as {
			data: string;
			mimeType: string;
			width: number;
			height: number;
			labelled: number;
			info: string;
		};
		this.shotWidth.set(tab, shot.width);
		const file = path.join(this.snapDir, `shot-t${tab}-${Date.now()}.jpg`);
		try {
			mkdirSync(this.snapDir, { recursive: true });
			writeFileSync(file, Buffer.from(shot.data, "base64"));
		} catch {}
		const note = `${shot.info}\n${shot.width}x${shot.height}${p.annotate ? `, ${shot.labelled} elements labelled` : ""}\nsaved: ${file}\nclick_xy takes pixel coordinates of this image.`;
		return { file, width: shot.width, height: shot.height, note, data: shot.data, mimeType: shot.mimeType, tab: `t${tab}` };
	}

	async tab(p: TabParams, signal?: AbortSignal, launch?: () => Promise<string>) {
		if (p.action === "launch") {
			await this.bridge.start();
			if (this.bridge.connected()) return { text: "The browser is already running and connected." };
			return { text: await launch!() };
		}
		if (p.action !== "open" && (p.tab === undefined || p.tab === "")) p = { ...p, tab: `t${this.tabOf(undefined)}` };
		if (p.action === "navigate" && !p.url) throw new Error("'url' is required for navigate.");
		let raw: string;
		try {
			raw = (await this.bridge.call(
				"tab",
				{ action: p.action, tab: p.tab === undefined ? undefined : tabId(p.tab), url: p.url, focus: p.focus },
				60000,
				signal,
			)) as string;
		} catch (e) {
			if (isTimeout(e)) throw new OutcomeUnknown((e as Error).message);
			throw e;
		}
		const opened = /^opened tab (\d+)/.exec(raw);
		if (opened) this.lastTab = Number(opened[1]);
		const tail = raw.split("\n").slice(-2);
		const hasPage = !/^closed tab/.test(raw) && tail.length === 2;
		return { text: raw, title: hasPage ? tail[0] : undefined, url: hasPage ? tail[1] : undefined, tab: opened ? `t${opened[1]}` : p.tab };
	}

	shutdown() {
		this.bridge.stop();
	}
}

export { TOKEN_FILE };

/** Reads a file for upload: name, type and bytes as base64. Size and sensitivity are checked by the gate too. */
export function readUpload(file: string | undefined) {
	if (!file) throw new Error("upload needs a file path.");
	const abs = path.resolve(file.replace(/^~(?=\/|$)/, os.homedir()));
	let size: number;
	let mtime: number;
	try {
		const st = statSync(abs);
		if (!st.isFile()) throw new Error("not a file");
		size = st.size;
		mtime = st.mtimeMs;
	} catch {
		throw new Error(`${abs} is not a readable file.`);
	}
	if (size > UPLOAD_LIMIT) throw new Error(`${path.basename(abs)} is ${Math.round(size / 1024)} KB: uploads are limited to ${UPLOAD_LIMIT / 1024 / 1024} MB.`);
	const ext = path.extname(abs).slice(1).toLowerCase();
	return { name: path.basename(abs), type: MIME[ext] ?? "", b64: readFileSync(abs).toString("base64"), mtime: Math.round(mtime) };
}
