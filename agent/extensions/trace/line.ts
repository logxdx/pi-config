/**
 * TraceLine: one row of the trace. Icon, title, optional description and a
 * chevron when the row can expand. Mirrors shadcn's TraceLine/TraceIcon/
 * TraceTitle/TraceDescription.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type TraceStatus = "done" | "running" | "error" | "pending";

// Codicons from Nerd Fonts. PI_TRACE_ICONS=unicode swaps in plain glyphs for
// terminals without a patched font.
const NERD = process.env.PI_TRACE_ICONS !== "unicode";

export const ICONS = NERD
	? {
			read: "",
			search: "",
			list: "",
			terminal: "",
			edit: "",
			write: "",
			web: "",
			link: "",
			agent: "",
			thinking: "",
			tool: "",
			error: "",
			pending: "○",
			turn: "",
			open: "",
			closed: "",
		}
	: {
			read: "≡",
			search: "⌕",
			list: "▤",
			terminal: "$",
			edit: "✎",
			write: "+",
			web: "◎",
			link: "↗",
			agent: "◆",
			thinking: "✻",
			tool: "⚙",
			error: "✕",
			pending: "○",
			turn: "✓",
			open: "▾",
			closed: "▸",
		};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animate only when the user has not asked for reduced motion. */
const MOTION = process.env.PI_TRACE_MOTION !== "off";

export interface TraceLineProps {
	icon: string;
	title: string;
	description?: string;
	/** Short red note before the description, e.g. "1 failed". */
	alert?: string;
	/** While running, show the time elapsed since this epoch-ms instead of `description`. */
	liveSince?: number;
	status?: TraceStatus;
	/** Show a chevron; `open` picks which way it points. */
	expandable?: boolean;
	open?: boolean;
	pad?: number;
}

export function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A bright band sweeping across muted text, like shadcn's title shimmer. */
function shimmer(text: string, theme: Theme): string {
	if (!MOTION) return theme.fg("muted", text);
	const chars = Array.from(text);
	const band = 4;
	const span = chars.length + band * 2;
	const pos = Math.floor(Date.now() / 70) % span - band;
	let out = "";
	for (let i = 0; i < chars.length; i++) {
		const d = Math.abs(i - pos);
		out += theme.fg(d <= 1 ? "text" : d <= band ? "toolOutput" : "muted", chars[i]!);
	}
	return out;
}

export class TraceLine implements Component {
	constructor(
		public props: TraceLineProps,
		private theme: Theme,
	) {}

	set(props: Partial<TraceLineProps>): this {
		Object.assign(this.props, props);
		return this;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const { title, expandable, open, liveSince } = this.props;
		const status = this.props.status ?? "done";
		const description =
			status === "running" && liveSince !== undefined
				? formatDuration(Date.now() - liveSince)
				: this.props.description;
		const pad = " ".repeat(this.props.pad ?? 1);

		const color = status === "error" ? "error" : status === "pending" ? "dim" : "muted";
		const glyph =
			status === "running" && MOTION
				? SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!
				: status === "error"
					? ICONS.error
					: status === "pending"
						? ICONS.pending
						: this.props.icon;
		const icon = theme.fg(status === "running" ? "accent" : color === "muted" ? "dim" : color, glyph);

		const maxDesc = Math.max(8, Math.floor(width * 0.35));
		const desc = description ? `  ${truncateToWidth(description, maxDesc, "…")}` : "";
		const alert = this.props.alert ? `  ${this.props.alert}` : "";
		const chevron = expandable ? ` ${open ? ICONS.open : ICONS.closed}` : "";
		const fixed = visibleWidth(pad) + 2 + visibleWidth(alert) + visibleWidth(desc) + visibleWidth(chevron);
		const plain = truncateToWidth(title.replace(/\s+/g, " ").trim(), Math.max(1, width - fixed), "…");
		const styled = status === "running" ? shimmer(plain, theme) : theme.fg(color, plain);

		const line =
			pad +
			icon +
			" " +
			styled +
			(alert ? theme.fg("error", alert) : "") +
			(desc ? theme.fg(status === "error" ? "error" : "dim", desc) : "") +
			(chevron ? theme.fg(status === "error" ? "error" : "dim", chevron) : "");
		return [truncateToWidth(line, width)];
	}
}

/**
 * Content under an open row: indented behind a left rule that sits under the
 * row's icon (shadcn's TraceCollapsibleContent).
 */
export class TraceBody implements Component {
	constructor(
		public child: Component,
		private theme: Theme,
		private pad = 1,
		/** Lines to leave out, matched against their text without styling. */
		private drop?: RegExp,
	) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const prefix = " ".repeat(this.pad) + this.theme.fg("borderMuted", "│") + " ";
		const inner = Math.max(1, width - this.pad - 2);
		const drop = this.drop;
		const lines = this.child.render(inner).filter((l) => !drop?.test(plain(l)));
		let start = 0;
		let end = lines.length;
		while (start < end && isBlank(lines[start]!)) start++;
		while (end > start && isBlank(lines[end - 1]!)) end--;
		return lines.slice(start, end).map((l) => prefix + l);
	}
}

export function isBlank(line: string): boolean {
	return visibleWidth(line) === 0 || plain(line).trim() === "";
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}
