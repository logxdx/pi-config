/**
 * The rewind menu: a list of the prompts on the current branch, then a confirmation step with
 * the restore / summarize options.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type CodeChanges, describeChanges } from "./changes.ts";

export type RewindAction = "both" | "conversation" | "code" | "summarizeFrom" | "summarizeUpTo";

export interface RewindItem {
	entryId: string;
	text: string;
	/** When the prompt was sent (ms). */
	time: number;
	/** Code changes since this prompt; undefined when its checkpoint has expired. */
	changes: CodeChanges | undefined;
}

export interface RewindChoice {
	item: RewindItem;
	action: RewindAction;
	/** Optional extra instructions for the summarize actions. */
	instructions?: string;
}

interface MenuOption {
	action: RewindAction | "cancel";
	label: string;
	summarize?: boolean;
}

const MAX_VISIBLE_ITEMS = 8;
const MAX_PROMPT_LINES = 6;

export function showRewindMenu(ctx: ExtensionCommandContext, items: RewindItem[]): Promise<RewindChoice | undefined> {
	return ctx.ui.custom<RewindChoice | undefined>((tui, theme, _keybindings, done) => {
		let mode: "list" | "confirm" = "list";
		// items.length is the "(current)" row, selected by default.
		let listIndex = items.length;
		let options: MenuOption[] = [];
		let optionIndex = 0;
		const instructions = new Map<RewindAction, string>();
		let cached: { width: number; lines: string[] } | undefined;

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		const openConfirm = () => {
			options = menuOptions(items[listIndex]);
			optionIndex = 0;
			instructions.clear();
			mode = "confirm";
			refresh();
		};

		const choose = (index: number) => {
			const option = options[index];
			if (!option) return;
			if (option.action === "cancel") {
				mode = "list";
				refresh();
				return;
			}
			const extra = instructions.get(option.action)?.trim();
			done({ item: items[listIndex], action: option.action, instructions: option.summarize && extra ? extra : undefined });
		};

		const handleList = (data: string) => {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
			if (matchesKey(data, Key.up)) listIndex = Math.max(0, listIndex - 1);
			else if (matchesKey(data, Key.down)) listIndex = Math.min(items.length, listIndex + 1);
			else if (matchesKey(data, Key.pageUp)) listIndex = Math.max(0, listIndex - MAX_VISIBLE_ITEMS);
			else if (matchesKey(data, Key.pageDown)) listIndex = Math.min(items.length, listIndex + MAX_VISIBLE_ITEMS);
			else if (matchesKey(data, Key.home)) listIndex = 0;
			else if (matchesKey(data, Key.end)) listIndex = items.length;
			else if (matchesKey(data, Key.enter)) {
				if (listIndex === items.length) return done(undefined);
				return openConfirm();
			} else return;
			refresh();
		};

		const handleConfirm = (data: string) => {
			if (matchesKey(data, Key.ctrl("c"))) return done(undefined);
			if (matchesKey(data, Key.escape)) {
				mode = "list";
				return refresh();
			}
			if (matchesKey(data, Key.up)) {
				optionIndex = (optionIndex + options.length - 1) % options.length;
				return refresh();
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = (optionIndex + 1) % options.length;
				return refresh();
			}
			if (matchesKey(data, Key.enter)) return choose(optionIndex);

			// A highlighted summarize option takes typed text as optional instructions.
			const highlighted = options[optionIndex];
			if (highlighted?.summarize && highlighted.action !== "cancel") {
				const text = instructions.get(highlighted.action) ?? "";
				if (matchesKey(data, Key.backspace)) {
					instructions.set(highlighted.action, Array.from(text).slice(0, -1).join(""));
					return refresh();
				}
				const typed = printable(data);
				// With nothing typed yet, a digit still picks an option by number.
				if (typed !== undefined && !(text === "" && /^[1-9]$/.test(typed))) {
					instructions.set(highlighted.action, text + typed);
					return refresh();
				}
			}

			if (/^[1-9]$/.test(data)) {
				const index = Number(data) - 1;
				if (index < options.length) {
					optionIndex = index;
					choose(index);
				}
			}
		};

		const render = (width: number): string[] => {
			if (cached?.width === width) return cached.lines;
			const lines: string[] = [];
			const add = (text = "") => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(` ${theme.bold(theme.fg("accent", "Rewind"))}`);
			if (mode === "list") renderList(add);
			else renderConfirm(add, width);
			add(theme.fg("accent", "─".repeat(width)));

			cached = { width, lines };
			return lines;
		};

		const renderList = (add: (text?: string) => void) => {
			add(theme.fg("muted", " Restore the code and/or conversation to the point before…"));
			add();

			const total = items.length + 1;
			let start = Math.max(0, listIndex - Math.floor(MAX_VISIBLE_ITEMS / 2));
			start = Math.min(start, Math.max(0, total - MAX_VISIBLE_ITEMS));
			const end = Math.min(total, start + MAX_VISIBLE_ITEMS);

			if (start > 0) add(theme.fg("dim", `   ↑ ${start} more`));
			for (let i = start; i < end; i++) {
				const selected = i === listIndex;
				const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
				const style = (text: string) => (selected ? theme.fg("accent", text) : theme.fg("text", text));
				if (i === items.length) {
					add(prefix + style("(current)"));
					continue;
				}
				add(prefix + style(oneLine(items[i].text)));
				add(`     ${codeSummary(items[i], theme)}`);
			}
			if (end < total) add(theme.fg("dim", `   ↓ ${total - end} more`));

			add();
			add(theme.fg("dim", " Enter to select · ↑/↓ to navigate · Esc to exit"));
		};

		const renderConfirm = (add: (text?: string) => void, width: number) => {
			const item = items[listIndex];
			add(theme.fg("muted", " Confirm you want to restore to the point before you sent this message:"));
			add();

			const bar = theme.fg("dim", " │ ");
			const prompt = wrapTextWithAnsi(item.text.trim(), Math.max(10, width - 4));
			for (const line of prompt.slice(0, MAX_PROMPT_LINES)) add(bar + theme.fg("text", line));
			if (prompt.length > MAX_PROMPT_LINES) add(bar + theme.fg("dim", `… ${prompt.length - MAX_PROMPT_LINES} more lines`));
			add(bar + theme.fg("dim", `(${ago(item.time)})`));
			add();

			const highlighted = options[optionIndex];
			for (const line of consequences(item, highlighted?.action, theme)) add(` ${line}`);
			if (highlighted?.action !== "cancel") add();

			options.forEach((option, index) => {
				const selected = index === optionIndex;
				const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
				const label = `${index + 1}. ${option.label}`;
				let line = prefix + (selected ? theme.fg("accent", label) : theme.fg("text", label));
				if (option.summarize && option.action !== "cancel") {
					const text = instructions.get(option.action) ?? "";
					if (text) line += `  ${theme.fg(selected ? "text" : "dim", text)}${selected ? theme.fg("accent", "▏") : ""}`;
					else if (selected) line += `  ${theme.fg("dim", "add context (optional)")}`;
				}
				add(line);
			});

			add();
			add(theme.fg("dim", " Enter to confirm · Esc to go back"));
		};

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput: (data: string) => (mode === "list" ? handleList(data) : handleConfirm(data)),
		};
	});
}

