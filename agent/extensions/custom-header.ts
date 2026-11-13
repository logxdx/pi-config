/**
 * pi-operator header: the π from ~/.pi/agent/extensions/custom-header.ts with "-OPERATOR" next to it.
 * Loaded by bin/operator from ~/.pi-operator/agent/extensions.txt; the regular pi header is unchanged.
 * Edit and /reload.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";

// The π (same art as the regular pi header): 10 rows, 33 columns.
const PI = [
	"   ███████████████████████████╗  ",
	"   ╚══██████╔════════██████╔══╝  ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"   ████████████╗  ████████████╗  ",
	"   ╚═══════════╝  ╚═══════════╝  ",
];

// "-OPERATOR" in the same block style (ANSI Shadow): 6 rows.
const GLYPHS: Record<string, string[]> = {
	"-": ["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
	O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
	P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
	E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
	R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
	A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
	T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
};
const WORD = [...Array(6).keys()].map((row) => [..."-OPERATOR"].map((ch) => GLYPHS[ch][row]).join(""));

const width = (s: string) => [...s].length;

function buildHeader(theme: Theme, cols: number): string[] {
	const pi = (s: string) => theme.bold(theme.fg("success", s));
	const word = (s: string) => theme.bold(theme.fg("accent", s));
	const title = theme.bold(theme.fg("accent", "π-operator")) + theme.fg("dim", ` v${VERSION}`);
	const piW = width(PI[0]);
	const wordW = width(WORD[0]);
	let art: string[];
	if (cols >= piW + wordW) {
		// Side by side, the word level with the π's legs.
		const top = PI.length - WORD.length - 1;
		art = PI.map((line, i) => pi(line) + (i >= top && i < top + WORD.length ? word(WORD[i - top]) : ""));
	} else if (cols >= wordW) {
		art = [...PI.map(pi), ...WORD.map(word)];
	} else {
		art = PI.map(pi);
	}
	return ["", ...art, "", title];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(cols: number): string[] {
				return buildHeader(theme, cols);
			},
			invalidate() {},
		}));
	});

	pi.registerCommand("builtin-header", {
		description: "Restore the built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
