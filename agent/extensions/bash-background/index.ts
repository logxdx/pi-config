import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	type BashOperations,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

// Ctrl+B moves the running bash command to the background, like Claude Code. The tool call returns
// at once with the pid and a log file; the command keeps running, writes to the log, and a follow-up
// message reports its exit code. Esc (pi's app.interrupt) still cancels a foreground command.

const KEY = "ctrl+b";
const DIR = path.join(os.tmpdir(), "pi-bash-bg", String(process.pid));
const MAX_BUFFER = 5 * 1024 * 1024;
const TAIL_LINES = 20;

interface Job {
	id: string;
	command: string;
	pidFile: string;
	logFile: string;
	chunks: Buffer[];
	buffered: number;
	backgrounded: boolean;
	exitCode?: number | null;
	/** Writes the output so far to the log and switches the job to it, in one synchronous step. */
	toBackground: () => void;
}

/** Log writes never throw: the log directory is removed at shutdown while a job may still be exiting. */
function appendLog(file: string, data: Buffer | string) {
	try {
		appendFileSync(file, data);
	} catch {}
}

function readPid(job: Job): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(job.pidFile, "utf8"), 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function tail(file: string, lines: number): string {
	try {
		return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const running: Job[] = [];
	/** Process groups of backgrounded commands still running, killed at shutdown (pi's normal exit does not). */
	const background = new Set<number>();
	let shutDown = false;

	/** Local bash, plus: records the shell pid, and diverts output to the job's log once backgrounded. */
	function jobOperations(local: BashOperations, job: Job, signal: AbortSignal): BashOperations {
		return {
			async exec(command, cwd, options) {
				// Handle the timeout here so a backgrounded command is not killed by it.
				const controller = new AbortController();
				let timedOut = false;
				const timer =
					options.timeout && options.timeout > 0
						? setTimeout(() => {
								if (job.backgrounded) return;
								timedOut = true;
								controller.abort();
							}, options.timeout * 1000)
						: undefined;
				const onAbort = () => controller.abort();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					const result = await local.exec(`printf '%s' "$$" > '${job.pidFile}'\n${command}`, cwd, {
						env: options.env,
						signal: controller.signal,
						onData: (data) => {
							if (job.backgrounded) {
								appendLog(job.logFile, data);
								return;
							}
							if (job.buffered < MAX_BUFFER) {
								job.chunks.push(data);
								job.buffered += data.length;
							}
							options.onData(data);
						},
					});
					job.exitCode = result.exitCode;
					return result;
				} catch (error) {
					if (timedOut) throw new Error(`timeout:${options.timeout}`);
					throw error;
				} finally {
					if (timer) clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
				}
			},
		};
	}

	const base = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const settings = pi.getSettings();
			const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
			mkdirSync(DIR, { recursive: true });

			let resolveBackground = () => {};
			const backgrounded = new Promise<void>((resolve) => (resolveBackground = resolve));
			const job: Job = {
				id: safeId,
				command: params.command,
				pidFile: path.join(DIR, `${safeId}.pid`),
				logFile: path.join(DIR, `${safeId}.log`),
				chunks: [],
				buffered: 0,
				backgrounded: false,
				toBackground: () => {
					writeFileSync(job.logFile, Buffer.concat(job.chunks));
					job.chunks = [];
					job.backgrounded = true;
					resolveBackground();
				},
			};

			// Esc aborts the foreground command; once backgrounded it is detached from the turn.
			const controller = new AbortController();
			const onAbort = () => {
				if (!job.backgrounded) controller.abort();
			};
			if (signal?.aborted) controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			const tool = createBashToolDefinition(ctx?.cwd || process.cwd(), {
				operations: jobOperations(createLocalBashOperations({ shellPath: settings.shellPath }), job, controller.signal),
				shellPath: settings.shellPath,
				commandPrefix: settings.shellCommandPrefix,
			});
			const run = tool.execute(
				toolCallId,
				params,
				controller.signal,
				(update) => {
					if (!job.backgrounded) onUpdate?.(update);
				},
				ctx,
			);

			running.push(job);
			try {
				const outcome = await Promise.race([
					run.then(
						(result) => ({ kind: "done" as const, result }),
						(error) => ({ kind: "error" as const, error }),
					),
					backgrounded.then(() => ({ kind: "background" as const })),
				]);
				if (outcome.kind === "done") return outcome.result;
				if (outcome.kind === "error") throw outcome.error;
			} finally {
				running.splice(running.indexOf(job), 1);
				signal?.removeEventListener("abort", onAbort);
				if (!job.backgrounded) rmSync(job.pidFile, { force: true });
			}

			// Backgrounded: the log already holds the output so far and gets the rest as it arrives.
			const pid = readPid(job);
			if (pid) background.add(pid);
			const finished = () => {
				if (pid) background.delete(pid);
				if (shutDown) return;
				appendLog(job.logFile, `\n[exit code ${job.exitCode ?? "unknown"}]\n`);
				pi.sendMessage(
					{
						customType: "bash-background",
						content:
							`Background command finished with exit code ${job.exitCode ?? "unknown"}: ${job.command}\n` +
							`Full output: ${job.logFile}\nLast lines:\n${tail(job.logFile, TAIL_LINES)}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			};
			run.then(finished, finished);

			const kill = pid ? ` Stop it with \`kill -- -${pid}\`.` : "";
			return {
				content: [
					{
						type: "text",
						text:
							`The user moved this command to the background. It is still running${pid ? ` (pid ${pid})` : ""}.${kill}\n` +
							`Its output so far and from now on goes to ${job.logFile}; read it with \`tail\`. ` +
							"You will get a message with its exit code when it finishes. Do not wait or poll for it.",
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerShortcut(KEY, {
		description: "Move the running bash command to the background",
		handler: (ctx) => {
			const job = [...running].reverse().find((j) => !j.backgrounded);
			if (!job) {
				ctx.ui.notify("No running bash command to background", "info");
				return;
			}
			job.toBackground();
			ctx.ui.notify(`Moved to background: ${job.command.split("\n")[0].slice(0, 60)}`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		shutDown = true;
		for (const pid of background) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
		}
		background.clear();
		rmSync(DIR, { recursive: true, force: true });
	});
}
