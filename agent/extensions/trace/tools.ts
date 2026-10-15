/**
 * How each tool reads as a trace row: an icon, a sentence title whose tense
 * carries the status ("Ran", "Running", "Failed to run", "Run"), and a short
 * description such as a line count, diff stat or duration.
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import { formatDuration, ICONS, type TraceStatus } from "./line.ts";

export type Category = "read" | "search" | "command" | "edit" | "fetch" | "subagent" | "tool";

interface Verb {
	past: string;
	present: string;
	base: string;
}

interface ToolStyle {
	icon: string;
	verb: Verb;
	category: Category;
	object(args: any, cwd: string): string;
}

const v = (past: string, present: string, base: string): Verb => ({ past, present, base });

const STYLES: Record<string, ToolStyle> = {
	read: {
		icon: ICONS.read,
		verb: v("Read", "Reading", "read"),
		category: "read",
		object: (a, cwd) => shortPath(a?.path ?? a?.file_path, cwd),
	},
	bash: {
		icon: ICONS.terminal,
		verb: v("Ran", "Running", "run"),
		category: "command",
		object: (a) => commandLine(a?.command),
	},
	powershell: {
		icon: ICONS.terminal,
		verb: v("Ran", "Running", "run"),
		category: "command",
		object: (a) => commandLine(a?.command),
	},
	edit: {
		icon: ICONS.edit,
		verb: v("Edited", "Editing", "edit"),
		category: "edit",
		object: (a, cwd) => shortPath(a?.path ?? a?.file_path, cwd),
	},
	write: {
		icon: ICONS.write,
		verb: v("Wrote", "Writing", "write"),
		category: "edit",
		object: (a, cwd) => shortPath(a?.path ?? a?.file_path, cwd),
	},
	grep: {
		icon: ICONS.search,
		verb: v("Searched for", "Searching for", "search for"),
		category: "search",
		object: (a, cwd) => withPlace(str(a?.pattern), a?.path, cwd),
	},
	find: {
		icon: ICONS.search,
		verb: v("Found files matching", "Finding files matching", "find files matching"),
		category: "search",
		object: (a, cwd) => withPlace(str(a?.pattern), a?.path, cwd),
	},
	ls: {
		icon: ICONS.list,
		verb: v("Listed", "Listing", "list"),
		category: "search",
		object: (a, cwd) => shortPath(a?.path || ".", cwd),
	},
	web_search: {
		icon: ICONS.web,
		verb: v("Searched the web for", "Searching the web for", "search the web for"),
		category: "search",
		object: (a) => str(a?.query),
	},
	web_fetch: {
		icon: ICONS.link,
		verb: v("Fetched", "Fetching", "fetch"),
		category: "fetch",
		object: (a) => str(a?.url).replace(/^https?:\/\/(www\.)?/, ""),
	},
	subagent: {
		icon: ICONS.agent,
		verb: v("Ran subagent", "Running subagent", "run subagent"),
		category: "subagent",
		object: (a) => str(a?.name) || str(a?.agent),
	},
	subagent_message: {
		icon: ICONS.agent,
		verb: v("Messaged subagent", "Messaging subagent", "message subagent"),
		category: "subagent",
		object: (a) => str(a?.name) || str(a?.id) || str(a?.to),
	},
	subagents_list: {
		icon: ICONS.agent,
		verb: v("Listed subagents", "Listing subagents", "list subagents"),
		category: "subagent",
		object: () => "",
	},
};

function genericStyle(toolName: string): ToolStyle {
	return {
		icon: ICONS.tool,
		verb: v(`Used ${toolName}`, `Using ${toolName}`, `use ${toolName}`),
		category: "tool",
		object: (a) => firstStringArg(a),
	};
}

export function styleFor(toolName: string): ToolStyle {
	return STYLES[toolName] ?? genericStyle(toolName);
}

export function isBuiltIn(toolName: string): boolean {
	return ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(toolName);
}

export function titleFor(toolName: string, args: any, status: TraceStatus, cwd: string): string {
	const style = styleFor(toolName);
	const object = style.object(args, cwd);
	const verb =
		status === "running"
			? style.verb.present
			: status === "error"
				? `Failed to ${style.verb.base}`
				: status === "pending"
					? capitalize(style.verb.base)
					: style.verb.past;
	return object ? `${verb} ${object}` : verb;
}

export interface ResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: any;
}

/** The dim text after the title: counts, diff stats, durations, exit codes. */
export function descriptionFor(
	toolName: string,
	args: any,
	result: ResultLike | undefined,
	status: TraceStatus,
	durationMs: number | undefined,
): string | undefined {
	const duration = formatDuration(durationMs);
	if (status === "running") return duration;
	if (!result) return undefined;
	const text = textOf(result);

	if (status === "error") {
		const code = text.match(/exit(?:ed with)? code (\d+)/i)?.[1];
		if (code) return [`exit ${code}`, duration].filter(Boolean).join(" · ");
		const first = text.split("\n").find((l) => l.trim()) ?? "";
		return first.length > 60 ? `${first.slice(0, 59)}…` : first || undefined;
	}

	switch (toolName) {
		case "read": {
			const offset = Number(args?.offset);
			const n = countLines(text);
			if (Number.isFinite(offset) && offset > 0) return `L${offset}–${offset + n - 1}`;
			return plural(n, "line");
		}
		case "edit": {
			const diff: string = result.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const line of diff.split("\n")) {
				if (/^\+\s*\d/.test(line)) add++;
				else if (/^-\s*\d/.test(line)) del++;
			}
			return add || del ? `+${add} −${del}` : undefined;
		}
		case "write":
			return typeof args?.content === "string" ? plural(countLines(args.content), "line") : undefined;
		case "grep":
		case "find":
		case "ls": {
			if (/^no (matches|files)|^\(empty/i.test(text.trim())) return "no results";
			const n = text.split("\n").filter((l) => l.trim() && !/^\[.*\]$/.test(l.trim())).length;
			return toolName === "ls" ? plural(n, "entry", "entries") : plural(n, "result");
		}
		default:
			return durationMs !== undefined && durationMs >= 1000 ? duration : undefined;
	}
}

