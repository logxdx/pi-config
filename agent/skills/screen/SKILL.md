---
name: screen
description: Point at, click and type into anything on the user's real desktop (niri/Wayland) — native apps, the top bar, dialogs, windows that are not a web page. Finds things by how they look with a local vision model and shows a pointer ring on screen. Use when the user asks to point at, click, or type into something on their screen, or to press keys/shortcuts in the focused window. For web pages use browser-tabs or agent-browser instead (refs are more reliable than pixels).
---

# screen

Use the `lop-screen` command (if it is not found, use `~/.pi/agent/skills/screen/lop-screen`). It works on the focused monitor.

```bash
lop-screen point "Wi-Fi icon in the top bar"            # find it and show the pointer ring (no click)
lop-screen point "Save button" --click                  # ... and click it (--double, --right also work)
lop-screen point "search field" --type "invoice 2026"   # click it, then type
lop-screen type "hello world"                           # type into the focused window
lop-screen press ctrl+l                                 # keys: Return, Escape, Tab, BackSpace, ctrl+shift+t, super+d
lop-screen stop                                         # remove the pointer overlay
```

Clicks, `type` and `press` print the focused window afterwards. Check it is the window you meant before typing more.

## Name the target concretely

The vision model (LFM3-VL-2B) finds what you describe, even when it is not there. Say what it looks like and where:
"the time in the top bar", "blue Send button at the bottom of the dialog", not "clock" or "button"
(on this desktop "clock in the top bar" hit the time once and the workspace indicator the next time).
A generic name picks the wrong item. If `point` cannot find it, rephrase once, then ask the user.

## Rules

- Point first, without `--click`, when you are not sure: the user sees the ring and the printed coordinates.
- Clicks and typing act on the user's real desktop. Do not click Send, Buy, Delete or similar without the user's go-ahead.
- `type`/`press` go to the focused window. Click into the right field first.

## Requirements

- An LFM3-VL model on pi's llama.cpp router (`~/llama.cpp/serve-pi.sh`, port 11434). `point` uses `PI_SCREEN_MODEL`
  if set, else the router's first model id containing `vl`. If it says the router is not running or has no vision
  model, tell the user; do not start or reconfigure the router yourself.
- `grim`, `niri`, `wtype`, and `ydotool` with `ydotoold` on `/tmp/.ydotool_socket`.
- Clicks move with `ydotool mousemove --absolute`, which only lands when pointer acceleration is flat.
