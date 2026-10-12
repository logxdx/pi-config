---
name: agent-browser
description: Drive a real Chrome browser from bash with the agent-browser CLI — open pages, read them as text, click, fill forms, check console errors and network requests. Use for JavaScript-heavy sites, logins, multi-step web flows, debugging a live web app, or when web_fetch can't get the content.
---

# agent-browser

`agent-browser` (installed, on PATH) controls a persistent headless Chrome. Pages are read as text: `snapshot` gives an accessibility tree whose elements carry refs, printed as `[ref=e1]` and passed to commands as `@e1`:

```
- link "Learn more" [ref=e1]        →  agent-browser --session pi click @e1
```

## Rules

- **Always pass `--session pi`** (before the command): `agent-browser --session pi open https://example.com`
- **Text only:** read pages with `snapshot`, `read` and `get text`.
- **Re-snapshot after anything that changes the page** (navigation, click, submit); refs from an old page don't apply.
- **Close when done:** `agent-browser --session pi close`.

## The core loop

```bash
agent-browser --session pi open <url>     # 1. open
agent-browser --session pi snapshot -i    # 2. see interactive elements with refs
agent-browser --session pi click @e3      # 3. act on a ref
agent-browser --session pi snapshot -i    # 4. re-snapshot to see the result
```

## Core commands

All take `--session pi` `<sel>` is a ref like `@e3` or a CSS selector.

**Navigate**
- `open <url>` — load a URL in the current tab
- `back` / `forward` / `reload` — history navigation
- `close` — close the browser for this session

**Read**
- `snapshot -i` — interactive elements with refs (add `-u` for link URLs, `-c` compact, `-s "<css>"` to scope)
- `snapshot` — full accessibility tree (verbose; use when you need the page's text structure)
- `read` — the active tab's rendered page as readable text
- `read <url>` — fetch a URL as markdown/text without the browser (good for docs; `--filter <text>`, `--outline`)
- `get text <sel>` — visible text of an element
- `get title` / `get url` — page title / current URL
- `get value <sel>` / `get attr <sel> <name>` — input value / attribute
- `get count <sel>` — number of matching elements

**Interact**
- `click <sel>` — click an element
- `fill <sel> <text>` — clear an input and type text
- `type <sel> <text>` — type without clearing
- `press <key>` — press a key (`Enter`, `Tab`, `Escape`, `Control+a`)
- `select <sel> <value>` — choose a dropdown option
- `check <sel>` / `uncheck <sel>` — toggle a checkbox
- `scroll down [px]` / `scroll up [px]` — scroll the page
- `find text "<text>" click` — click by visible text when no ref fits (also `find role button --name "Save" click`, `find label "Email" fill "a@b.c"`)

**Wait**
- `wait <sel>` — until an element appears
- `wait --text "<text>"` — until text appears
- `wait --load load` — until the page load event (avoid `networkidle`: pages with live connections never settle)
- `wait <ms>` — fixed delay

**Debug**
- `console` — browser console output (`--clear` to reset)
- `errors` — uncaught JavaScript errors
- `network requests` — captured requests (`--filter api`, `--type xhr,fetch`, `--status 4xx`)
- `network request <id>` — one request's full detail, including the body
- `eval "<js>"` — run JavaScript in the page and print the result
- `cookies` / `storage local` — cookies / localStorage

**Tabs and batching**
- `tab list` / `tab new [url]` / `tab <tN>` / `tab close` — manage tabs
- `batch "open <url>" "snapshot -i"` — run several commands in one call

## Finding anything else

Narrow down before reading big files:

1. `agent-browser <command> --help` — exact flags for one command (for subcommands use the parent: `agent-browser network --help`)
2. `references/help-short.md` — every command with a one-line summary (`agent-browser --help`, ~26 KB). Grep it: `grep -n -i "upload\|download" SKILL_DIR/references/help-short.md`
3. `references/help-long.md` — full guide with workflows and examples (~145 KB). Don't read it whole: list sections with `grep -n '^#' SKILL_DIR/references/help-long.md`, then read only the relevant section with the `read` tool (offset/limit).
4. Topic docs (authentication, sessions, proxies, …): `ls "$(agent-browser skills path core)/references"`

