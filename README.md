# pi-config: operator branch

The setup of [pi-operator](https://pi.dev) (computer, browser and voice use for pi), kept apart from the regular pi
setup kept on `main`. This branch is checked out at `~/.pi` (pi-operator's `OP_HOME`); `bin/operator` in the
pi-operator repo runs pi with `PI_CODING_AGENT_DIR=~/.pi/agent`.

- `agent/SYSTEM.md`: the system prompt template (`{{tools}}`, `{{rules}}`, `{{addendum}}`... filled each turn).
- `agent/extensions.txt`: extra extensions loaded with `-e` (custom header, subagents, trace, prompt snippets,
  ask-user-question, rewind, web search and fetch); their copies are in `agent/extensions` and `agent/packages`.
- `agent/skills`: skills the operator loads besides its own.
- `agent/settings.json`, `agent/models.json`: pi settings and the local model router.
- `settings.json`: operator and voice settings (`/operator-settings`, `/voice-settings`).

Not tracked: credentials, sessions, the browser profile, the voice daemon's runtime files (see `.gitignore`).
