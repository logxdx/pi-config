import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const PORT = Number(process.env.PI_BROWSER_PORT) || 17420;
export const TOKEN_FILE = path.join(os.homedir(), ".config", "pi-browser-tabs", "token");

const POLL_HOLD_MS = 20000;
const CONNECTED_WITHIN_MS = 3000;
// A sleeping MV3 service worker is revived by the extension's 30s alarm or a tab event.
const WAKE_WAIT_MS = 35000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface Command {
	id: string;
	op: string;
	args: unknown;
}

function loadToken(): string {
	try {
		const existing = readFileSync(TOKEN_FILE, "utf8").trim();
		if (existing) return existing;
	} catch {}
	const token = randomBytes(24).toString("hex");
	mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
	writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
	chmodSync(TOKEN_FILE, 0o600);
	return token;
}

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Loopback HTTP long-poll bridge. The browser extension asks for work (GET /poll, held up
 * to 20s) and posts answers (POST /result). Requests need the shared token, a loopback
 * Host header (DNS-rebinding guard) and an extension Origin if one is sent at all.
 */
export class Bridge {
	private server: http.Server | undefined;
	private starting: Promise<void> | undefined;
	private token = "";
	private queue: Command[] = [];
	private waiters: http.ServerResponse[] = [];
	private pending = new Map<string, Pending>();
	private lastPoll = 0;

	connected(): boolean {
		return this.waiters.length > 0 || Date.now() - this.lastPoll < CONNECTED_WITHIN_MS;
	}

	start(): Promise<void> {
		this.starting ??= new Promise<void>((resolve, reject) => {
			this.token = loadToken();
			const server = http.createServer((req, res) => this.route(req, res));
			server.once("error", (err: NodeJS.ErrnoException) => {
				this.starting = undefined;
				reject(
					err.code === "EADDRINUSE"
						? new Error(
								`Port ${PORT} is already in use, probably by another pi session that owns the browser bridge. ` +
									"Close that session or set PI_BROWSER_PORT to a different port (and match it in the extension options).",
							)
						: err,
				);
			});
			server.listen(PORT, "127.0.0.1", () => {
				this.server = server;
				resolve();
			});
		});
		return this.starting;
	}

	stop(): void {
		this.server?.close();
		this.server = undefined;
		this.starting = undefined;
		for (const res of this.waiters.splice(0)) res.writeHead(204).end();
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("Bridge stopped."));
		}
		this.pending.clear();
	}

	async call(op: string, args: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<unknown> {
		await this.start();
		if (!this.connected()) await this.waitConnected(WAKE_WAIT_MS);
		if (!this.connected()) {
			throw new Error(
				"The Pi Browser Bridge extension is not connected. Check that Helium is running with the extension " +
					`loaded and its options token matches ${TOKEN_FILE} (see extensions/browser-tabs/README.md). ` +
					'To start the browser, use browser_tab with action "launch".',
			);
		}
		const id = randomBytes(8).toString("hex");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The browser did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error("Aborted."));
			});
			this.enqueue({ id, op, args });
		});
	}

	async waitConnected(ms: number): Promise<boolean> {
		await this.start();
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (this.connected()) return true;
			await new Promise((r) => setTimeout(r, 250));
		}
		return this.connected();
	}

	private enqueue(cmd: Command) {
		const waiter = this.waiters.shift();
		if (waiter) this.deliver(waiter, cmd);
		else this.queue.push(cmd);
	}

	private deliver(res: http.ServerResponse, cmd: Command) {
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cmd));
	}

	private authorized(req: http.IncomingMessage): boolean {
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
		const origin = req.headers.origin;
		if (origin && !origin.startsWith("chrome-extension://")) return false;
		const header = req.headers.authorization ?? "";
		return header.startsWith("Bearer ") && sameToken(header.slice(7), this.token);
	}

	private route(req: http.IncomingMessage, res: http.ServerResponse) {
		if (!this.authorized(req)) {
			res.writeHead(401).end();
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "GET" && url.pathname === "/poll") {
			this.lastPoll = Date.now();
			const cmd = this.queue.shift();
			if (cmd) return this.deliver(res, cmd);
			this.waiters.push(res);
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== res);
				this.lastPoll = Date.now();
				res.writeHead(204).end();
			}, POLL_HOLD_MS);
			res.once("close", () => {
				clearTimeout(timer);
				this.waiters = this.waiters.filter((w) => w !== res);
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/result") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 8 * 1024 * 1024) req.destroy();
			});
			req.on("end", () => {
				try {
					const msg = JSON.parse(body) as { id: string; ok: boolean; data?: unknown; error?: string };
					const p = this.pending.get(msg.id);
					if (p) {
						clearTimeout(p.timer);
						this.pending.delete(msg.id);
						if (msg.ok) p.resolve(msg.data);
						else p.reject(new Error(msg.error || "Browser error."));
					}
					res.writeHead(204).end();
				} catch {
					res.writeHead(400).end();
				}
			});
			return;
		}

		res.writeHead(404).end();
	}
}
