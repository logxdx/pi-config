/**
 * Session Namer
 *
 * Names unnamed sessions from the first user message, trying in order:
 *   1. the cheapest OpenRouter models (free ones first; at least one paid model is
 *      always tried because free models are often rate-limited)
 *   2. a local model (the current one if it is local, otherwise the first local one)
 *   3. the first message itself, trimmed to a title
 *
 * Runs in the background and never blocks the prompt. Skips subagents (their parent
 * names them), print/JSON mode, and sessions that already have a name, including
 * one set with /name while a title was being generated.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model } from "@mariozechner/pi-ai";

const REMOTE_PROVIDER = "openrouter";
const MAX_REMOTE_ATTEMPTS = 3;
const REMOTE_TIMEOUT_MS = 15000;
// Covers a local model swap-in on llama-swap style servers.
const LOCAL_TIMEOUT_MS = 90000;
const MAX_INPUT_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

const SYSTEM_PROMPT =
	"You name chat sessions. Given the user's first message, reply with a short title of 3 to 6 words " +
	"that says what the session is about. Reply with the title only: plain text, no quotes, no trailing punctuation.";

type TextBlock = { type?: string; text?: string };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: TextBlock) => b?.type === "text" && typeof b.text === "string")
		.map((b: TextBlock) => b.text)
		.join("\n");
}

function firstUserText(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = textOf(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function cleanTitle(raw: string): string {
	const line = raw
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean) ?? "";
	let title = line
		.replace(/^(session\s+)?(title|name)\s*:\s*/i, "")
		.replace(/[*_`#]/g, "")
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/[.!?,;:]+$/, "")
		.trim();
	if (title.length > MAX_TITLE_CHARS) {
		const cut = title.slice(0, MAX_TITLE_CHARS);
		const space = cut.lastIndexOf(" ");
		title = `${space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut}…`;
	}
	return title;
}

function isLocal(model: Model<Api> | undefined): boolean {
	if (!model?.baseUrl) return false;
	try {
		const host = new URL(model.baseUrl).hostname.replace(/^\[|\]$/g, "");
		return host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.");
	} catch {
		return false;
	}
}

// Router, alias (~) and batch entries list a zero or misleading price, or answer asynchronously.
function isRealRemoteModel(model: Model<Api>): boolean {
	const id = model.id;
	return (
		model.provider === REMOTE_PROVIDER &&
		model.input.includes("text") &&
		!id.startsWith("openrouter/") &&
		!id.startsWith("~") &&
		!id.endsWith(":batch") &&
		!/router/i.test(id)
	);
}

function price(model: Model<Api>): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

function remoteCandidates(ctx: ExtensionContext): Model<Api>[] {
	const sorted = ctx.modelRegistry
		.getAvailable()
		.filter(isRealRemoteModel)
		.sort((a, b) => price(a) - price(b) || Number(a.reasoning) - Number(b.reasoning) || a.id.localeCompare(b.id));
	const picks = sorted.slice(0, MAX_REMOTE_ATTEMPTS);
	if (!picks.some((m) => price(m) > 0)) {
		const paid = sorted.find((m) => price(m) > 0);
		if (paid) picks.push(paid);
	}
	return picks;
}

function localCandidate(ctx: ExtensionContext): Model<Api> | undefined {
	if (isLocal(ctx.model)) return ctx.model;
	return ctx.modelRegistry.getAvailable().find(isLocal);
}

async function generateTitle(ctx: ExtensionContext, model: Model<Api>, text: string, timeoutMs: number): Promise<string> {
	const response = await ctx.modelRegistry
		.streamSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `<message>\n${text.slice(0, MAX_INPUT_CHARS)}\n</message>` }],
						timestamp: Date.now(),
					},
				],
			},
			{
				reasoning: clampThinkingLevel(model, "off"),
				maxTokens: 200,
				cacheRetention: "none",
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || response.stopReason);
	}
	const title = cleanTitle(textOf(response.content));
	if (!title) throw new Error("empty title");
	return title;
}

async function tryModels(ctx: ExtensionContext, models: Model<Api>[], text: string, timeoutMs: number) {
	for (const model of models) {
		try {
			return await generateTitle(ctx, model, text, timeoutMs);
		} catch {
			// Fall through to the next candidate.
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Subagent sessions are named by the parent that spawned them.
	if (process.env.PI_SUBAGENT_NAME) return;

	let generation = 0; // bumped on every session switch so late titles are dropped
	let attempted = false;
	let agentRunning = false;
	let deferredLocal: string | undefined;

	const apply = (gen: number, title: string) => {
		if (gen !== generation || pi.getSessionName()) return;
		pi.setSessionName(title);
	};

	const runLocal = async (ctx: ExtensionContext, gen: number, text: string) => {
		const local = localCandidate(ctx);
		const title = local ? await tryModels(ctx, [local], text, LOCAL_TIMEOUT_MS) : undefined;
		apply(gen, title ?? cleanTitle(text));
	};

	const nameSession = async (ctx: ExtensionContext, gen: number, text: string) => {
		const title = await tryModels(ctx, remoteCandidates(ctx), text, REMOTE_TIMEOUT_MS);
		if (title) return apply(gen, title);
		if (gen !== generation || pi.getSessionName()) return;
		// A local model that is busy with this run would queue the title behind it; wait for the run to end.
		if (agentRunning && isLocal(ctx.model)) {
			deferredLocal = text;
			return;
		}
		await runLocal(ctx, gen, text);
	};

	pi.on("session_start", () => {
		generation++;
		attempted = false;
		agentRunning = false;
		deferredLocal = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		agentRunning = true;
		if (attempted || !ctx.hasUI || event.messageType !== "user" || pi.getSessionName()) return;
		const text = firstUserText(ctx) ?? event.prompt.trim();
		if (!text) return;
		attempted = true;
		void nameSession(ctx, generation, text).catch(() => {});
	});

	pi.on("agent_end", (_event, ctx) => {
		agentRunning = false;
		if (deferredLocal === undefined) return;
		const text = deferredLocal;
		deferredLocal = undefined;
		void runLocal(ctx, generation, text).catch(() => {});
	});
}
