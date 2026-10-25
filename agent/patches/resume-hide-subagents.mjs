#!/usr/bin/env node
/**
 * Adds a "hide subagent sessions" toggle to pi's /resume picker (hidden by default).
 *
 * Pi has no extension hook for the session picker, so this patches the bundled chunk of the
 * managed release in place. A pi upgrade installs a fresh release and drops the patch:
 * re-run this script after `pi update`.
 *
 *   node agent/patches/resume-hide-subagents.mjs            apply (idempotent)
 *   node agent/patches/resume-hide-subagents.mjs --check    report whether it is applied
 *   node agent/patches/resume-hide-subagents.mjs --revert   restore the original chunk
 *
 * Toggle key: alt+a (binding id app.session.toggleSubagents, rebindable in keybindings.json).
 * Subagent sessions are recognised by file name: pi-interactive-subagents names them
 * <timestamp>_<8hex>-<8hex>-<8hex>-<4hex>.jsonl, while regular sessions use a UUID.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
const chunksDir = join(
	agentDir, "install", "releases", version,
	"node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks",
);

const chunk = readdirSync(chunksDir)
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(chunksDir, f))
	.find((f) => readFileSync(f, "utf8").includes("SessionSelectorHeader=class{"));
if (!chunk) throw new Error(`No chunk containing the session selector in ${chunksDir}`);
const backup = `${chunk}.pre-hide-subagents`;

const MARK = "isSubagentSession";
const src = readFileSync(chunk, "utf8");
const applied = src.includes(MARK);
const mode = process.argv[2];

if (mode === "--check") {
	console.log(`${applied ? "applied" : "not applied"} (pi ${version}, ${chunk})`);
	process.exit(applied ? 0 : 1);
}
if (mode === "--revert") {
	if (!existsSync(backup)) throw new Error(`No backup at ${backup}`);
	copyFileSync(backup, chunk);
	console.log(`reverted ${chunk}`);
	process.exit(0);
}
if (applied) {
	console.log(`already applied (pi ${version})`);
	process.exit(0);
}

// [anchor, replacement]; every anchor must occur exactly once.
const SUBAGENT_RE = "/Z_[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{4}\\.jsonl$/";
const edits = [
	// 1. keybinding
	[
		`"app.session.toggleNamedFilter":{defaultKeys:"ctrl+n",description:"Toggle named session filter"},`,
		`"app.session.toggleNamedFilter":{defaultKeys:"ctrl+n",description:"Toggle named session filter"},` +
			`"app.session.toggleSubagents":{defaultKeys:"alt+a",description:"Show or hide subagent sessions"},`,
	],
	// 2. predicate, defined ahead of the header class
	[
		`var SessionSelectorHeader=class{`,
		`function ${MARK}(s){return ${SUBAGENT_RE}.test(s.path||"")}var SessionSelectorHeader=class{hideSubagents=!0;setHideSubagents(v){this.hideSubagents=v}`,
	],
	// 3. header hint (second hint row)
	[
		`keyHint("app.session.toggleNamedFilter","named"),`,
		`keyHint("app.session.toggleNamedFilter","named"),keyHint("app.session.toggleSubagents",\`subagents \${this.hideSubagents?"(hidden)":"(shown)"}\`),`,
	],
	// 4. list state and filtering
	[
		`onToggleNameFilter;onTogglePath;`,
		`onToggleNameFilter;onToggleSubagents;hideSubagents=!0;onTogglePath;`,
	],
	[
		`setNameFilter(nameFilter){this.nameFilter=nameFilter,this.filterSessions(this.searchInput.getValue())}setSessions(`,
		`setNameFilter(nameFilter){this.nameFilter=nameFilter,this.filterSessions(this.searchInput.getValue())}` +
			`setHideSubagents(v){this.hideSubagents=v,this.filterSessions(this.searchInput.getValue())}setSessions(`,
	],
	[
		`nameFiltered=this.nameFilter==="all"?this.allSessions:this.allSessions.filter(session=>hasSessionName(session));`,
		`visible=this.hideSubagents?this.allSessions.filter(session=>!${MARK}(session)):this.allSessions,` +
			`nameFiltered=this.nameFilter==="all"?visible:visible.filter(session=>hasSessionName(session));`,
	],
	// 5. key handling in the list
	[
		`if(this.keybindings.matches(keyData,"app.session.toggleNamedFilter")){this.onToggleNameFilter?.();return}`,
		`if(this.keybindings.matches(keyData,"app.session.toggleNamedFilter")){this.onToggleNameFilter?.();return}` +
			`if(this.keybindings.matches(keyData,"app.session.toggleSubagents")){this.onToggleSubagents?.();return}`,
	],
	// 6. selector wiring and toggle
	[
		`this.sessionList.onToggleNameFilter=()=>this.toggleNameFilter(),`,
		`this.sessionList.onToggleNameFilter=()=>this.toggleNameFilter(),this.sessionList.onToggleSubagents=()=>this.toggleSubagents(),`,
	],
	[
		`toggleNameFilter(){this.nameFilter=`,
		`toggleSubagents(){this.hideSubagents=!this.hideSubagents,this.header.setHideSubagents(this.hideSubagents),this.sessionList.setHideSubagents(this.hideSubagents),this.requestRender()}` +
			`hideSubagents=!0;toggleNameFilter(){this.nameFilter=`,
	],
];

let out = src;
for (const [anchor, replacement] of edits) {
	const n = out.split(anchor).length - 1;
	if (n !== 1) throw new Error(`Anchor matched ${n} times (expected 1), nothing written: ${anchor.slice(0, 80)}`);
	out = out.replace(anchor, () => replacement);
}

if (!existsSync(backup)) copyFileSync(chunk, backup);
writeFileSync(chunk, out);
console.log(`patched pi ${version}: ${chunk}\nbackup: ${backup}`);
