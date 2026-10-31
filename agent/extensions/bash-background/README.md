# bash-background (pi extension)

Claude Code-style control over a running `bash` tool call.

| Key | Effect |
|---|---|
| `Esc` | Cancel the run and kill the command's process tree (pi's built-in `app.interrupt`) |
| `Ctrl+B` | Move the running command to the background |

Backgrounding returns the tool call at once, so the agent can keep working. The command keeps running and writes its output (including everything printed before Ctrl+B) to `/tmp/pi-bash-bg/<pi pid>/<call>.log`. The tool result gives the agent the log path and the pid, and it can stop the job with `kill -- -<pid>`. When the command exits, the agent gets a follow-up message with the exit code and the last 20 lines, which starts a turn if pi is idle.

After Ctrl+B, Esc no longer kills that command and its `timeout` no longer applies. Background jobs are killed when the session ends (quitting pi, `/new`, switching sessions), and the log directory is removed.

## How it works

The extension re-registers `bash` on top of pi's own local bash backend (`createBashToolDefinition` + `createLocalBashOperations`, as in pi's `ssh.ts` example), so output, truncation, rendering, `shellPath` and `shellCommandPrefix` behave as before. Each command is prefixed with `printf '%s' "$$" > <pidfile>` to learn the shell's pid, which is also its process group, since pi spawns commands detached.

`Ctrl+B` is also pi's default editor cursor-left key; `agent/keybindings.json` leaves cursor-left on the arrow key only, so pi doesn't report a shortcut conflict.

Only the agent's `bash` tool is covered, not `!` commands typed by the user or subagents' `safe_bash`.
