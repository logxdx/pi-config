/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Where a new pane lands
 * is controlled by PI_SUBAGENT_SURFACE (see getSurfaceMode): by default splits
 * target the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather
 * than the user's focus.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when the tmux binary is on PATH and we can place subagent panes.
 * `TMUX` is set by tmux in every process it spawns (shell or pane); pane and
 * window modes need it, session mode only needs the binary since it creates
 * its own detached session.
 */
export function isTmuxAvailable(): boolean {
  if (!hasCommand("tmux")) return false;
  return !!process.env.TMUX || getSurfaceMode() === "session";
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return (
    "Start pi inside tmux (`tmux new -A -s pi 'pi'`), " +
    "or set PI_SUBAGENT_SURFACE=session to run subagents in a separate tmux session."
  );
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Run tmux, capturing stderr so expected failures don't bleed into pi's TUI. */
function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ── Surface placement ──

/**
 * Where subagent panes are created, from PI_SUBAGENT_SURFACE:
 *   "pane"    (default) right split next to the parent pi pane
 *   "window"  a dedicated "subagents" window in the parent's tmux session
 *   "session" a dedicated detached tmux session (PI_SUBAGENT_TMUX_SESSION,
 *             default "pi-subagents"); set PI_SUBAGENT_TERMINAL (e.g. "kitty")
 *             to auto-open a terminal window attached to it
 */
export type SurfaceMode = "pane" | "window" | "session";

export function getSurfaceMode(): SurfaceMode {
  const raw = process.env.PI_SUBAGENT_SURFACE?.trim().toLowerCase();
  return raw === "window" || raw === "session" ? raw : "pane";
}

/** Window user option marking the dedicated subagent window. */
const SUBAGENT_WINDOW_OPTION = "@pi_subagents";
const SUBAGENT_WINDOW_NAME = "subagents";
const DEFAULT_SUBAGENT_SESSION = "pi-subagents";

function getSubagentSessionName(): string {
  return process.env.PI_SUBAGENT_TMUX_SESSION?.trim() || DEFAULT_SUBAGENT_SESSION;
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

/**
 * Layout for a window holding only subagents (window/session modes). A grid
 * stays readable with many agents, where equal columns get too narrow.
 */
const SUBAGENT_DEDICATED_TMUX_LAYOUT = "tiled";

const rebalanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * In pane mode applies SUBAGENT_TMUX_LAYOUT to the parent pi window; in
 * window/session modes applies SUBAGENT_DEDICATED_TMUX_LAYOUT to the window
 * holding the subagents. Debounced per window so a burst of parallel spawns or
 * staggered exits collapses into a single layout call, and non-fatal: a
 * cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintTarget?: string): void {
  const dedicated = getSurfaceMode() !== "pane";
  // In pane mode prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = dedicated ? hintTarget : (process.env.TMUX_PANE ?? hintTarget);
  if (!target) return;
  const layout = dedicated ? SUBAGENT_DEDICATED_TMUX_LAYOUT : SUBAGENT_TMUX_LAYOUT;
  const pending = rebalanceTimers.get(target);
  if (pending) clearTimeout(pending);
  rebalanceTimers.set(
    target,
    setTimeout(() => {
      rebalanceTimers.delete(target);
      try {
        // -t <pane> resolves to that pane's window; does not change focus.
        tmux(["select-layout", "-t", target, layout]);
      } catch {
        // Pane/window may be gone; balancing is best-effort.
      }
    }, 120),
  );
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent. Placement follows getSurfaceMode(); in the
 * default pane mode it is a right split off the parent pi's pane, so new panes
 * follow the agent rather than the user's focus.
 *
 * Never changes focus: new windows/sessions are created detached (`-d`).
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  switch (getSurfaceMode()) {
    case "window":
      return createSurfaceInWindow();
    case "session":
      return createSurfaceInSession();
    default:
      return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
  }
}

/** Split a pane into an existing subagent window, keeping focus where it is. */
function splitIntoWindow(windowTarget: string): string {
  const pane = tmux([
    "split-window", "-d", "-h", "-t", windowTarget, "-c", process.cwd(), "-P", "-F", "#{pane_id}",
  ]);
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  rebalanceSurfaces(pane);
  return pane;
}

/** Parse `<pane_id> <window_id>` output from new-window/new-session. */
function parseNewPane(output: string, command: string): { pane: string; window: string } {
  const [pane, window] = output.split(" ");
  if (!pane?.startsWith("%") || !window?.startsWith("@")) {
    throw new Error(`Unexpected tmux ${command} output: ${output}`);
  }
  return { pane, window };
}

/**
 * Window mode: all subagents share one window (marked with
 * SUBAGENT_WINDOW_OPTION) in the parent pi's session. The first spawn creates
 * it; tmux removes it once its last pane closes.
 */
function createSurfaceInWindow(): string {
  requireTmux();
  const parentPane = process.env.TMUX_PANE;
  const sessionId = tmux(
    parentPane
      ? ["display-message", "-p", "-t", parentPane, "#{session_id}"]
      : ["display-message", "-p", "#{session_id}"],
  );

  const existing = tmux([
    "list-windows", "-t", sessionId, "-F", `#{window_id} #{${SUBAGENT_WINDOW_OPTION}}`,
  ])
    .split("\n")
    .map((line) => line.split(" "))
    .find(([, marker]) => marker === "1")?.[0];
  if (existing) return splitIntoWindow(existing);

  const { pane, window } = parseNewPane(
    tmux([
      "new-window", "-d", "-t", `${sessionId}:`, "-n", SUBAGENT_WINDOW_NAME,
      "-c", process.cwd(), "-P", "-F", "#{pane_id} #{window_id}",
    ]),
    "new-window",
  );
  tmux(["set-option", "-w", "-t", window, SUBAGENT_WINDOW_OPTION, "1"]);
  return pane;
}

/**
 * Session mode: subagents live in a dedicated detached tmux session, so they
 * can be watched from another terminal window (`tmux attach -t pi-subagents`)
 * or not at all. Works whether or not pi itself runs inside tmux.
 */
function createSurfaceInSession(): string {
  requireTmux();
  const session = getSubagentSessionName();
  const exact = `=${session}`;

  let pane: string;
  let hasSession = true;
  try {
    tmux(["has-session", "-t", exact]);
  } catch {
    hasSession = false;
  }

  if (hasSession) {
    pane = splitIntoWindow(`${exact}:`);
  } else {
    // Sized explicitly: a detached session would otherwise default to 80x24
    // until a client attaches.
    ({ pane } = parseNewPane(
      tmux([
        "new-session", "-d", "-s", session, "-n", SUBAGENT_WINDOW_NAME, "-x", "220", "-y", "50",
        "-c", process.cwd(), "-P", "-F", "#{pane_id} #{window_id}",
      ]),
      "new-session",
    ));
  }

  openSubagentTerminal(session);
  return pane;
}

let lastTerminalOpenAt = 0;
const TERMINAL_REOPEN_GUARD_MS = 5_000;

/**
 * Open PI_SUBAGENT_TERMINAL attached to the subagent session when nobody is
 * watching it. Re-opens after the user closes the window; the time guard stops
 * a burst of parallel spawns from opening several windows before the first
 * one attaches. Best-effort: a missing terminal must not break spawning.
 */
function openSubagentTerminal(session: string): void {
  const terminal = process.env.PI_SUBAGENT_TERMINAL?.trim();
  if (!terminal) return;
  if (Date.now() - lastTerminalOpenAt < TERMINAL_REOPEN_GUARD_MS) return;

  try {
    const attached = tmux(["display-message", "-p", "-t", `=${session}:`, "#{session_attached}"]);
    if (attached !== "0") return;

    lastTerminalOpenAt = Date.now();
    // tmux refuses to attach from inside another tmux client unless TMUX is unset.
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn(
      "sh",
      ["-c", `exec ${terminal} tmux attach-session -t ${shellEscape(`=${session}`)}`],
      { detached: true, stdio: "ignore", env },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a viewer is a convenience; the subagent still runs detached.
  }
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  // In dedicated modes the window must be resolved before its pane goes away.
  let windowId: string | undefined;
  if (getSurfaceMode() !== "pane") {
    try {
      windowId = tmux(["display-message", "-p", "-t", surface, "#{window_id}"]);
    } catch {}
  }
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces(windowId);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
