/**
 * Rewind Extension — Claude Code's /rewind for pi.
 *
 * Every prompt is a checkpoint. Before the edit/write tools change a file for the first time
 * after a prompt, the file is snapshotted (see store.ts), so you can go back to the point
 * before any prompt you sent.
 *
 * Open the menu with /rewind (aliases /checkpoint, /undo) or Esc Esc with an empty editor
 * (Esc Esc with a draft clears the draft). Pick a prompt, then:
 *
 *   Restore code and conversation  revert files and go back to before the prompt
 *   Restore conversation           go back to before the prompt, keep the current files
 *   Restore code                   revert files, keep the conversation
 *   Summarize from here            replace the prompt and everything after it with a summary
 *   Summarize up to here           replace everything before the prompt with a summary
 *   Never mind                     back to the list
 *
 * The code options only appear when files changed since the prompt. Restoring the
 * conversation, or summarizing from here, puts the prompt back in the editor. The conversation
 * you leave stays reachable in /tree. Type after highlighting a Summarize option to give it
 * extra instructions.
 *
 * Only edit/write changes are tracked: files changed by bash, by other sessions, or by hand
 * are not, unless a tracked tool also touched them. Snapshots live in ~/.pi/agent/rewind,
 * survive /resume, are kept for the 100 most recent checkpoints, and expire 30 days after a
 * session last saved one.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CustomEditor,
	estimateTokens,
	generateSummaryWithUsage,
	getAgentDir,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { changesSince, ContentCache, restoreFiles } from "./changes.ts";
import { CheckpointStore, cleanupExpired } from "./store.ts";
import { plural, type RewindChoice, type RewindItem, showRewindMenu } from "./ui.ts";

/** Tools whose file changes are checkpointed (their input has a `path`). */
const TRACKED_TOOLS = new Set(["edit", "write"]);
const DOUBLE_ESCAPE_MS = 500;
/** Token budget reserved for the "Summarize up to here" summary (pi's compaction default). */
const SUMMARY_RESERVE_TOKENS = 16384;

export default function (pi: ExtensionAPI) {
	const root = path.join(getAgentDir(), "rewind");
	let store: CheckpointStore | undefined;
	let menuOpen = false;
	let stopListening: (() => void) | undefined;

	const storeFor = (ctx: ExtensionContext): CheckpointStore => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (store?.sessionId !== sessionId) store = new CheckpointStore(root, sessionId);
		return store;
	};

	pi.on("session_start", async (_event, ctx) => {
		store = undefined;
		cleanupExpired(root, ctx.sessionManager.getSessionId());
		if (ctx.mode === "tui") {
			stopListening?.();
			stopListening = listenForDoubleEscape(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		stopListening?.();
		stopListening = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		try {
			const file = (event.input as { path?: unknown }).path;
			if (typeof file !== "string" || !file) return;
			const prompt = latestPrompt(ctx.sessionManager.getBranch());
			if (!prompt) return;
			storeFor(ctx).capture(prompt.id, resolvePath(file, ctx.cwd));
		} catch {
			// A failed snapshot must never block the edit.
		}
	});

	const rewind = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/rewind needs the interactive terminal UI", "warning");
			return;
		}
		if (menuOpen) return;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Rewind will open when the current response finishes", "info");
			await ctx.waitForIdle();
		}

		const items = promptItems(ctx, storeFor(ctx));
		if (items.length === 0) {
			ctx.ui.notify("Nothing to rewind to yet", "info");
			return;
		}

		menuOpen = true;
		let choice: RewindChoice | undefined;
		try {
			choice = await showRewindMenu(ctx, items);
		} finally {
			menuOpen = false;
		}
		if (!choice) return;

		try {
			await apply(choice, ctx);
		} catch (error) {
			ctx.ui.setStatus("rewind", undefined);
			ctx.ui.notify(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const apply = async ({ item, action, instructions }: RewindChoice, ctx: ExtensionCommandContext) => {
		switch (action) {
			case "conversation":
				await ctx.navigateTree(item.entryId);
				return;
			case "both": {
				const { cancelled } = await ctx.navigateTree(item.entryId);
				if (!cancelled) restoreCode(item, ctx);
				return;
			}
			case "code":
				restoreCode(item, ctx);
				return;
			case "summarizeFrom":
				ctx.ui.setStatus("rewind", "Summarizing…");
				try {
					await ctx.navigateTree(item.entryId, { summarize: true, customInstructions: instructions });
				} finally {
					ctx.ui.setStatus("rewind", undefined);
				}
				return;
			case "summarizeUpTo":
				ctx.ui.setStatus("rewind", "Summarizing…");
				try {
					await summarizeUpTo(item.entryId, instructions, ctx);
				} finally {
					ctx.ui.setStatus("rewind", undefined);
				}
				ctx.ui.notify("Summarized conversation", "info");
				return;
		}
	};

	const restoreCode = (item: RewindItem, ctx: ExtensionCommandContext) => {
		const checkpoints = storeFor(ctx);
		const cache = new ContentCache(checkpoints);
		// Recompute: files may have changed while the menu was open.
		const changes = changesSince(checkpoints, cache, item.time, ctx.cwd);
		const result = restoreFiles(checkpoints, cache, changes);
		if (result.failed.length > 0) {
			ctx.ui.notify(`Restored ${plural(result.restored, "file")}, but failed on:\n${result.failed.join("\n")}`, "error");
		} else if (result.skipped > 0) {
			ctx.ui.notify(`Restored the code, but skipped ${plural(result.skipped, "file")}`, "warning");
		} else if (result.restored === 0) {
			ctx.ui.notify("No files were restored", "info");
		} else {
			ctx.ui.notify(`Restored the code (${plural(result.restored, "file")})`, "info");
		}
	};

	/** Esc Esc in the editor: open /rewind when it is empty, clear the draft otherwise. */
	const listenForDoubleEscape = (ctx: ExtensionContext): (() => void) => {
		// A widget factory runs synchronously, which hands us the TUI to check focus with.
		let tui: { hasOverlay(): boolean; requestRender(): void; getFocusedComponent?(): unknown } | undefined;
		ctx.ui.setWidget("rewind-probe", (instance) => {
			tui = instance;
			return { render: () => [], invalidate: () => {} };
		});
		ctx.ui.setWidget("rewind-probe", undefined);

		let lastEscape = 0;
		return ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) {
				lastEscape = 0;
				return undefined;
			}
			const editor = tui && !tui.hasOverlay() ? tui.getFocusedComponent?.() : undefined;
			if (menuOpen || !(editor instanceof CustomEditor) || !ctx.isIdle()) {
				lastEscape = 0;
				return undefined;
			}
			const now = Date.now();
			if (now - lastEscape > DOUBLE_ESCAPE_MS) {
				lastEscape = now;
				return undefined;
			}
			lastEscape = 0;

			const draft = editor.getText();
			if (draft.trim()) {
				editor.addToHistory(draft);
				editor.setText("");
				tui?.requestRender();
			} else {
				pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
			}
			return { consume: true };
		});
	};

	pi.registerCommand("rewind", {
		description: "Rewind the conversation and/or code to a previous point, or summarize from a selected message",
		handler: rewind,
	});
	pi.registerCommand("checkpoint", { description: "Alias for /rewind", handler: rewind });
	pi.registerCommand("undo", { description: "Alias for /rewind", handler: rewind });
}

