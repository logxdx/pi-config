import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Each pi session binds the first free port in [BASE_PORT, BASE_PORT + PORT_COUNT); the extension
// polls all of them. Keep PORT_COUNT in sync with background.js.
export const BASE_PORT = Number(process.env.PI_BROWSER_PORT) || 17420;
export const PORT_COUNT = 10;
// Identifies this pi process to the extension, so tabs a session opens stay its own. Stable
// across /new and /resume, which keep the process.
const SESSION = String(process.pid);
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
	session: string;
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
	private port = BASE_PORT;

	connected(): boolean {
		return this.waiters.length > 0 || Date.now() - this.lastPoll < CONNECTED_WITHIN_MS;
	}

	start(): Promise<void> {
		this.starting ??= (async () => {
			this.token = loadToken();
			for (let i = 0; i < PORT_COUNT; i++) {
				const port = BASE_PORT + i;
				const server = http.createServer((req, res) => this.route(req, res));
				try {
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(port, "127.0.0.1", resolve);
					});
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
					this.starting = undefined;
					throw err;
				}
				server.on("error", () => {});
				this.port = port;
				this.server = server;
				return;
			}
			this.starting = undefined;
			throw new Error(
				`Ports ${BASE_PORT}-${BASE_PORT + PORT_COUNT - 1} are all in use, by other pi sessions (up to ${PORT_COUNT} ` +
					"can use the browser at once). Close one of them.",
			);
		})();
		return this.starting;
	}

	stop(): void {
		// close() alone leaves keep-alive sockets open, and the extension would keep polling this
		// dead server instead of reconnecting to the next session's bridge.
		this.server?.close();
		this.server?.closeAllConnections();
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
			this.enqueue({ id, session: SESSION, op, args });
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
		for (;;) {
			const waiter = this.waiters.shift();
			if (!waiter) return void this.queue.push(cmd);
			// Skip polls whose connection died (service worker killed) so the command isn't lost.
			if (!waiter.destroyed && !waiter.writableEnded && waiter.socket?.writable) return this.deliver(waiter, cmd);
		}
	}

	private deliver(res: http.ServerResponse, cmd: Command) {
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cmd));
	}

	private authorized(req: http.IncomingMessage): boolean {
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
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
