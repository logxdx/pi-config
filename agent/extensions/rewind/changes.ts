/**
 * Computing and applying the code changes a rewind would revert.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckpointStore, SnapshotRecord } from "./store.ts";

export interface FileChange {
	path: string;
	/** Path for display, relative to cwd when inside it. */
	display: string;
	/** Snapshot to restore; `blob: null` deletes the file. */
	target: SnapshotRecord;
	/** Lines added / removed since the checkpoint (what restoring reverts). */
	added: number;
	removed: number;
}

export interface CodeChanges {
	files: FileChange[];
	/** Files that changed but cannot be restored (symlinks, hard links). */
	skipped: string[];
	added: number;
	removed: number;
}

export interface RestoreResult {
	restored: number;
	skipped: number;
	failed: string[];
}

/** Reads each file and blob at most once per rewind menu. */
export class ContentCache {
	private files = new Map<string, Buffer | null>();
	private blobs = new Map<string, Buffer>();
	private stats = new Map<string, { added: number; removed: number }>();

	constructor(private store: CheckpointStore) {}

	current(file: string): Buffer | null {
		if (!this.files.has(file)) {
			let content: Buffer | null = null;
			try {
				content = fs.readFileSync(file);
			} catch {
				content = null;
			}
			this.files.set(file, content);
		}
		return this.files.get(file) ?? null;
	}

	target(record: SnapshotRecord): Buffer | null {
		if (record.blob === null) return null;
		let content = this.blobs.get(record.blob);
		if (!content) {
			content = this.store.readBlob(record.blob);
			this.blobs.set(record.blob, content);
		}
		return content;
	}

	/** Line changes from a snapshot to the file's current content. */
	lineChanges(record: SnapshotRecord): { added: number; removed: number } {
		const k = `${record.path}\0${record.blob}`;
		let stats = this.stats.get(k);
		if (!stats) {
			stats = countLineChanges(this.target(record), this.current(record.path));
			this.stats.set(k, stats);
		}
		return stats;
	}
}

/** Changes that "Restore code" to the point before a prompt sent at `since` would revert. */
export function changesSince(store: CheckpointStore, cache: ContentCache, since: number, cwd: string): CodeChanges {
	const result: CodeChanges = { files: [], skipped: [], added: 0, removed: 0 };
	for (const record of store.targetsSince(since)) {
		let target: Buffer | null;
		try {
			target = cache.target(record);
		} catch {
			continue; // Blob missing (expired or deleted): nothing we can restore.
		}
		const current = cache.current(record.path);
		if (sameContent(target, current)) continue;

		const display = displayPath(record.path, cwd);
		if (record.skip) {
			result.skipped.push(display);
			continue;
		}
		const { added, removed } = cache.lineChanges(record);
		result.files.push({ path: record.path, display, target: record, added, removed });
		result.added += added;
		result.removed += removed;
	}
	result.files.sort((a, b) => a.display.localeCompare(b.display));
	return result;
}

/**
 * Write each file back to its checkpoint content (or delete it). The pre-restore content is
 * captured first, so later rewinds still see an accurate timeline.
 */
export function restoreFiles(store: CheckpointStore, cache: ContentCache, changes: CodeChanges): RestoreResult {
	const result: RestoreResult = { restored: 0, skipped: changes.skipped.length, failed: [] };
	const cp = `restore@${Date.now()}`;
	for (const file of changes.files) {
		try {
			store.capture(cp, file.path);
			const content = cache.target(file.target);
			if (content === null) {
				fs.rmSync(file.path, { force: true });
			} else {
				fs.mkdirSync(path.dirname(file.path), { recursive: true });
				fs.writeFileSync(file.path, content);
			}
			result.restored++;
		} catch (error) {
			result.failed.push(`${file.display}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

/** "+3 -1 in src/a.ts" / "+10 -2 in 3 files" */
export function describeChanges(changes: CodeChanges): string {
	const where = changes.files.length === 1 ? changes.files[0].display : `${changes.files.length} files`;
	return `+${changes.added} -${changes.removed} in ${where}`;
}

function sameContent(a: Buffer | null, b: Buffer | null): boolean {
	if (a === null || b === null) return a === b;
	return a.equals(b);
}

function displayPath(file: string, cwd: string): string {
	const rel = path.relative(cwd, file);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function splitLines(content: Buffer | null): string[] {
	if (content === null || content.length === 0) return [];
	const lines = content.toString("utf8").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Line-level added/removed counts going from `before` to `after` (LCS-based). */
export function countLineChanges(before: Buffer | null, after: Buffer | null): { added: number; removed: number } {
	const a = splitLines(before);
	const b = splitLines(after);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	if (x.length === 0 || y.length === 0) return { added: y.length, removed: x.length };

	let common: number;
	if (x.length * y.length > 4_000_000) {
		// Too large for an exact LCS: count lines shared as a multiset.
		const counts = new Map<string, number>();
		for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
		common = 0;
		for (const line of y) {
			const n = counts.get(line) ?? 0;
			if (n > 0) {
				common++;
				counts.set(line, n - 1);
			}
		}
	} else {
		let prev = new Uint32Array(y.length + 1);
		let row = new Uint32Array(y.length + 1);
		for (let i = 1; i <= x.length; i++) {
			for (let j = 1; j <= y.length; j++) {
				row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
			}
			[prev, row] = [row, prev];
		}
		common = prev[y.length];
	}
	return { added: y.length - common, removed: x.length - common };
}
