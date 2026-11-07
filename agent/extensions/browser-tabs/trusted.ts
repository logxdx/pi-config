// Trusted click: some widgets ignore synthetic events (isTrusted=false), so the click can go through the real mouse
// instead. Only with PI_BROWSER_TRUSTED=1. This file works out WHERE to click (the centre of the element in global
// logical screen coordinates) and moves the pointer: ydotool on Wayland (needs the pointer calibration measured into
// ~/.pi-operator/input-calibration.json, else it refuses), xdotool on X11. PI_BROWSER_DRYRUN=1 prints the commands.
//
//   X11 / Windows / macOS: window.screenX/Y are real, the position follows from them.
//   Wayland: window.screenX/Y are 0 (unknown). niri can tell where a tiled window sits, but not the offset of the
//            working area (a bar), so that is an estimate, checked against the eyes (a grim capture) before clicking.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { locate } from "./eyes.ts";

const run = promisify(execFile);

export const trustedEnabled = () => process.env.PI_BROWSER_TRUSTED === "1";

/** What page.js "screenpos" returns, with the frame offset already added to cx / cy (viewport CSS pixels). */
export interface ScreenPos {
	cx: number;
	cy: number;
	w: number;
	h: number;
	name: string;
	iw: number;
	ih: number;
	ow: number;
	oh: number;
	sx: number;
	sy: number;
	dpr: number;
	focused: boolean;
}

export interface Placement {
	x: number;
	y: number;
	method: "screenxy" | "niri" | "eyes";
	exact: boolean;
	note: string;
}

function contentOffset(p: ScreenPos, z: number) {
	const side = Math.max(0, (p.ow - p.iw * z) / 2);
	const top = Math.max(0, p.oh - p.ih * z - side);
	return { side, top };
}

export function fromScreenXY(p: ScreenPos, zoom = 1): Placement | undefined {
	if (!p.sx && !p.sy) return undefined; // Wayland: unknown, not "top left"
	const { side, top } = contentOffset(p, zoom);
	return {
		x: Math.round(p.sx + side + p.cx * zoom),
		y: Math.round(p.sy + top + p.cy * zoom),
		method: "screenxy",
		exact: true,
		note: `window at (${p.sx}, ${p.sy}), content offset (${Math.round(side)}, ${Math.round(top)})`,
	};
}

export interface NiriWindow {
	id: number;
	title: string;
	app_id: string;
	workspace_id: number;
	is_focused: boolean;
	layout: { tile_pos_in_workspace_view: [number, number] | null; window_size: [number, number]; window_offset_in_tile?: [number, number] };
}
export interface NiriOutput {
	x: number;
	y: number;
	scale: number;
}

const BROWSER_APP = /^(firefox|librewolf|zen|helium|chrom|google-chrome|brave|vivaldi|microsoft-edge|opera)/i;

export function pickBrowserWindow(windows: NiriWindow[], tabTitle: string): NiriWindow | undefined {
	const browsers = windows.filter((w) => BROWSER_APP.test(w.app_id));
	const byTitle = tabTitle ? browsers.filter((w) => w.title.includes(tabTitle.slice(0, 40))) : [];
	return byTitle.find((w) => w.is_focused) ?? byTitle[0] ?? browsers.find((w) => w.is_focused);
}

export function fromNiri(p: ScreenPos, win: NiriWindow, out: NiriOutput): Placement | undefined {
	const pos = win.layout.tile_pos_in_workspace_view;
	if (!pos) return undefined;
	const off = win.layout.window_offset_in_tile ?? [0, 0];
	const z = p.dpr / (out.scale || 1);
	const probe = { ...p, ow: win.layout.window_size[0], oh: win.layout.window_size[1] };
	const { side, top } = contentOffset(probe, z);
	return {
		x: Math.round(out.x + pos[0] + off[0] + side + p.cx * z),
		y: Math.round(out.y + pos[1] + off[1] + top + p.cy * z),
		method: "niri",
		exact: false,
		note: `niri window ${win.id} tile at (${pos[0]}, ${pos[1]}) on an output at (${out.x}, ${out.y}), scale ${out.scale}; bar offset unknown`,
	};
}

