/**
 * File checkpoint store for /rewind.
 *
 * Before a tracked tool (edit/write) touches a file for the first time after a user prompt, the
 * file's current content is saved as a content-addressed blob and a record is appended to an
 * index. Restoring code to "before prompt X" means: for every file, take the earliest snapshot
 * captured at or after X was sent — that is the file as it was when X was sent (or absent, if the
 * file did not exist yet). Files without such a snapshot were not touched since X and stay as-is.
 *
 * Layout: <root>/<sessionId>/index.jsonl, meta.json, blobs/<sha256>
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Keep snapshots for this many checkpoints (user prompts that edited files) per session. */
export const RETAINED_CHECKPOINTS = 100;
/** Delete a session's snapshots this many days after it last saved one. */
export const CLEANUP_PERIOD_DAYS = 30;

export interface SnapshotRecord {
	/** Checkpoint: id of the user message entry the edit belongs to (or `restore@<ms>`). */
	cp: string;
	/** Absolute file path. */
	path: string;
	/** Capture time in ms; always after the checkpoint's user message was sent. */
	t: number;
	/** sha256 of the content before the edit; null when the file did not exist. */
	blob: string | null;
	/** Set when the file cannot be restored safely. */
	skip?: "symlink" | "hardlink";
}

interface Meta {
	/** Restores to prompts sent at or before this time may be incomplete (older snapshots pruned). */
	prunedBefore: number;
}

export class CheckpointStore {
	readonly dir: string;
	private records: SnapshotRecord[] = [];
	private seen = new Set<string>();
	private meta: Meta = { prunedBefore: 0 };

	constructor(root: string, readonly sessionId: string) {
		this.dir = path.join(root, sessionId);
		this.load();
	}

	private get indexFile(): string {
		return path.join(this.dir, "index.jsonl");
	}

	private get metaFile(): string {
		return path.join(this.dir, "meta.json");
	}

	private blobFile(hash: string): string {
		return path.join(this.dir, "blobs", hash);
	}

	private load(): void {
		try {
			for (const line of fs.readFileSync(this.indexFile, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line) as SnapshotRecord;
					this.records.push(record);
					this.seen.add(key(record.cp, record.path));
				} catch {
					// Skip a torn line from an interrupted write.
				}
			}
		} catch {
			// No checkpoints yet.
		}
		try {
			this.meta = { ...this.meta, ...JSON.parse(fs.readFileSync(this.metaFile, "utf8")) };
		} catch {
			// Defaults.
		}
	}

	get prunedBefore(): number {
		return this.meta.prunedBefore;
	}

	/** Save `absPath` as it is now, unless it was already saved for this checkpoint. */
	capture(cp: string, absPath: string): void {
		const k = key(cp, absPath);
		if (this.seen.has(k)) return;

		const record: SnapshotRecord = { cp, path: absPath, t: Date.now(), blob: null };
		try {
			const stat = fs.lstatSync(absPath);
			if (stat.isSymbolicLink()) record.skip = "symlink";
			else if (!stat.isFile()) return;
			else if (stat.nlink > 1) record.skip = "hardlink";
			else record.blob = this.writeBlob(fs.readFileSync(absPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		}

		this.seen.add(k);
		this.records.push(record);
		fs.mkdirSync(this.dir, { recursive: true });
		fs.appendFileSync(this.indexFile, `${JSON.stringify(record)}\n`);
		this.prune();
	}

	/**
	 * For each file touched since `since` (ms), the earliest snapshot taken at or after it:
	 * the file's state at that moment.
	 */
	targetsSince(since: number): SnapshotRecord[] {
		const byPath = new Map<string, SnapshotRecord>();
		for (const record of this.records) {
			if (record.t >= since && !byPath.has(record.path)) byPath.set(record.path, record);
		}
		return [...byPath.values()];
	}

	readBlob(hash: string): Buffer {
		return fs.readFileSync(this.blobFile(hash));
	}

	private writeBlob(content: Buffer): string {
		const hash = createHash("sha256").update(content).digest("hex");
		const file = this.blobFile(hash);
		if (!fs.existsSync(file)) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, content);
			fs.renameSync(tmp, file);
		}
		return hash;
	}

	/** Drop snapshots of the oldest checkpoints beyond RETAINED_CHECKPOINTS. */
	private prune(): void {
		const order: string[] = [];
		for (const record of this.records) if (!order.includes(record.cp)) order.push(record.cp);
		if (order.length <= RETAINED_CHECKPOINTS) return;

		const dropped = new Set(order.slice(0, order.length - RETAINED_CHECKPOINTS));
		const kept: SnapshotRecord[] = [];
		for (const record of this.records) {
			if (dropped.has(record.cp)) this.meta.prunedBefore = Math.max(this.meta.prunedBefore, record.t);
			else kept.push(record);
		}
		this.records = kept;
		this.seen = new Set(kept.map((record) => key(record.cp, record.path)));

		const tmp = `${this.indexFile}.tmp`;
		fs.writeFileSync(tmp, kept.map((record) => `${JSON.stringify(record)}\n`).join(""));
		fs.renameSync(tmp, this.indexFile);
		fs.writeFileSync(this.metaFile, JSON.stringify(this.meta));

		const live = new Set(kept.map((record) => record.blob).filter(Boolean));
		try {
			for (const name of fs.readdirSync(path.join(this.dir, "blobs"))) {
				if (!live.has(name)) fs.rmSync(this.blobFile(name), { force: true });
			}
		} catch {
			// Nothing to collect.
		}
	}
}

/** Delete checkpoint directories of sessions that saved no snapshot for CLEANUP_PERIOD_DAYS. */
export function cleanupExpired(root: string, keepSessionId?: string): void {
	const cutoff = Date.now() - CLEANUP_PERIOD_DAYS * 24 * 60 * 60 * 1000;
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === keepSessionId) continue;
		const dir = path.join(root, name);
		try {
			let mtime = fs.statSync(dir).mtimeMs;
			try {
				mtime = fs.statSync(path.join(dir, "index.jsonl")).mtimeMs;
			} catch {
				// Directory without index: use the directory's own mtime.
			}
			if (mtime < cutoff) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore entries we cannot inspect.
		}
	}
}

function key(cp: string, absPath: string): string {
	return `${cp}\0${absPath}`;
}
