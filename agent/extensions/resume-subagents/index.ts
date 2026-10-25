/**
 * Resume Subagents
 *
 * Hides subagent sessions in the /resume picker by default; alt+a shows or hides them.
 *
 * Pi has no hook for the picker, so this wraps SessionSelectorComponent at runtime (the same
 * technique as the trace extension). Nothing on disk is patched, so it survives `pi update`.
 * If pi's internals change shape the extension does nothing and the picker behaves as stock.
 *
 * Subagent sessions are recognised by file name: pi-interactive-subagents names them
 * <timestamp>_<8hex>-<8hex>-<8hex>-<4hex>.jsonl, while regular sessions use a UUID.
 *
 * PI_RESUME_SUBAGENTS=show starts the picker with subagents shown.
 * To remove: delete this directory and restart pi.
 */

import { rawKeyHint, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const TOGGLE_KEY = "alt+a";
const SUBAGENT_FILE = /Z_[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{4}\.jsonl$/;
const PICKER_STATE = Symbol("resume-subagents.picker");
const PROTO_PATCHED = Symbol("resume-subagents.patched");

interface PickerState {
	hide: boolean;
	list: any;
}

function isSubagentSession(session: { path?: string }): boolean {
	return SUBAGENT_FILE.test(session.path ?? "");
}

/** Hook the picker's list and header once per instance. Returns undefined when pi's shape changed. */
function attach(picker: any): PickerState | undefined {
	if (Object.hasOwn(picker, PICKER_STATE)) return picker[PICKER_STATE];
	const list = picker.sessionList;
	const header = picker.header;
	if (!list || !header || typeof list.filterSessions !== "function" || typeof header.render !== "function") {
		return undefined;
	}

	const state: PickerState = { hide: process.env.PI_RESUME_SUBAGENTS !== "show", list };
	picker[PICKER_STATE] = state;

	// Filter by swapping allSessions for the duration of pi's own filtering, so search, sort,
	// the named filter and threading all work on the visible set.
	const origFilter = list.filterSessions;
	list.filterSessions = function (this: any, query: string) {
		const all = this.allSessions;
		if (state.hide && Array.isArray(all)) this.allSessions = all.filter((s: any) => !isSubagentSession(s));
		try {
			return origFilter.call(this, query);
		} finally {
			this.allSessions = all;
		}
	};

	// Add the toggle to the second hint row (left alone while a delete or status message shows).
	const origHeaderRender = header.render;
	header.render = function (this: any, width: number) {
		const lines: string[] = origHeaderRender.call(this, width);
		if (lines.length >= 3 && lines[2]) {
			const hint = rawKeyHint(TOGGLE_KEY, `subagents ${state.hide ? "(hidden)" : "(shown)"}`);
			lines[2] = truncateToWidth(`${lines[2]} \x1b[2m·\x1b[22m ${hint}`, width, "…");
		}
		return lines;
	};

	list.filterSessions(list.searchInput?.getValue?.() ?? "");
	return state;
}

function install(): boolean {
	const proto = (SessionSelectorComponent as any)?.prototype;
	if (typeof proto?.render !== "function" || typeof proto?.handleInput !== "function") return false;
	if (Object.hasOwn(proto, PROTO_PATCHED)) return true;
	proto[PROTO_PATCHED] = true;

	const origRender = proto.render;
	const origInput = proto.handleInput;

	proto.render = function (this: any, width: number) {
		attach(this);
		return origRender.call(this, width);
	};

	proto.handleInput = function (this: any, data: string) {
		const state = attach(this);
		if (state && this.mode !== "rename" && matchesKey(data, TOGGLE_KEY)) {
			state.hide = !state.hide;
			state.list.filterSessions(state.list.searchInput?.getValue?.() ?? "");
			this.requestRender?.();
			return;
		}
		return origInput.call(this, data);
	};
	return true;
}

export default function (_pi: ExtensionAPI) {
	try {
		install();
	} catch {
		// Leave the stock picker alone if pi's internals changed.
	}
}
