/**
 * Output Guard
 *
 * Keeps big tool results out of the context window. A result over the budget
 * is written to a temp file; the model gets a short head/tail preview and the
 * path, and pulls what it needs with `read` (offset/limit) or `grep`.
 *
 * The budget scales with the active model's context window (about 5% of it,
 * 1.5k-6k tokens), so a 64k local model gets a tighter cap than a 200k one.
 * `read` results are not spilled (that would just read a file into a file);
 * they are cut to the budget with an offset to continue from.
 *
 * PI_OUTPUT_GUARD_CHARS=<n> fixes the budget in characters.
 * /output-guard [on|off|status] toggles it for the session (no argument flips it).
 * PI_OUTPUT_GUARD=off starts the session with it off.
 * To remove: delete this directory and /reload.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CHARS_PER_TOKEN = 3.5;
const WINDOW_RATIO = 0.05;
const MIN_TOKENS = 1500;
const MAX_TOKENS = 6000;
const DEFAULT_WINDOW = 32768;
const FOLD_WIDTH = 300;
const MAX_PREVIEW_CHARS = 4000;
const PAGE_LINES = 150;
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

const STATUS_KEY = "output-guard";
const spillDir = join(tmpdir(), "pi-output-guard");

function budgetChars(contextWindow: number | undefined): number {
	const override = Number(process.env.PI_OUTPUT_GUARD_CHARS);
	if (Number.isFinite(override) && override > 0) return override;
	const tokens = Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, (contextWindow || DEFAULT_WINDOW) * WINDOW_RATIO));
	return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Hard-wrap very long lines so line-based paging (read offset/limit) stays bounded. */
function fold(text: string): string {
	if (!text.split("\n").some((l) => l.length > FOLD_WIDTH * 1.5)) return text;
	return text
		.split("\n")
		.map((l) => {
			if (l.length <= FOLD_WIDTH * 1.5) return l;
			const parts: string[] = [];
			for (let i = 0; i < l.length; i += FOLD_WIDTH) parts.push(l.slice(i, i + FOLD_WIDTH));
			return parts.join("\n");
		})
		.join("\n");
}

function takeHead(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const cut = text.slice(0, chars);
	const nl = cut.lastIndexOf("\n");
	return nl > chars * 0.5 ? cut.slice(0, nl) : cut;
}

function takeTail(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const cut = text.slice(text.length - chars);
	const nl = cut.indexOf("\n");
	return nl >= 0 && nl < chars * 0.5 ? cut.slice(nl + 1) : cut;
}

function countLines(text: string): number {
	let n = 1;
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

function kb(chars: number): string {
	return chars < 1024 ? `${chars}B` : `${(chars / 1024).toFixed(1)}KB`;
}

function cleanup(): void {
	try {
		const now = Date.now();
		for (const name of readdirSync(spillDir)) {
			const p = join(spillDir, name);
			if (now - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { force: true });
		}
	} catch {}
}

function spill(toolName: string, toolCallId: string, text: string): string | undefined {
	try {
		mkdirSync(spillDir, { recursive: true, mode: 0o700 });
		const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-40);
		const file = join(spillDir, `${toolName.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}-${safeId}.txt`);
		writeFileSync(file, fold(text), { mode: 0o600 });
		return file;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let disabled = process.env.PI_OUTPUT_GUARD === "off";
	cleanup();

	pi.registerCommand("output-guard", {
		description: "Toggle output-guard (spill oversized tool output to a temp file). Args: on | off | status.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "status") {
				const budget = budgetChars(ctx.model?.contextWindow);
				ctx.ui.notify(`output-guard is ${disabled ? "OFF" : "on"} (cap ${kb(budget)} for this model).`, "info");
				return;
			}
			if (arg === "on") disabled = false;
			else if (arg === "off") disabled = true;
			else if (arg === "") disabled = !disabled;
			else {
				ctx.ui.notify("Usage: /output-guard [on|off|status]", "warning");
				return;
			}
			if (disabled) {
				const { theme } = ctx.ui;
				ctx.ui.setStatus(STATUS_KEY, theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ OG OFF "))));
				ctx.ui.notify("output-guard DISABLED: large tool output goes straight into context. Run /output-guard to re-enable.", "warning");
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("output-guard enabled.", "info");
			}
		},
	});

	pi.on("tool_result", (event, ctx) => {
		if (disabled) return;
		const blocks = event.content;
		if (!blocks.length || blocks.some((b) => b.type !== "text")) return;
		const text = blocks.map((b) => (b as { text: string }).text).join("\n");

		const budget = budgetChars(ctx.model?.contextWindow);
		if (text.length <= budget) return;

		const totalLines = countLines(text);

		// read: cut to the budget and say where to continue.
		if (event.toolName === "read") {
			const head = takeHead(text, budget);
			const kept = countLines(head);
			const input = event.input as { offset?: number };
			const next = (input.offset && input.offset > 0 ? input.offset : 1) + kept;
			return {
				content: [
					{
						type: "text",
						text:
							`${head}\n\n[Cut to ${kb(head.length)} of ${kb(text.length)} to fit the context window. ` +
							`Continue with offset=${next} and a limit of at most ${PAGE_LINES} lines, or use grep to find what you need.]`,
					},
				],
			};
		}

		// Reuse the file bash already saved if it truncated; otherwise write our own.
		const existing = /Full output: (\/\S+?)\]/.exec(text)?.[1];
		const file = existing && existsSync(existing) ? existing : spill(event.toolName, event.toolCallId, text);
		if (!file) return;

		const previewChars = Math.min(MAX_PREVIEW_CHARS, Math.floor(budget / 2));
		const head = takeHead(text, Math.floor(previewChars * 0.65));
		const tail = takeTail(text, Math.floor(previewChars * 0.35));
		const omitted = text.length - head.length - tail.length;

		const note =
			`[Output too large for the context window: ${kb(text.length)}, ${totalLines} lines (~${Math.round(text.length / CHARS_PER_TOKEN)} tokens). ` +
			`Full output saved to ${file}. Do not cat it. Read it with the read tool using offset/limit ` +
			`(at most ${PAGE_LINES} lines at a time), or grep -n it for what you need.]`;

		return {
			content: [
				{
					type: "text",
					text: `${head}\n\n… [${kb(omitted)} omitted] …\n\n${tail}\n\n${note}`,
				},
			],
		};
	});
}
