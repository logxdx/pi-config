# browser-tabs

Browser tools for pi that work in your real browser (built and tested with Helium) through a small Manifest V3 extension. It deliberately does not use the DevTools protocol (`chrome.debugger`, `--remote-debugging-port`): that is what puts a browser in automation mode, and what bot detection looks for. Here the page sees a normal profile with your cookies, no `navigator.webdriver`, and no "controlled by automated software" banner.

| Tool | What it does |
|---|---|
| `browser_tabs` | List open tabs (title, URL, whether pi may use each) |
| `browser_read` | Read a tab as text, with refs like `e5` on links, buttons and fields |
| `browser_act` | click, double_click, hover, type, press, select, check, uncheck, scroll, wait_text |
| `browser_tab` | launch the browser, open, navigate, back, forward, reload, focus, close |

The companion skill `skills/browser-tabs` tells the agent when to use these, and when to use `agent-browser` instead.

## Setup

1. Start pi once so it creates the token file `~/.config/pi-browser-tabs/token`. The first browser tool call is enough.
2. In Helium open `helium://extensions`, turn on **Developer mode**, **Load unpacked**, and pick `~/.pi/agent/extensions/browser-tabs/extension`.
3. Open the extension's **Details → Extension options**, paste the token, and save.
4. Check: ask pi to list your browser tabs.

If port 17420 is taken, set `PI_BROWSER_PORT` for pi and the same port in the extension options. Set `PI_BROWSER_BIN` if your browser binary isn't `helium-browser`.

## Sharing

pi can list every tab's title and URL, but it can only read or act on:

- tabs you share, by clicking the extension's toolbar button on that tab (click again to revoke), and
- tabs it opened itself, which are grouped in a blue "Pi" tab group.

A shared tab shows two indicators: a `pi` badge on the toolbar button, and its own green **shared** tab group in the tab strip. Both are native browser UI, so the page can't see them; the extension never edits the page's title or favicon. A tab that is already in one of your own groups keeps it and only gets the badge. Sharing doesn't move tabs, and revoking removes the group.

Keyboard shortcuts do the same as the toolbar button:

| Command | Default | Effect |
|---|---|---|
| Share or stop sharing the current tab | `Alt+Shift+P` | toggles the current tab |
| Stop sharing every tab | none | revokes all grants at once |

Rebind or set them at `helium://extensions/shortcuts` (Chromium's shortcuts page). If another extension or the OS already uses `Alt+Shift+P`, the default is silently not applied; set one there.

The extension options have an "allow every tab" switch, off by default. Grants live in session storage and are forgotten when the browser closes.

## How it works

```
pi extension (index.ts) ── HTTP long-poll ── 127.0.0.1:17420 ── extension service worker ── page.js in the tab
```

The bridge (`bridge.ts`) listens on loopback only. Requests need the shared token, a loopback `Host` header, and an extension `Origin` if one is sent. The extension polls for commands and posts results back; there is no WebSocket, so no dependencies.

`page.js` is injected into the tab's isolated world: page scripts can't see it, and nothing is added to the page's DOM. Element refs live in a `WeakRef` map, not in attributes. Input is dispatched with randomised, human-paced timing. Text goes in through `execCommand("insertText")` where possible, which produces real input events.

## Limits

- Events from content scripts have no user activation. Most sites accept them; some payment widgets and anti-bot checks can tell. The agent is told to hand those steps to you.
- Only the top page and same-origin iframes are read.
- No screenshots, console or network access. Use `agent-browser` for debugging.
- One pi session owns the bridge port. A second concurrent session gets a clear "port in use" error.
- If the extension's service worker is asleep, the first call can take a few seconds while it wakes.