/** The prompts on the current branch, oldest first, with the code changes made since each. */
function promptItems(ctx: ExtensionContext, checkpoints: CheckpointStore): RewindItem[] {
	const cache = new ContentCache(checkpoints);
	const items: RewindItem[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const time = Date.parse(entry.timestamp);
		items.push({
			entryId: entry.id,
			text: promptText(entry.message.content),
			time,
			changes: time <= checkpoints.prunedBefore ? undefined : changesSince(checkpoints, cache, time, ctx.cwd),
		});
	}
	return items;
}

/**
 * "Summarize up to here": a compaction whose kept tail starts at the selected prompt. Pi's own
 * /compact picks its cut point by token budget and refuses small sessions, so the entry is
 * appended directly and the leaf is re-entered through navigateTree, which rebuilds the model
 * context and the chat view.
 */
async function summarizeUpTo(targetId: string, instructions: string | undefined, ctx: ExtensionCommandContext) {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		appendCompaction?(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean, usage?: unknown): string;
		branch?(id: string): void;
	};
	if (typeof sessionManager.appendCompaction !== "function" || typeof sessionManager.branch !== "function") {
		throw new Error("this pi version does not allow extensions to append a compaction");
	}

	const entries = sessionManager.buildContextEntries();
	const index = entries.findIndex((entry) => entry.id === targetId);
	if (index < 0) throw new Error("this message is already part of a summary");
	const toMessages = (list: SessionEntry[]) =>
		list.flatMap(sessionEntryToContextMessages).filter((message) => (message.role as string) !== "system");
	const messages = toMessages(entries.slice(0, index));
	if (messages.length === 0) throw new Error("there is nothing before this message to summarize");

	const model = ctx.model;
	if (!model) throw new Error("no model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	// A null header value marks a header the provider config deletes.
	const headers = auth.headers
		? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
	const tokensBefore =
		ctx.getContextUsage()?.tokens ?? toMessages(entries).reduce((sum, message) => sum + estimateTokens(message), 0);

	const { text, usage } = await generateSummaryWithUsage(
		messages,
		requestModel,
		SUMMARY_RESERVE_TOKENS,
		auth.apiKey,
		headers,
		undefined,
		instructions,
		undefined,
		ctx.thinkingLevel,
		undefined,
		auth.env,
	);
	if (!text.trim()) throw new Error("the summary came back empty");

	const leafId = sessionManager.getLeafId();
	const compactionId = sessionManager.appendCompaction(text, targetId, tokensBefore, undefined, true, usage);
	if (leafId) sessionManager.branch(leafId);
	await ctx.navigateTree(compactionId);
}

function latestPrompt(branch: SessionEntry[]): SessionEntry | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") return entry;
	}
	return undefined;
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = content.map((part: { type?: string; text?: string }) =>
		part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[image]" : "",
	);
	return parts.filter(Boolean).join(" ");
}

/** Resolve a tool path the way pi's file tools do: strip a leading @, expand ~, relative to cwd. */
function resolvePath(file: string, cwd: string): string {
	let resolved = file.trim();
	if (resolved.startsWith("@")) resolved = resolved.slice(1);
	if (resolved === "~") resolved = os.homedir();
	else if (resolved.startsWith("~/")) resolved = path.join(os.homedir(), resolved.slice(2));
	return path.resolve(cwd, resolved);
}
