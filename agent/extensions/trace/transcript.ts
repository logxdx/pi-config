/**
 * Transcript-level trace layout.
 *
 * pi has no hook for the chat layout or for thinking blocks, so this wraps a
 * few methods of classes pi exports (nothing on disk is touched):
 *
 *   - Container.render / handleMouse, but only for the chat container: the
 *     tool calls of a turn fold into one summary row ("Read 3 files, ran 2
 *     commands · 12s"); open, the steps sit indented behind a rule.
 *   - AssistantMessageComponent.updateContent: each thinking run becomes a
 *     "Thought for 4s" row that expands to the full text.
 *
 * Wrappers are installed once per process and call whatever implementation
 * the latest load of this extension registered, so /reload does not stack
 * them, and they fall back to stock rendering if anything throws.
 */

import {
	AssistantMessageComponent,
	SkillInvocationMessageComponent,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, MouseRegion, Spacer } from "@earendil-works/pi-tui";
import { formatDuration, ICONS, isBlank, TraceBody, TraceLine } from "./line.ts";
import { summarize } from "./tools.ts";

export interface TranscriptImpl {
	renderChat(container: any, width: number): string[];
	mouseChat(container: any, event: any): any;
	decorate(amc: any, message: any, isStreaming: boolean): void;
}

interface Registry {
	installed?: boolean;
	impl?: TranscriptImpl;
	chat?: WeakRef<any>;
}

const REGISTRY: Registry = ((globalThis as any)[Symbol.for("pi-trace")] ??= {});
const CHAT = Symbol.for("pi-trace.chat");
const LAYOUT = Symbol.for("pi-trace.layout");

function isTranscriptItem(c: unknown): boolean {
	return (
		c instanceof AssistantMessageComponent ||
		c instanceof ToolExecutionComponent ||
		c instanceof UserMessageComponent
	);
}

/** Wrap the pi classes once per process. False when pi's internals have changed shape. */
export function installPatches(): boolean {
	if (REGISTRY.installed) return true;
	const cproto = Container.prototype as any;
	const aproto = (AssistantMessageComponent as any)?.prototype;
	if (
		typeof cproto?.render !== "function" ||
		typeof cproto?.handleMouse !== "function" ||
		typeof cproto?.addChild !== "function" ||
		typeof aproto?.updateContent !== "function" ||
		typeof (ToolExecutionComponent as any)?.prototype?.render !== "function"
	) {
		return false;
	}
	const origAdd = cproto.addChild;
	const origRender = cproto.render;
	const origMouse = cproto.handleMouse;
	const origUpdate = aproto.updateContent;

	const mark = (container: any) => {
		container[CHAT] = true;
		REGISTRY.chat = new WeakRef(container);
	};

	cproto.addChild = function (this: any, child: unknown) {
		if (!this[CHAT] && isTranscriptItem(child)) mark(this);
		return origAdd.call(this, child);
	};
	cproto.render = function (this: any, width: number) {
		const impl = REGISTRY.impl;
		if (impl && !this[CHAT] && isTranscriptItem(this.children?.[this.children.length - 1])) mark(this);
		if (impl && this[CHAT]) {
			try {
				return impl.renderChat(this, width);
			} catch {
				this[LAYOUT] = undefined;
			}
		}
		return origRender.call(this, width);
	};
	cproto.handleMouse = function (this: any, event: any) {
		const impl = REGISTRY.impl;
		if (impl && this[CHAT] && this[LAYOUT]?.width === event.width) {
			try {
				return impl.mouseChat(this, event);
			} catch {}
		}
		return origMouse.call(this, event);
	};
	aproto.updateContent = function (this: any, message: any, isStreaming?: boolean) {
		origUpdate.call(this, message, isStreaming);
		const impl = REGISTRY.impl;
		if (!impl) return;
		try {
			impl.decorate(this, message, this.isStreaming);
		} catch {}
	};
	REGISTRY.installed = true;
	return true;
}

export function setImpl(impl: TranscriptImpl | undefined): void {
	REGISTRY.impl = impl;
}

export function getImpl(): TranscriptImpl | undefined {
	return REGISTRY.impl;
}

/** Re-run updateContent on assistant messages already on screen. */
export function refreshAssistantMessages(): void {
	const chat = REGISTRY.chat?.deref();
	for (const child of chat?.children ?? []) {
		if (child instanceof AssistantMessageComponent && (child as any).lastMessage) {
			(child as any).updateContent((child as any).lastMessage);
		}
	}
}

// ── implementation ─────────────────────────────────────────────────────────

type Kind = "user" | "step" | "tool" | "thinking" | "answer" | "spacer" | "other";

interface Run {
	start: number;
	end: number;
	members: any[];
	tools: any[];
}

type Segment =
	| { kind: "header"; y: number; key: string; open: boolean }
	| { kind: "child"; y: number; h: number; comp: any; skip: number; x: number; w: number; full: number };