function menuOptions(item: RewindItem): MenuOption[] {
	const hasCode = (item.changes?.files.length ?? 0) > 0;
	const options: MenuOption[] = [];
	if (hasCode) options.push({ action: "both", label: "Restore code and conversation" });
	options.push({ action: "conversation", label: "Restore conversation" });
	if (hasCode) options.push({ action: "code", label: "Restore code" });
	options.push({ action: "summarizeFrom", label: "Summarize from here", summarize: true });
	options.push({ action: "summarizeUpTo", label: "Summarize up to here", summarize: true });
	options.push({ action: "cancel", label: "Never mind" });
	return options;
}

function consequences(item: RewindItem, action: MenuOption["action"] | undefined, theme: Theme): string[] {
	if (!action || action === "cancel") return [];
	const lines: string[] = [];
	const conversation: Record<RewindAction, string> = {
		both: "The conversation will be forked.",
		conversation: "The conversation will be forked.",
		code: "The conversation will be unchanged.",
		summarizeFrom: "Messages from this point on will be summarized.",
		summarizeUpTo: "Messages before this point will be summarized.",
	};
	lines.push(theme.fg("text", conversation[action]));

	const changes = item.changes;
	if ((action === "both" || action === "code") && changes) {
		lines.push(theme.fg("text", `The code will be restored ${describeChanges(changes)}.`));
	} else {
		lines.push(theme.fg("text", "The code will be unchanged."));
	}
	if ((action === "both" || action === "code") && changes && changes.skipped.length > 0) {
		lines.push(theme.fg("warning", `${plural(changes.skipped.length, "file")} can't be restored (symlinks or hard links) and will be skipped.`));
	}
	if (!changes) lines.push(theme.fg("dim", "Code checkpoints for this message have expired."));
	return lines;
}

function codeSummary(item: RewindItem, theme: Theme): string {
	const changes = item.changes;
	if (!changes) return theme.fg("dim", "No code restore");
	if (changes.files.length === 0) return theme.fg("dim", "No code changes");
	const where = changes.files.length === 1 ? changes.files[0].display : `${changes.files.length} files changed`;
	return `${theme.fg("dim", where)} ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `-${changes.removed}`)}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim() || "(empty message)";
}

function printable(data: string): string | undefined {
	if (data.startsWith("\x1b[200~")) return data.replace(/\x1b\[20[01]~/g, "").replace(/\s+/g, " ");
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (!data || data.startsWith("\x1b")) return undefined;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return undefined;
	}
	return data;
}

function ago(time: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