const ORDER: Category[] = ["read", "search", "fetch", "edit", "command", "subagent", "tool"];

/** "Read 3 files, ran 2 commands" for a folded turn. */
export function summarize(rows: Array<{ toolName: string; args: any }>): string {
	const counts = new Map<Category, number>();
	const files = new Map<Category, Set<string>>();
	for (const row of rows) {
		const category = styleFor(row.toolName).category;
		counts.set(category, (counts.get(category) ?? 0) + 1);
		const path = row.args?.path ?? row.args?.file_path;
		if (typeof path === "string") {
			if (!files.has(category)) files.set(category, new Set());
			files.get(category)!.add(path);
		}
	}
	const phrases: string[] = [];
	for (const category of ORDER) {
		const n = counts.get(category);
		if (!n) continue;
		const distinct = files.get(category)?.size || n;
		switch (category) {
			case "read":
				phrases.push(`read ${plural(distinct, "file")}`);
				break;
			case "search":
				phrases.push(`ran ${plural(n, "search", "searches")}`);
				break;
			case "command":
				phrases.push(`ran ${plural(n, "command")}`);
				break;
			case "edit":
				phrases.push(`edited ${plural(distinct, "file")}`);
				break;
			case "fetch":
				phrases.push(`fetched ${plural(n, "page")}`);
				break;
			case "subagent":
				phrases.push(`used ${plural(n, "subagent")}`);
				break;
			default:
				phrases.push(`made ${plural(n, "tool call")}`);
		}
	}
	return capitalize(phrases.join(", "));
}

// ── helpers ────────────────────────────────────────────────────────────────

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function capitalize(s: string): string {
	return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.replace(/\n$/, "").split("\n").length;
}

function textOf(result: ResultLike): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function commandLine(command: unknown): string {
	const lines = str(command).trim().split("\n");
	const first = lines[0]?.replace(/\s+/g, " ").trim() ?? "";
	return lines.length > 1 ? `${first} …` : first;
}

export function shortPath(path: unknown, cwd: string): string {
	const p = str(path);
	if (!p) return "";
	if (p.startsWith("/")) {
		const rel = relative(cwd, p);
		if (rel && !rel.startsWith("..")) return rel;
		const home = homedir();
		if (p === home || p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
	}
	return p;
}

function withPlace(pattern: string, path: unknown, cwd: string): string {
	const place = shortPath(path, cwd);
	return place && place !== "." ? `${pattern} in ${place}` : pattern;
}

function firstStringArg(args: any): string {
	if (!args || typeof args !== "object") return "";
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim()) {
			const line = value.trim().split("\n")[0]!;
			return line.length > 80 ? `${line.slice(0, 79)}…` : line;
		}
	}
	return "";
}