export interface TranscriptHost {
	theme(): Theme | undefined;
	toolsExpanded(): boolean;
	busy(): boolean;
	/** Start/end times of thinking blocks, keyed by message timestamp then content index. */
	thinkingTime(timestamp: number, index: number): { start?: number; end?: number } | undefined;
}

export function createTranscript(host: TranscriptHost): TranscriptImpl & { tui?: any } {
	const overrides = new Map<string, boolean>();
	let lastGlobal = false;
	const self: TranscriptImpl & { tui?: any } = {
		renderChat,
		mouseChat,
		decorate,
	};

	function classify(c: any): Kind {
		if (c instanceof ToolExecutionComponent) return "tool";
		if (c instanceof AssistantMessageComponent) {
			const content: any[] = (c as any).lastMessage?.content ?? [];
			if (content.some((b) => b.type === "toolCall")) return "step";
			const hasText = content.some((b) => b.type === "text" && b.text?.trim());
			if ((c as any).isStreaming && !hasText) return "thinking";
			return "answer";
		}
		if (c instanceof Spacer) return "spacer";
		if (c instanceof UserMessageComponent || c instanceof SkillInvocationMessageComponent) return "user";
		return "other";
	}

	function findRuns(kids: any[]): Run[] {
		const runs: Run[] = [];
		const kinds = kids.map(classify);
		for (let i = 0; i < kids.length; i++) {
			if (kinds[i] !== "step" && kinds[i] !== "tool") continue;
			let last = i;
			let j = i;
			for (; j < kids.length; j++) {
				const k = kinds[j];
				if (k === "spacer") continue;
				if (k !== "step" && k !== "tool" && k !== "thinking") break;
				last = j;
			}
			const members: any[] = [];
			for (let m = i; m <= last; m++) if (kinds[m] !== "spacer") members.push(kids[m]);
			const tools = members.filter((m) => m instanceof ToolExecutionComponent && !m.hideComponent);
			if (tools.length > 0) runs.push({ start: i, end: last + 1, members, tools });
			i = last;
		}
		return runs;
	}

	function runTiming(run: Run): { start?: number; ms?: number } {
		let start: number | undefined;
		let cursor: number | undefined;
		for (const m of run.members) {
			if (m instanceof AssistantMessageComponent) {
				const msg = (m as any).lastMessage;
				if (typeof msg?.timestamp !== "number") continue;
				start ??= msg.timestamp;
				cursor = Math.max(cursor ?? 0, msg.timestamp + (msg.durationMs ?? 0));
			} else if (cursor !== undefined) {
				const r = m.result;
				cursor += r?.durationMs ?? 0;
				if (typeof r?.timestamp === "number") cursor = Math.max(cursor, r.timestamp);
			}
		}
		return { start, ms: start !== undefined && cursor !== undefined ? cursor - start : undefined };
	}

	function renderChat(container: any, width: number): string[] {
		const theme = host.theme();
		const kids: any[] = container.children;
		if (!theme) throw new Error("no theme yet");

		const global = host.toolsExpanded();
		if (global !== lastGlobal) {
			overrides.clear();
			lastGlobal = global;
		}

		const runs = findRuns(kids);
		const busy = host.busy();
		const out: string[] = [];
		const segs: Segment[] = [];
		let r = 0;
		let afterRun = false;

		for (let i = 0; i < kids.length; ) {
			const run = runs[r];
			if (run && i === run.start) {
				// Only the newest turn can still be running; a later user message means it ended.
				const ended = r < runs.length - 1 || kids.slice(run.end).some((k) => classify(k) === "user");
				renderRun(run, !ended);
				i = run.end;
				r++;
				afterRun = true;
				continue;
			}
			const child = kids[i++];
			const lines: string[] = child.render(width);
			// A reply that opens with thinking sits right under the turn row, as
			// adjacent rows do in a Trace list.
			let skip = 0;
			if (afterRun && child instanceof AssistantMessageComponent && !startsWithText(child)) {
				while (skip < lines.length && isBlank(lines[skip]!)) skip++;
			}
			if (lines.length > skip) {
				segs.push({ kind: "child", y: out.length, h: lines.length - skip, comp: child, skip, x: 0, w: width, full: lines.length });
				afterRun = false;
			}
			for (let l = skip; l < lines.length; l++) out.push(lines[l]!);
		}

		container[LAYOUT] = { width, segs };
		return out;

		function renderRun(run: Run, current: boolean) {
			const first = run.tools[0];
			self.tui ??= first.ui;
			const key: string = first.toolCallId;
			const live = busy && (current || run.tools.some((t) => t.isPartial));
			const open = overrides.get(key) ?? (live || global);
			const pad = first.outputPad ?? 1;
			const timing = runTiming(run);

			const failed = run.tools.filter((t) => t.result?.isError).length;
			const header = live
				? new TraceLine(
						{ icon: ICONS.turn, title: "Working", status: "running", liveSince: timing.start, expandable: true, open, pad },
						theme!,
					)
				: new TraceLine(
						{
							icon: ICONS.turn,
							title: summarize(run.tools.map((t) => ({ toolName: t.toolName, args: t.args }))),
							alert: failed ? `${failed} failed` : undefined,
							description: formatDuration(timing.ms),
							status: "done",
							expandable: true,
							open,
							pad,
						},
						theme!,
					);

			if (out.length && !isBlank(out[out.length - 1]!)) out.push("");
			segs.push({ kind: "header", y: out.length, key, open });
			out.push(...header.render(width));
			if (!open) return;

			const rule = " ".repeat(pad) + theme!.fg("borderMuted", "│");
			const inner = Math.max(1, width - pad - 1);
			let prevText = false;
			let any = false;
			for (const m of run.members) {
				const lines: string[] = m.render(inner);
				let skip = 0;
				while (skip < lines.length && isBlank(lines[skip]!)) skip++;
				let end = lines.length;
				while (end > skip && isBlank(lines[end - 1]!)) end--;
				if (end === skip) continue;
				const isText = m instanceof AssistantMessageComponent && startsWithText(m);
				const endsText = m instanceof AssistantMessageComponent && endsWithText(m);
				if (any && (isText || prevText)) out.push(rule);
				segs.push({ kind: "child", y: out.length, h: end - skip, comp: m, skip, x: pad + 1, w: inner, full: lines.length });
				for (let l = skip; l < end; l++) out.push(rule + lines[l]);
				prevText = endsText;
				any = true;
			}
		}
	}

	function mouseChat(container: any, event: any): any {
		const layout = container[LAYOUT];
		for (const seg of layout.segs as Segment[]) {
			if (seg.kind === "header") {
				if (event.y !== seg.y) continue;
				if (event.type !== "click" || event.button !== "left") return undefined;
				overrides.set(seg.key, !seg.open);
				self.tui?.requestRender?.();
				return { handled: true };
			}
			if (event.y < seg.y || event.y >= seg.y + seg.h) continue;
			return seg.comp.handleMouse?.({
				...event,
				x: event.x - seg.x,
				y: event.y - seg.y + seg.skip,
				width: seg.w,
				height: seg.full,
			});
		}
		return undefined;
	}

	function decorate(amc: any, message: any, isStreaming: boolean): void {
		const theme = host.theme();
		if (!theme || !message?.content) return;
		const regions = (amc.contentContainer?.children ?? []).filter((c: unknown) => c instanceof MouseRegion);
		const runs = thinkingRuns(message.content);
		if (regions.length !== runs.length) return;
		const pad = amc.outputPad ?? 1;

		regions.forEach((region: any, i: number) => {
			const run = runs[i]!;
			const hidden: boolean = amc.thinkingVisibilityOverrides?.get(i) ?? amc.hideThinkingBlock;
			const live = isStreaming && run.last === message.content.length - 1;
			const start = host.thinkingTime(message.timestamp, run.first)?.start;
			const end = host.thinkingTime(message.timestamp, run.last)?.end;
			const ms = start !== undefined && end !== undefined ? end - start : undefined;
			const line = new TraceLine(
				{
					icon: ICONS.thinking,
					title: live ? "Thinking" : ms !== undefined ? `Thought for ${formatDuration(ms)}` : "Thought",
					status: live ? "running" : "done",
					liveSince: live ? start : undefined,
					expandable: true,
					open: !hidden,
					pad,
				},
				theme,
			);
			if (hidden) {
				region.child = line;
			} else {
				const stack = new Container();
				stack.addChild(line);
				stack.addChild(new TraceBody(region.child as Component, theme, pad));
				region.child = stack;
			}
		});
	}

	return self;
}

/** Runs of consecutive thinking blocks with text, as AssistantMessageComponent groups them. */
function thinkingRuns(content: any[]): Array<{ first: number; last: number }> {
	const runs: Array<{ first: number; last: number }> = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		const first = i;
		let hasText = false;
		while (i < content.length && content[i]?.type === "thinking") {
			if (content[i].thinking?.trim()) hasText = true;
			i++;
		}
		i--;
		if (hasText) runs.push({ first, last: i });
	}
	return runs;
}

function visibleBlocks(amc: any): any[] {
	return ((amc.lastMessage?.content ?? []) as any[]).filter(
		(b) => (b.type === "text" && b.text?.trim()) || (b.type === "thinking" && b.thinking?.trim()),
	);
}

function startsWithText(amc: any): boolean {
	return visibleBlocks(amc)[0]?.type === "text";
}

function endsWithText(amc: any): boolean {
	return visibleBlocks(amc).at(-1)?.type === "text";
}
