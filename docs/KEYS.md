# Getting to a session

The jump, one OS at a time: the key, picking it, what gets written down, and the
paths that need no key at all. The [guide](GUIDE.md) covers the rest of the product,
the [README](../README.md) is the short version.

The instant path is a system-wide key, and it is the only instant one: while Claude is
mid-turn, everything typed into the session queues until the whole turn finishes, so no
typed command in any tool can move you at that moment, and that moment is exactly when
another session usually taps your shoulder. A key pressed at the OS level does not care
what Claude is doing. Setup takes about a minute, runs in the shell you installed from
or from inside a session by asking Claude to run it, and `cctap keys` prints every path
below filled in with your real paths.

## The key on macOS

```bash
cctap keys setup     # line on the clipboard, Shortcuts opens, the steps are printed
```

No program is allowed to create a shortcut for you, so setup carries you to the
doorstep: it copies the jump command, opens Shortcuts on a new shortcut, and prints
the exact clicks. Two of them are easy to miss, so in advance: the "Run Shell Script"
action arrives disabled until "Allow Running Scripts" is on (the action card offers
Open Preferences, the switch lives under Shortcuts > Settings > Advanced), and the
keyboard shortcut field hides behind the small (i) at the top right of the shortcut
window. The first press pops a second Automation consent naming Shortcuts as the
asker, so press the key once right after assigning it, while you are still at the
desktop. Raycast, Alfred and Hammerspoon take the same command line.

## The key on Linux

```bash
cctap keys setup super+j     # GNOME: writes the binding for you, and prints the undo
```

On GNOME the binding is written through `gsettings`, read back to confirm it really
landed, and printed together with the exact undo. On any other desktop setup prints
the line to bind in your own keyboard settings, which is what KDE and the rest want
anyway.

## The key in tmux, which is also the SSH and WSL answer

```bash
cctap keys setup          # inside tmux: binds prefix + g live, nothing written
cctap keys setup --os     # inside tmux, when you want the OS-wide key instead
```

The bind lands in the running server: no file touched, `tmux unbind-key g` takes it
back, and the output includes the one `~/.tmux.conf` line that makes it survive a
server restart. A key that is already bound to something else is never taken over
unless you pass it explicitly, and then the old binding is printed so you can restore
it. On a Linux box or over SSH, tmux plus this bind is the whole loop, and an OS
hotkey firing `cctap jump` from outside tmux still lands: cctap moves your most
recently active attached client to the right session.

## The key on Windows

The loop runs inside WSL and counts as Linux: hooks, strip and the tmux bind all work
there unchanged. What Windows itself cannot give you is the last hop, a system key
that focuses the right tab. Windows Terminal has ruled out programmatic tab focus
(the feature request was closed as not planned), so cctap does not pretend otherwise.
What works instead:

1. Keep the sessions in tmux inside WSL and bind the jump there: `cctap keys setup`
   from a WSL shell inside tmux binds `prefix + g` live.
2. Give the terminal window itself a summon key, so the full-screen moment is two
   presses: summon the window, then `prefix + g`.
   - Windows Terminal, in settings.json under `actions`:
     `{ "keys": "ctrl+alt+j", "command": { "action": "globalSummon" } }`
   - or AutoHotkey v2, one line: `#j::WinActivate "ahk_exe WindowsTerminal.exe"`
   - or PowerToys Keyboard Manager, mapping a key to launch `wt.exe`, which focuses
     the running window when one exists.

A native Windows jump with no WSL stays out of scope for v1: the daemon needs unix
sockets, and the jump needs AppleScript or tmux, and neither exists there.

## Picking a key, and what gets written down

Ctrl+Cmd+J is free on a stock Mac, Super+J on a stock GNOME. Avoid Alt with a digit
(Claude Code binds Alt+1 through Alt+9 in its agent view) and Option+letter in a
terminal (it reads as Meta). The bound command uses absolute quoted paths, so a
version manager cannot break it:

```
"/absolute/path/to/node" "/Users/you/.cctap/bin/cctap.mjs" jump
"/absolute/path/to/node" "/Users/you/.cctap/bin/cctap.mjs" jump 2
```

The numbered variants give you a key per session, if you want that instead. And
everything setup binds is written down: `cctap keys status` reads each binding back
and says whether it is still yours, `cctap keys undo` takes the newest one back,
`--all` takes them all.

## iTerm2 hotkey window, on macOS

iTerm2 can float a dedicated window over everything, full screen included, on one
key. Make a profile whose command is your absolute `cctap.mjs top` line (`cctap
doctor` prints the jump line, swap `jump` for `top`), then in that profile's Keys tab
enable "A hotkey opens a dedicated window with this profile" and pick a key. That key
now drops the live session list over whatever you are doing, Enter jumps, the window
slides away. `keys setup` does not wire this one on purpose: the recipe stays manual
until the automated version is verified on real hardware.

## No key at all: the numbers

Park a strip or a `cctap top` where you can see it, and the number under each glyph
is also its key: press `1` and you are in session 1. No setup, no permissions, works
the same on macOS and Linux. `q` or Ctrl-C leaves the pane, and the pane keeps
running after a jump, because the focus moves and the strip stays.

```bash
tmux split-window -vbf -l 1 "cctap strip"   # a one-line strip pane, then press a number
tmux set -g status-right '#(cctap status)'  # or words in the bar
```

From any shell, in either workflow:

```bash
cctap        # the session that needs you most
cctap 2      # the session holding number 2
```

A session keeps its number for its whole life, so the one you learned yesterday still
works. Inside `cctap top`, j/k and Enter work too.
