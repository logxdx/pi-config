/**
 * Trace Extension
 *
 * A compact transcript modelled on shadcn's Trace component
 * (https://ui.shadcn.com/docs/components/base/trace):
 *
 *   - every tool call is one line: icon, a sentence title whose tense carries
 *     the status ("Ran", "Running", "Failed to run"), and a dim description
 *     such as "+12 −3", "120 lines" or "4.2s";
 *   - a finished turn folds into one summary row ("Read 3 files, ran 2
 *     commands · 12s"); the turn that is running stays open;
 *   - thinking shows as "Thought for 4s".
 *
 * Every row expands on click (fullscreen mode). ctrl+o expands everything
 * (and resets rows you toggled), ctrl+t expands all thinking.
 *
 * PI_TRACE_ICONS=unicode swaps the Nerd Font icons for plain glyphs;
 * PI_TRACE_MOTION=off stops the spinner and shimmer.
 * To restore the stock transcript: rename/delete this directory and /reload.
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { TraceBody, TraceLine, type TraceStatus } from "./line.ts";
import { descriptionFor, isBuiltIn, styleFor, titleFor } from "./tools.ts";
import { createTranscript, installPatches, refreshAssistantMessages, setImpl } from "./transcript.ts";

interface RowState {
	line?: TraceLine;
	startedAt?: number;
	baseCall?: Component;
	baseResult?: Component;
}

export default function trace(pi: ExtensionAPI) {
	let ui: any;
	let busy = false;
	let ticker: ReturnType<typeof setInterval> | undefined;
	const thinking = new Map<number, Map<number, { start?: number; end?: number }>>();

	const transcript = createTranscript({
		theme: () => ui?.theme,
		toolsExpanded: () => ui?.getToolsExpanded?.() ?? false,
		busy: () => busy,
		thinkingTime: (timestamp, index) => thinking.get(timestamp)?.get(index),
	});

	// Patch at load so messages rendered before session_start are covered too.
	const patched = installPatches();
	if (patched) setImpl(transcript);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		if (!patched) {
			ctx.ui.notify("trace: pi internals changed; only tool rows are compact", "warning");
			return;
		}
		setImpl(transcript);
		refreshAssistantMessages();
	});

	pi.on("session_shutdown", async () => {
		setImpl(undefined);
		stopTicker();
	});

	// The spinner, shimmer and elapsed times are drawn at render time, so a
	// steady frame while the agent works is all the animation needs.
	pi.on("agent_start", async () => {
		busy = true;
		ticker ??= setInterval(() => transcript.tui?.requestRender?.(), 100);
		ticker.unref?.();
	});
	pi.on("agent_end", async () => {
		busy = false;
		stopTicker();
		transcript.tui?.requestRender?.();
	});

	function stopTicker() {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	pi.on("message_update", async (event) => {
		const e: any = event.assistantMessageEvent;
		if (e?.type !== "thinking_start" && e?.type !== "thinking_end") return;
		const key = e.partial?.timestamp;
		if (typeof key !== "number") return;
		let times = thinking.get(key);
		if (!times) {
			times = new Map();
			thinking.set(key, times);
			if (thinking.size > 500) thinking.delete(thinking.keys().next().value!);
		}
		const t = times.get(e.contentIndex) ?? {};
		if (e.type === "thinking_start") t.start = Date.now();
		else t.end = Date.now();
		times.set(e.contentIndex, t);
	});

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		return traceRenderers(toolName, base);
	});
}

function statusOf(ctx: any): TraceStatus {
	if (ctx.isError) return "error";
	if (!ctx.isPartial) return "done";
	return ctx.executionStarted ? "running" : "pending";
}

function traceRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	const style = styleFor(toolName);
	return {
		renderShell: "self",
		renderCall(args, theme, ctx) {
			const state = ctx.state as RowState;
			if (ctx.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
			const status = statusOf(ctx);
			// Rebuilt on every pass (pi calls renderCall then renderResult), so a theme change recolours it.
			state.line = new TraceLine(
				{
					icon: style.icon,
					title: titleFor(toolName, args, status, ctx.cwd),
					status,
					liveSince: status === "running" ? state.startedAt : undefined,
					expandable: false,
					open: ctx.expanded,
					pad: ctx.outputPad,
				},
				theme,
			);
			return state.line;
		},
		renderResult(result, options, theme, ctx) {
			const state = ctx.state as RowState;
			const status = statusOf(ctx);
			state.line?.set({
				description: descriptionFor(toolName, ctx.args, result, status, ctx.durationMs),
				expandable: !options.isPartial,
				open: options.expanded,
			});
			const live = options.isPartial && status === "running";
			if (!options.expanded && !live) return new Container();
			// The row already shows the duration; drop the shell renderer's own timer line.
			const drop = toolName === "bash" || toolName === "powershell" ? /^\s*(Took|Elapsed) [\d.]+/ : undefined;
			return new TraceBody(body(toolName, base, result, options, theme, ctx), theme, ctx.outputPad, drop);
		},
	};
}

/** What an open row shows: the diff, the file, or the tool's own result view. */
function body(
	toolName: string,
	base: ToolRenderers | undefined,
	result: any,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	ctx: any,
): Component {
	const state = ctx.state as RowState;
	const args = ctx.args ?? {};
	const out = new Container();

	if (!ctx.isError && toolName === "edit" && typeof result.details?.diff === "string") {
		out.addChild(new Text(renderDiff(result.details.diff, { filePath: args.path }), 0, 0));
		return out;
	}
	if (!ctx.isError && toolName === "write" && typeof args.content === "string") {
		const lang = typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined;
		out.addChild(new Text(highlightCode(args.content, lang).join("\n"), 0, 0));
		return out;
	}
	if ((toolName === "bash" || toolName === "powershell") && String(args.command ?? "").includes("\n")) {
		out.addChild(new Text(theme.fg("toolOutput", `$ ${String(args.command).trim()}`), 0, 0));
	}
	// Other extensions' tools: their call view carries what our generic title can't.
	if (!isBuiltIn(toolName) && base?.renderCall) {
		try {
			state.baseCall = base.renderCall(args, theme, { ...ctx, lastComponent: state.baseCall });
			out.addChild(state.baseCall);
		} catch {}
	}
	if (base?.renderResult) {
		try {
			state.baseResult = base.renderResult(result, options, theme, {
				...ctx,
				expanded: options.expanded,
				lastComponent: state.baseResult,
			});
			out.addChild(state.baseResult);
			return out;
		} catch {}
	}
	const text = (result.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n")
		.trim();
	if (text) out.addChild(new Text(theme.fg(ctx.isError ? "error" : "toolOutput", text), 0, 0));
	return out;
}
