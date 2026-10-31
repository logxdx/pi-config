# pi config

My `~/.pi` folder for [pi](https://pi.dev): settings, models, system prompt, subagent definitions, extensions, local packages and skills. Credentials, sessions and pi's own install files are gitignored (see `.gitignore`).

| Path | What it is |
|---|---|
| `agent/settings.json` | Default provider/model, TUI options, compaction, local packages |
| `agent/models.json` | Per-model context window / max-token overrides (llama.cpp models) |
| `agent/SYSTEM.md` | System prompt |
| `agent/agents/` | Subagent definitions (coder, researcher, scout, worker) |
| `agent/extensions/` | ask-user-question, bash-guard, browser-tabs, custom-header, output-guard, prompt-snippets, rewind, session-namer, subagents-resume, trace, web-fetch, web-search |
| `agent/packages/` | pi-interactive-subagents (tmux subagents), pi-observational-memory |
| `agent/skills/` | agent-browser, analyze-sessions, browser-tabs, pdf-reader, visualize, youtube-transcript |

## Set up on another machine (runbook for an AI agent)

Follow these steps in order. Each step ends with a check; do not move on until it passes. Steps 5–9 are optional features. If a tool a step needs is missing and cannot be installed without sudo, or a step needs a secret or a GUI action, stop and ask the user. Never write credentials into this repo.

Target: Linux or macOS, with `git`, `curl`, `jq` and `tmux` available.

### 1. Clone into `~/.pi`

```bash
if [ -e ~/.pi ]; then mv ~/.pi ~/.pi.bak-$(date +%Y%m%d%H%M%S); fi
git clone git@github.com:logxdx/pi-config.git ~/.pi   # or https://github.com/logxdx/pi-config.git
```

If the backup holds an `agent/auth.json` the user wants to keep, copy it into `~/.pi/agent/`.

Check: `git -C ~/.pi status` shows a clean `main`.

### 2. Install pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

The installer writes `~/.pi/agent/bin/pi` and `~/.pi/agent/install/` (both gitignored) and its own Node.js (>= 22.19). Put the launcher on PATH in the user's shell rc, then open a new shell:

```bash
export PATH="$HOME/.pi/agent/bin:$PATH"
```

Check: `pi --version` prints a version.

### 3. Install extension dependencies

```bash
(cd ~/.pi/agent/extensions/bash-guard && npm install)
(cd ~/.pi/agent/extensions/web-fetch && npm install)
for d in ~/.pi/agent/packages/*/; do [ -f "$d/package.json" ] && (cd "$d" && npm install); done
```

Check: `node_modules/` exists in each of those directories.

### 4. Model provider credentials

`agent/settings.json` defaults to OpenRouter (`defaultProvider`/`defaultModel`). Credentials live in `agent/auth.json` (gitignored). Ask the user to run `pi` and sign in with `/login`, or to provide the API key themselves. Do not type keys into commands that end up in shell history or in this repo. The `llama.cpp` provider only matters if the machine runs a local llama.cpp server. If the default model isn't available, change `defaultProvider`/`defaultModel` locally.

Check: start `pi`, send "hi", get a reply.

### 5. web-search (keyless fallback and API keys)

```bash
cd ~/.pi/agent/extensions/web-search
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
```

Optional keys (TinyFish, LangSearch, Exa) go in the system keyring, not env files. Have the user run the `secret-tool store ...` commands from `agent/extensions/web-search/README.md`; they prompt for the value.

Check: `~/.pi/agent/extensions/web-search/.venv/bin/python -c "import ddgs"` succeeds.

### 6. pdf-reader skill: `liteparse` + the `pdf` wrapper

The skill calls `pdf` (`agent/skills/pdf-reader/pdf`), a bash wrapper around `liteparse` that caches parses in `/tmp/pi-pdf/` and caps output size. `liteparse` is built from a fork with the in-process Indra OCR engine (branch `daily`, where Indra is the default OCR engine). Needs a Rust toolchain (`rustup`) and a C/C++ toolchain.

```bash
cargo install --locked --git https://github.com/logxdx/liteparse --branch daily \
  --features indra-ocr-auto-download liteparse
# use the indra-ocr-cuda feature too on machines with an NVIDIA GPU
mkdir -p ~/.local/bin
ln -sf ~/.pi/agent/skills/pdf-reader/pdf ~/.local/bin/pdf
```

The wrapper also needs `jq`, `md5sum` (coreutils) and GNU `stat`. On macOS, install `coreutils` and put its gnubin on PATH. DOCX/PPTX/XLSX input also needs LibreOffice. The PDFium library downloads during the build. If `liteparse` later says `libpdfium not loaded`, point `PDFIUM_LIB_PATH` at the downloaded `libpdfium.so`/`.dylib`. Indra OCR models (~70 MB) download to `~/.cache/liteparse/indra-ocr/` on first OCR.

Check: `liteparse --version` works, and `pdf map some.pdf` prints a page table. Then run `pdf ocr some.pdf 1` on a scanned PDF if one is available.

### 7. browser-tabs (drives the user's real browser)

Built for Helium (`helium-browser`); set `PI_BROWSER_BIN` for another Chromium browser. This step needs the user at the GUI:

1. Start pi once and call any browser tool, so it creates `~/.config/pi-browser-tabs/token`.
2. Ask the user to open `helium://extensions`, enable Developer mode, **Load unpacked** `~/.pi/agent/extensions/browser-tabs/extension`, then paste the token in the extension's options.

Check: ask pi to list the browser tabs.

### 8. Other skill tools

- `agent-browser` skill: `npm install -g agent-browser`, then `agent-browser install` for its Chrome.
- `youtube-transcript` skill: `yt-dlp` on PATH.
- `analyze-sessions` skill: `python3` only.
- Subagents (`pi-interactive-subagents`): pi must run inside `tmux`.

### 9. Final check

```bash
pi --version && command -v pdf liteparse tmux jq
git -C ~/.pi status --short   # should be empty: installs and caches are gitignored
```

Start `pi` inside tmux and confirm the extensions loaded without errors (no red messages at startup).

## Keeping machines in sync

```bash
cd ~/.pi && git pull --ff-only     # then /reload in a running pi
```

Commit config changes from `~/.pi` and push to `main`. Machine-local tweaks (a different default model, local llama.cpp overrides) can stay uncommitted.
