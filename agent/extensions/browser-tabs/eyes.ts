// The "eyes": a vision-language model on the llama.cpp router that describes a screenshot and finds things in it.
// Optional: when no vision model is reachable the tools say so and nothing else breaks.
//
// Endpoint: PI_BROWSER_VL_URL, else LLAMA_BASE_URL, else the llama.cpp entry of pi's auth.json, else
// http://localhost:11434. Model: PI_BROWSER_VL_MODEL, else the first model id on the router containing "vl"
// (lfm3-vl). LFM3-VL answers boxes in a 0-1000 space, so the screenshot size does not matter for the mapping;
// decoding is greedy so boxes do not depend on sampling luck. Big screenshots get a zoom pass (crop around the first
// hit at native resolution) when `sharp` resolves; without it the screenshot is sent as it is.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type Box = [number, number, number, number];
export interface Shot {
	buf: Buffer;
	width: number;
	height: number;
}

export class EyesError extends Error {}

const require = createRequire(import.meta.url);
let sharpMod: any | null | undefined;
function sharp(): any | null {
	if (sharpMod === undefined) {
		try {
			sharpMod = require("sharp");
		} catch {
			sharpMod = null;
		}
	}
	return sharpMod;
}

const MAX_SIDE = Number(process.env.PI_BROWSER_VL_MAX_SIDE || 1024);

function baseUrl(): string {
	let url = process.env.PI_BROWSER_VL_URL || process.env.LLAMA_BASE_URL || "";
	if (!url) {
		try {
			const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
			const entry = JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8"))?.["llama.cpp"];
			const cand = [entry?.env?.LLAMA_BASE_URL, entry?.baseUrl, entry?.key].find((v) => typeof v === "string" && /^https?:\/\//.test(v));
			if (cand) url = cand;
		} catch {}
	}
	return (url || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
}

let modelCache: { url: string; model: string; at: number } | undefined;
async function model(signal?: AbortSignal): Promise<string> {
	const url = baseUrl();
	if (process.env.PI_BROWSER_VL_MODEL) return process.env.PI_BROWSER_VL_MODEL;
	if (modelCache && modelCache.url === url && Date.now() - modelCache.at < 60000) return modelCache.model;
	const res = await fetch(`${url}/v1/models`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }).catch(
		(e) => {
			throw new EyesError(`No vision model reachable at ${url} (${e.message}). Set PI_BROWSER_VL_URL / PI_BROWSER_VL_MODEL, or use browser_read.`);
		},
	);
	if (!res.ok) throw new EyesError(`No vision model reachable at ${url}: HTTP ${res.status}.`);
	const ids: string[] = ((await res.json()) as any)?.data?.map((m: any) => String(m.id)) ?? [];
	const vl = ids.find((id) => /vl/i.test(id));
	if (!vl) throw new EyesError(`The model router at ${url} has no vision model (an id containing "vl"; found: ${ids.join(", ") || "none"}). Set PI_BROWSER_VL_MODEL.`);
	modelCache = { url, model: vl, at: Date.now() };
	return vl;
}

function mimeOf(buf: Buffer): string {
	return buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : "image/jpeg";
}

/** The screenshot as a data URL, shrunk to MAX_SIDE when sharp is there (the eyes are faster and as exact). */
async function dataUrl(buf: Buffer, width: number, height: number): Promise<string> {
	const s = sharp();
	if (s && Math.max(width, height) > MAX_SIDE) {
		const k = MAX_SIDE / Math.max(width, height);
		const out = await s(buf).resize({ width: Math.round(width * k), height: Math.round(height * k), fit: "fill" }).png({ compressionLevel: 3 }).toBuffer();
		return `data:image/png;base64,${out.toString("base64")}`;
	}
	return `data:${mimeOf(buf)};base64,${buf.toString("base64")}`;
}

async function ask(url: string, buf: Buffer, width: number, height: number, text: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
	const m = await model(signal);
	const timeout = AbortSignal.timeout(120_000);
	const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: m,
			messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }, { type: "text", text }] }],
			max_tokens: maxTokens,
			temperature: 0,
			top_k: 1,
			cache_prompt: false,
			chat_template_kwargs: { enable_thinking: false },
		}),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	}).catch((e) => {
		throw new EyesError(`Vision model request failed (${e.message}).`);
	});
	if (!res.ok) throw new EyesError(`Vision model request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	const j = (await res.json()) as any;
	return String(j.choices?.[0]?.message?.content ?? "").trim();
}

/** True when a vision model answers on the router. */
export async function available(signal?: AbortSignal): Promise<string | undefined> {
	try {
		await model(signal);
		return undefined;
	} catch (e) {
		return (e as Error).message;
	}
}

async function locateOnce(shot: Shot, target: string, signal?: AbortSignal): Promise<Box | null> {
	const url = await dataUrl(shot.buf, shot.width, shot.height);
	const txt = await ask(url, shot.buf, shot.width, shot.height, `Where is the ${target}? Give the bounding box [x1, y1, x2, y2].`, 64, signal);
	const nums = [...txt.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
	if (nums.length < 4) return null;
	const [x1, y1, x2, y2] = nums;
	const box: Box = [(x1 * shot.width) / 1000, (y1 * shot.height) / 1000, (x2 * shot.width) / 1000, (y2 * shot.height) / 1000];
	return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/** Box of `target` in the pixel space of the shot, or null. Large shots get a native-resolution zoom pass when sharp is there. */
export async function locate(shot: Shot, target: string, signal?: AbortSignal): Promise<{ box: Box; zoomed: boolean } | null> {
	const coarse = await locateOnce(shot, target, signal);
	if (!coarse) return null;
	const s = sharp();
	if (s && Math.max(shot.width, shot.height) > 1.5 * MAX_SIDE) {
		const cw = Math.min(shot.width, MAX_SIDE);
		const ch = Math.min(shot.height, Math.floor(MAX_SIDE * 0.625));
		const cx = (coarse[0] + coarse[2]) / 2;
		const cy = (coarse[1] + coarse[3]) / 2;
		const left = Math.floor(Math.min(Math.max(0, cx - cw / 2), shot.width - cw));
		const top = Math.floor(Math.min(Math.max(0, cy - ch / 2), shot.height - ch));
		try {
			const crop = await s(shot.buf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
			const fine = await locateOnce({ buf: crop, width: cw, height: ch }, target, signal);
			if (fine) return { box: [fine[0] + left, fine[1] + top, fine[2] + left, fine[3] + top].map(Math.round) as Box, zoomed: true };
		} catch {}
	}
	return { box: coarse.map(Math.round) as Box, zoomed: false };
}

export const DESCRIBE =
	"Describe this web page for someone who cannot see it: what the page is, the main content, any dialog, error or warning, and the buttons and fields a user could use next.";

/** Describe the screenshot or answer a question about it. */
export async function look(shot: Shot, question?: string, signal?: AbortSignal): Promise<string> {
	const url = await dataUrl(shot.buf, shot.width, shot.height);
	return ask(url, shot.buf, shot.width, shot.height, question || DESCRIBE, 400, signal);
}