/** Test seam: everything that talks to the desktop. */
export const deps = {
	async niri(args: string[]): Promise<string> {
		return (await run("niri", ["msg", "-j", ...args], { timeout: 4000 })).stdout;
	},
	/** Box centre of `label` found by the eyes on a fresh grim capture of the focused niri output, in global logical coordinates. */
	async eyes(label: string, signal?: AbortSignal): Promise<{ x: number; y: number } | undefined> {
		if (!process.env.NIRI_SOCKET) throw new Error("screen capture is only set up for niri (grim)");
		const out = JSON.parse((await run("niri", ["msg", "-j", "focused-output"], { timeout: 5000 })).stdout);
		const o = out.logical;
		const name = out.name;
		const png = (await run("grim", ["-o", name, "-"], { timeout: 15000, maxBuffer: 64 << 20, encoding: "buffer" })).stdout as Buffer;
		const width = png.readUInt32BE(16);
		const height = png.readUInt32BE(20);
		const found = await locate({ buf: png, width, height }, label, signal);
		if (!found) return undefined;
		const [x1, y1, x2, y2] = found.box;
		return { x: Math.round(o.x + ((x1 + x2) / 2) / (width / o.width)), y: Math.round(o.y + ((y1 + y2) / 2) / (height / o.height)) };
	},
};

async function niriPlacement(p: ScreenPos, tabTitle: string): Promise<Placement | undefined> {
	if (!process.env.NIRI_SOCKET) return undefined;
	try {
		const windows = JSON.parse(await deps.niri(["windows"])) as NiriWindow[];
		const win = pickBrowserWindow(windows, tabTitle);
		if (!win) return undefined;
		const workspaces = JSON.parse(await deps.niri(["workspaces"])) as { id: number; output: string }[];
		const outputs = JSON.parse(await deps.niri(["outputs"])) as Record<string, { logical?: { x: number; y: number; scale: number } }>;
		const lg = outputs[workspaces.find((w) => w.id === win.workspace_id)?.output ?? ""]?.logical;
		return lg ? fromNiri(p, win, lg) : undefined;
	} catch {
		return undefined;
	}
}

export interface Resolved extends Placement {
	eyes?: { x: number; y: number };
}

/** The screen point to click, or throws with what to do next. Estimates must agree with the eyes. */
export async function resolvePoint(p: ScreenPos, tabTitle: string, signal?: AbortSignal): Promise<Resolved> {
	const label = p.name ? `the "${p.name}" element` : "the highlighted element";
	let est: Placement | undefined;
	if (process.env.WAYLAND_DISPLAY) est = await niriPlacement(p, tabTitle);
	else est = fromScreenXY(p);
	if (est?.exact) return est;
	let seen: { x: number; y: number } | undefined;
	try {
		seen = await deps.eyes(label, signal);
	} catch (e) {
		if (est) throw new Error(`Could not verify the click position (${(e as Error).message}). Not clicking: use a normal click or ask the user.`);
		throw new Error(`Cannot place the element on the screen (no window position, and the eyes failed: ${(e as Error).message}).`);
	}
	if (est && seen) {
		const tol = Math.max(90, p.w, p.h);
		if (Math.hypot(est.x - seen.x, est.y - seen.y) > tol) {
			throw new Error(`The window geometry says (${est.x}, ${est.y}) but the eyes see ${label} at (${seen.x}, ${seen.y}). Not clicking: they disagree. Use a normal click.`);
		}
		return { ...est, x: seen.x, y: seen.y, eyes: seen, note: `${est.note}; refined by the eyes` };
	}
	if (seen) return { x: seen.x, y: seen.y, method: "eyes", exact: false, eyes: seen, note: "located by the eyes in a screen capture" };
	if (est) throw new Error(`The eyes could not find ${label} to confirm (${est.x}, ${est.y}). Not clicking.`);
	throw new Error(`Cannot place ${label} on the screen: the window position is unknown and the eyes could not find it.`);
}

