# browser-tabs

Browser tools for pi that work in your real browser (built and tested with Helium) through a small Manifest V3 extension (Pi Browser Bridge 0.5.0). It deliberately does not use the DevTools protocol (`chrome.debugger`, `--remote-debugging-port`): that is what puts a browser in automation mode, and what bot detection looks for. Here the page sees a normal profile with your cookies, no `navigator.webdriver`, and no "controlled by automated software" banner.

| Tool | What it does |
|---|---|
| `browser_tabs` | List open tabs (title, URL, whether pi may use each) |
| `browser_read` | Read a tab as text, with refs like `e5` (or `f3:e5` inside an iframe) on links, buttons and fields. `diff: true` returns only what changed since the last read |
| `browser_act` | click, double_click, hover, type, press, select, check, uncheck, scroll, wait_text, `click_xy` (pixels of the last screenshot), `upload` (file into a file input). `trusted: true` = real mouse (opt-in) |
| `browser_screenshot` | Screenshot the visible part of a tab; `annotate` boxes and labels interactive elements with their refs |
| `browser_console` | Console errors and failed network requests of a tab (capture starts on the first call; `reload: true` catches the page load) |
| `browser_tab` | launch the browser, open, navigate, back, forward, reload, focus, close |
| `browser_point` | Optional. Find something by how it looks (vision model) and click it: canvas, icons, anything without a ref |
| `browser_look` | Optional. Ask a vision model what the page shows (canvas text, images, charts) |

`tab` is optional everywhere: it defaults to the tab used last. The companion skill `skills/browser-tabs` tells the agent when to use these, and when to use `agent-browser` instead.

## What the 0.5.0 extension reads and does

- **All frames**, including cross-origin iframes (payment widgets, embeds). Each frame is marked `<frame f3 https://origin>` and its refs are `f3:e5`; the top page keeps `e5`.
- **Closed shadow roots** (through `chrome.dom.openOrClosedShadowRoot`), so web components are visible.
- **Widgets**: ARIA combobox, listbox and menu pickers (the popup is opened, the option picked by label or prefix); native `<select>` (an option ref is mapped to its dropdown, and the value is verified afterwards, with a wait while the options load); datalist inputs; contenteditable editors; date, time and range inputs (free text like `Nov 6, 2026` becomes `2026-11-06`).
- **Wider interactive detection**: `tabindex`, `onclick`, and `cursor: pointer` elements that carry no role; `aria-hidden` subtrees are skipped.
- **Stale refs recover**: a ref whose element was replaced by a re-render is re-found when exactly one element still has the same role and name. Unknown or unrecoverable refs answer "the page changed since your last read: read again". A click that changes the URL says so.
- **Duplicate labels**: when several buttons read the same (`Add to cart`), the nearest heading is added: `[e24 button "Add to cart" (for "Wireless mouse")]`.
- **Console and failed requests** (`browser_console`), through `webRequest` and small capture scripts registered for the origin of a tab only after you first ask for its console.
- **Upload**: the file is read by pi (max 5 MB) and handed to the page as a real `File`.

## Safety gate

There is no separate core around these tools, so `browser_act` checks itself. Before a click, type, Enter, upload or `click_xy` it asks the extension for facts about the target (`describe`: tag, label, field type, the form around it and its method) and decides:

| Target | Verdict |
|---|---|
| password, one-time-code, card number/CVC fields (by type, autocomplete, label) | blocked: the model is told the user must type it in the browser |
| buy, order, pay, send, submit, delete, post, confirm, sign up, log out ... (by label), a submit that POSTs a form with typed data, Enter in such a form, anything inside a payment-provider frame | asks you (`ctx.ui.confirm`) |
| upload | always asks, shows the file; `.ssh`, `.env`, keys, `.pi`, over 5 MB, missing files are refused |
| trusted real-mouse click | always asks |
| anything else | runs |

With no UI to ask (print mode, subagents) an "ask" becomes a block with a clear reason, so nothing risky happens unattended. Page text in `browser_read`, `browser_act`, `browser_look`, `browser_console` and tab titles is wrapped in `<untrusted>` plus one line saying it is data, not instructions. A timeout on an act is reported as "outcome unknown: read the page before retrying", never as success or failure.

## Changes and snapshot files

`browser_read` with `diff: true` (and `browser_act` with `show_changes: true`) compares the page text with the previous read of the same tab and returns only the removed (`-`) and added (`+`) lines. Refs are stable across reads. If the tab navigated, or most of the page changed, the full page is returned instead.

Whole-page reads are also written to `~/.cache/pi-browser-tabs/<pi pid>/`: `tabs.md`, `<host>-t<id>.md` (latest read), `<host>-t<id>.diff.md` and `shot-*.jpg`. Other agents and subagents can read or grep them. The directory is deleted when the session ends.

## Setup

1. Start pi once so it creates the token file `~/.config/pi-browser-tabs/token`. The first browser tool call is enough.
2. In Helium open `helium://extensions`, turn on **Developer mode**, **Load unpacked**, and pick `~/.pi/agent/extensions/browser-tabs/extension`.
3. Open the extension's **Details → Extension options**, paste the token, and save.
4. Check: ask pi to list your browser tabs.

**Upgrading from 0.1.0:** the extension is loaded from this folder, so just open `helium://extensions` and press the reload arrow on the Pi Browser Bridge card (a permissions prompt for `webNavigation` and `webRequest` may appear; they are needed for frames and the console). Your token and options are kept. Until you reload, the new features answer "reload the Pi Browser Bridge extension" and the old ones keep working.

