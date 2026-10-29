---
name: subagents
description: Delegate work to subagents that run in their own terminal panes (subagent, subagents_list, subagent_message). Use for long research, broad searches across many files or pages, and independent tasks that can run in parallel, so their context stays out of yours.
---

# subagents

## Load the tools

`subagent`, `subagents_list` and `subagent_message` are not loaded at the start of a session. Call `tool_search` with query `subagent` and limit `3`; the tools are available from your next call. Skip this if they are already in your tool list.

## Spawn

`subagent` starts one agent with a task:

- `agent` (required): which agent profile to run. It fixes the model, tools and system prompt. Call `subagents_list` if you don't know which agents exist.
- `task` (required): a self-contained brief. The subagent sees none of your conversation, so include the goal, the inputs, and what to report back.
- `name`: label for its pane, also used to message it later. Defaults to the agent name.
- `model`: override the agent's model.
- `cwd`: folder to start in.

## Wait for the result

Spawning is fire-and-forget: the call returns at once with an acknowledgement. When the subagent finishes, its result arrives on its own as a message that starts a new turn.

- After spawning, end your turn, or do other independent work (including spawning more subagents in parallel).
- Do not poll, sleep, tail logs, read session files, or call `subagents_list` to check status.
- Do not guess or summarise a result before it arrives.

## Follow up

`subagent_message` with `name` and `message` reaches a subagent by name. If it is still running, the message steers it. If it has finished, the message resumes it, and the new result arrives the same way as the first.