// ── Calibration (ydotool absolute moves go through pointer acceleration) ─────────────────────────────────────

type Axis = { scale: number; offset: number };
export type Calibration = { version?: number; x: Axis; y: Axis };
export const CAL_FILE = () => process.env.PI_BROWSER_CALIBRATION || path.join(os.homedir(), ".pi-operator", "input-calibration.json");
const sane = (a: any): a is Axis => a && Number.isFinite(a.scale) && Number.isFinite(a.offset) && a.scale > 0.2 && a.scale < 5 && Math.abs(a.offset) < 2000;

export function loadCalibration(file = CAL_FILE()): Calibration | null {
	try {
		if (!existsSync(file) || !statSync(file).isFile()) return null;
		const j = JSON.parse(readFileSync(file, "utf8"));
		return j && sane(j.x) && sane(j.y) ? (j as Calibration) : null;
	} catch {
		return null;
	}
}

/** The coordinates to ask ydotool for so the pointer lands on (x, y). */
export function correct(cal: Calibration, x: number, y: number): [number, number] {
	return [Math.round((x - cal.x.offset) / cal.x.scale), Math.round((y - cal.y.offset) / cal.y.scale)];
}

/** Why a trusted click cannot run here, or undefined when it can. */
export function trustedUnavailable(): string | undefined {
	if (!trustedEnabled()) return "trusted clicks are off. The user can enable them by starting pi with PI_BROWSER_TRUSTED=1; otherwise click normally.";
	if (process.platform === "linux" && process.env.WAYLAND_DISPLAY && !loadCalibration()) {
		return `trusted clicks need the ydotool pointer calibration, and ${CAL_FILE()} does not exist or is not valid. Ask the user to calibrate the pointer, or click normally.`;
	}
	return undefined;
}

const YDOTOOL_SOCKET = process.env.YDOTOOL_SOCKET || "/tmp/.ydotool_socket";

/** Click at global logical coordinates. Returns the commands run (or only printed with PI_BROWSER_DRYRUN=1). */
export async function realClick(x: number, y: number, double = false): Promise<string[]> {
	x = Math.round(x);
	y = Math.round(y);
	let cmds: { cmd: string; args: string[]; env?: Record<string, string> }[];
	if (process.env.WAYLAND_DISPLAY || !process.env.DISPLAY) {
		const cal = loadCalibration();
		if (!cal) throw new Error(`No pointer calibration at ${CAL_FILE()}.`);
		[x, y] = correct(cal, x, y);
		const env = { YDOTOOL_SOCKET };
		cmds = [
			{ cmd: "ydotool", args: ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], env },
			{ cmd: "ydotool", args: ["click", "--repeat", double ? "2" : "1", "0xC0"], env },
		];
	} else {
		cmds = [
			{ cmd: "xdotool", args: ["mousemove", String(x), String(y)] },
			{ cmd: "xdotool", args: ["click", "--repeat", double ? "2" : "1", "1"] },
		];
	}
	const shown = cmds.map((c) => [c.cmd, ...c.args].join(" "));
	if (process.env.PI_BROWSER_DRYRUN === "1") return shown;
	for (const c of cmds) {
		try {
			await run(c.cmd, c.args, { timeout: 30_000, env: { ...process.env, ...c.env } });
		} catch (e: any) {
			const hint = c.cmd === "ydotool" ? " (is ydotoold running?)" : e.code === "ENOENT" ? ` (${c.cmd} is not installed)` : "";
			throw new Error(`${c.cmd} failed: ${(e.stderr || e.message || "").toString().trim().slice(0, 160)}${hint}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return shown;
}