Each pi session binds the first free port from 17420 up (10 ports), and the extension polls all of them, so several sessions can use the browser at once. To move the range, set `PI_BROWSER_PORT` for pi and the same first port in the extension options. Set `PI_BROWSER_BIN` if your browser binary isn't `helium-browser`.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PI_BROWSER_BIN` | `helium-browser` | binary for `browser_tab launch` |
| `PI_BROWSER_PORT` | `17420` | first bridge port |
| `PI_BROWSER_TOKEN_FILE` | `~/.config/pi-browser-tabs/token` | token (tests use a throwaway one) |
| `PI_BROWSER_CLIENT` | `chromium` | browser kind the bridge serves (`any` turns the check off) |
| `PI_BROWSER_VL_URL` | `LLAMA_BASE_URL`, else pi's llama.cpp entry in `auth.json`, else `http://localhost:11434` | llama.cpp router for `browser_point` / `browser_look` |
| `PI_BROWSER_VL_MODEL` | first router model whose id contains `vl` | vision model |
| `PI_BROWSER_TRUSTED` | unset | `1` enables `trusted: true` clicks |
| `PI_BROWSER_CALIBRATION` | `~/.pi-operator/input-calibration.json` | ydotool pointer calibration |

### Vision tools (optional)

`browser_point` and `browser_look` send a screenshot to a vision model on your llama.cpp router (LFM3-VL: boxes come back in a 0-1000 space, greedy decoding; the vision tools take full-resolution screenshots, and one much larger than 1024 px gets a second zoom pass on a native-resolution crop; that needs `sharp`, installed with `npm install --ignore-scripts` in this folder, and without it the screenshot is sent as it is). If no model with `vl` in its id answers, the tools say so and everything else works.

### Trusted click (optional, off by default)

Some widgets ignore synthetic events (`isTrusted` false). With `PI_BROWSER_TRUSTED=1`, `browser_act` with `trusted: true` finds the element's screen position (window position on X11; on niri the tile position, cross-checked against the vision model on a `grim` capture, because Wayland hides window coordinates), asks you, and clicks with `ydotool` (`xdotool` on X11). ydotool needs the pointer calibration file; without it the click is refused with a message. `PI_BROWSER_DRYRUN=1` prints the commands instead.

## Sharing

pi can list every tab's title and URL, but it can only read or act on:

- tabs you share, by clicking the extension's toolbar button on that tab (click again to revoke), and
- tabs it opened itself, which are grouped in a blue "Pi" tab group. These belong to the session that opened them; other pi sessions (and subagents) cannot control them. Tabs you share are usable by every session.

A shared tab shows two indicators: a `pi` badge on the toolbar button, and its own green **shared** tab group in the tab strip. Both are native browser UI, so the page can't see them; the extension never edits the page's title or favicon.

| Command | Default | Effect |
|---|---|---|
| Share or stop sharing the current tab | `Alt+Shift+P` | toggles the current tab |
| Stop sharing every tab | none | revokes all grants at once |

Rebind or set them at `helium://extensions/shortcuts`. The extension options have an "allow every tab" switch, off by default. Grants live in session storage and are forgotten when the browser closes.

## How it works

```
pi session (index.ts) ── HTTP long-poll ── 127.0.0.1:17420..17429 (one port per session) ── extension service worker ── page.js in every frame
```

The bridge (`bridge.ts`) listens on loopback only. Requests need the shared token, a loopback `Host` header, an extension `Origin` if one is sent, and a browser kind (`X-Pi-Client`, default chromium; a 0.1.0 extension sends none and counts as chromium). `backend.ts` turns tool calls into bridge commands and detects an old extension (`info` op missing). `shared.ts` holds the gate verdicts, duplicate labels and console formatting; `eyes.ts` and `trusted.ts` are the optional parts. No dependencies beyond what pi provides and node built-ins.

`page.js` is injected into the isolated world of each frame: page scripts can't see it, and nothing is added to the page's DOM. Element refs live in a `WeakRef` map. Input is dispatched with randomised, human-paced timing.

## Tests

`node test/run.mjs` loads the extension into Chrome for Testing (`~/.agent-browser/browsers/chrome-*`, headless, throwaway profile), runs the bridge on port 17437 with a throwaway token and drives the tools through a mock `pi` against the fixtures in `test/fixtures/`. It never touches your Helium, ports 17420-17429 or the real token. Set `BT_OLD_EXT` to a folder with a 0.1.0 copy of the extension to also test the old-extension fallback.

## Limits

- Events from content scripts have no user activation. Most sites accept them; some payment widgets and anti-bot checks can tell. The agent is told to hand those steps to you (or use `trusted`).
- Screenshots cover the visible viewport only, via `chrome.tabs.captureVisibleTab`: a background tab is switched to briefly (and the previous tab restored), and the window must not be minimized.
- Console capture starts with the first `browser_console` call on a tab; there is no response-body or timing view. Use `agent-browser` for deeper debugging.
- Up to 10 pi sessions at a time; an 11th gets a clear "all ports in use" error. A subagent is its own session, so it cannot reuse tabs its parent opened unless you share them.
- If the extension's service worker is asleep, the first call can take a few seconds while it wakes.

### Real-input and zoom test (2026-11-07)

A visible Chrome for Testing window (throwaway profile, extension copy on a test port), fullscreen on niri workspace 2:
the trusted click (`PI_BROWSER_TRUSTED=1`, placed by the eyes, ydotool with the saved calibration) reached a button
that only counts `isTrusted` clicks; `browser_point` hit 4/4 small targets (28 px) on `test/fixtures/zoom.html` in a
1920x1080 viewport, each with the zoom pass, 2.2-3.1 s per call (vision model LFM3-VL-2B). Found and fixed on the way:
Chrome's 2-captures-per-second limit (screenshots are now spaced 650 ms apart), and the eyes now get full-resolution
screenshots instead of the 1568 px cap meant for images sent to the planner.
