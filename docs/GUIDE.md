# The cctap guide

Everything past the first ninety seconds: the status line in detail, terminal
support, what the installer really does, the daemon, configuration,
and troubleshooting. The [README](../README.md) is the short version.

## In Claude Code's own status line

`cctap install-hooks` sets this up for you, and what it puts there is the strip itself:
one glyph per session, in colour, with the red double bang when one of them blocks.
Every session shows you the state of all the others, at the bottom of its own window.
It is added only when you have no status line of your own, it appears in the printed
change list, the same settings backup covers it, and `cctap uninstall-hooks` takes it
out again.

The entry re-runs every two seconds on top of Claude Code's own updates, because the
session that needs you is rarely the one you are typing in. Claude Code hands the
command its session data, so the strip also marks the session you are reading it from:
that number comes back in reverse video, and where there is room it says `you`. Until
your first jump lands, and only while something is actually waiting on you, it adds one
dim hint naming the number to type. After that it never appears again.

If you already have a status line, cctap says so and leaves it exactly as it is. A
status line command may print several lines, so yours can end by running cctap's:

```bash
CCTAP_COLOR=1 node ~/.cctap/bin/cctap.mjs strip
```

The same entry set by hand, for anyone who would rather edit `~/.claude/settings.json`
themselves:

```json
{
  "statusLine": {
    "type": "command",
    "command": "CCTAP_COLOR=1 node ~/.cctap/bin/cctap.mjs strip",
    "refreshInterval": 2
  }
}
```

`CCTAP_COLOR=1` is what keeps the colour: piped output is plain by default, and a
status line is a pipe. That bin path works without a global install. What install-hooks
writes instead is both absolute paths in quotes, so it does not depend on what is on
PATH and a space in your home directory cannot split it. If a version manager later
removes that node, run install-hooks again and the path heals.

Prefer words to glyphs? `cctap status` prints `1 working, 1 blocked, 1 waiting` and
fits the same slot. It is also what the tmux recipes below use.

## Getting to a session

Moved to its own page, one section per OS: [Getting to a session](KEYS.md). The short
of it: a system-wide key is the instant path, `cctap keys setup` carries it as far as
your OS allows, and everything it binds is journaled and undoable.

## Terminal support

| Terminal | Jump | Notes |
|---|---|---|
| macOS Terminal.app | yes, live-verified | AppleScript, matches the tab by tty |
| tmux | yes, live-verified | from inside tmux or from an OS key outside it (moves your attached client), never spawns an attach |
| iTerm2 | yes, same code path as Terminal.app | AppleScript, matches the session by tty |
| kitty | implemented, not live-verified | needs `allow_remote_control yes`; cctap records each session's kitty socket so the jump also works from outside kitty |
| WezTerm | implemented, not live-verified | focuses the right pane; WezTerm cannot bring its own window forward, and cctap says so rather than overclaim |
| Ghostty | awareness only | no way in: Ghostty keybinds cannot run a command, and a pane has no handle to target from outside |
| VS Code terminal | awareness only, by design | notification and strip highlight, no jump |
| Linux | implemented, not live-verified | the suite runs on Linux in CI, but notifications and focusing have not been checked on a physical Linux box |
| Windows, native | not supported in v1 | cctap is built on unix sockets and on AppleScript or tmux for the jump; Windows Terminal has ruled out programmatic tab focus |
| Windows, WSL | works, counts as Linux | the whole loop: hooks, strip and the tmux bind, see [the key on Windows](KEYS.md#the-key-on-windows) |

Where a jump cannot land, cctap says so and falls back to a five second highlight of
that entry in any running strip or top, plus a desktop banner only if you opted in
with `cctap notify on`. Nothing pops up otherwise, that promise holds on the failure
path too.

### Jump exit codes

For anyone scripting around it, a jump reports two things and no more:

- **0**, the jump is done with. It landed, or nothing needed you and cctap said `all
  clear`, or no daemon was running, or the terminal gave no way in and the awareness
  fallback went out instead. That last silence is deliberate: tmux `run-shell` prints a
  "returned N" banner on any nonzero exit, so a jump that already spoke through the
  highlight would end up speaking twice.
- **1**, you named a target that is not there, `cctap 7` with nothing on 7. A script
  asking whether a slot is live needs that answer, so it is the one case that reports
  failure.

## Display details

The three states that want something from you say so in words when the strip has room:
`!! needs you`, `▲ your turn`, `✗ failed`. The words are the first thing dropped as the
strip narrows, before any label is shortened, so a tight pane looks exactly as it did
without them. The calm states stay wordless: a spinner explains itself.

Colour is on the names, not just the glyphs: a whole entry turns green while it works,
red when it is blocked, yellow when it is your turn. Compacting is the exception, a
tinted glyph beside a plain label. The glyph shapes carry the same information on their
own, for anyone who does not see the hues.

As the strip narrows it drops labels before glyphs, and the numbers go with the glyphs
rather than with the labels, because the number is what you type: `1 ⠴ │ 2 !!` is a
perfectly usable strip.

The ascii theme (`| / - \` spinner, `!`, `^`, `X`, `o`, `.`) is picked automatically on
a plain `TERM`, a non-UTF-8 locale, or a Japanese, Korean or Chinese locale, where
terminals render ambiguous-width characters two cells wide. Font support is not
detectable. If glyphs show as boxes, set `CCTAP_THEME=ascii`. `cctap strip` and
`cctap top` also take `--no-color`.

## What install-hooks does

It edits one file of yours, the user-level `~/.claude/settings.json`. Everything else it
writes is its own: the three bundles in `~/.cctap/bin/` and an `~/.cctap/install.json`
recording the node path and the forwarder path it registered.

1. Backs the file up before changing it, to `settings.json.cctap-bak-<timestamp>`, and
   prints the path.
2. Adds 19 hook registrations, all pointing at `~/.cctap/bin/hook-forward.mjs` with the
   absolute path of the node that installed them.
3. Adds a `statusLine` entry that runs the strip, but only if you have none. A status
   line that is already there and is not ours is never rewritten, only reported.
   `cctap install-hooks --no-status-line` skips this step entirely.
4. Leaves every hook that is not ours untouched, in place and in order.
5. Prints a line per change, so you can see exactly what changed.
6. Writes nothing, and takes no backup, on a run that changes nothing.

Run it again any time. It is idempotent, and it heals the recorded node path after a
version manager upgrade. `cctap install-hooks --dry-run` shows the plan and writes
nothing.

Size, so nothing is a surprise: an empty settings file grows to about 320 lines and
8 KB, because each of the 19 registrations is a nested object with an absolute node
path. The round trip is exact. `cctap uninstall-hooks` on a file that started as `{}`
leaves `{}`.

The hooks run a small forwarder that writes one line to a unix socket. It always exits
0, never writes to stdout, and gives up after 100 milliseconds. The hooks are
registered async, so Claude never waits on cctap. Each event costs roughly 45 ms of a
detached node process. If the daemon is not running the forwarder starts one, and
failing that it spools the line so nothing is lost.

The file your hooks run is about 470 readable lines at `~/.cctap/bin/hook-forward.mjs`,
and the published tarball holds nothing beyond the three bundles, the README and the
license. Six files, inspect them all.

## The daemon

One process holds the state. It starts on the first hook event, so you never start it
by hand. It uses about 40 MB of RSS, wakes once a minute to sweep dead sessions and
refresh branches, and exits by itself after 24 hours with no sessions and no renderers
attached.

```bash
cctap stop      # stop it now
cctap daemon    # run it in the foreground instead, to watch what it does
```

`CCTAP_NO_EXEC=1` disables every external command it can run: no notifications, no
jump, no git, no ps.

## Configuration

`~/.cctap/config.json`, all optional:

```json
{ "theme": "unicode", "notify": { "enabled": false, "permission_wait": true, "failed": true, "your_turn": true } }
```

`notify.enabled` is the desktop banner switch, off unless you say otherwise. `cctap
notify on` and `cctap notify off` write it for you, and bare `cctap notify` prints
where it stands. The per-state keys apply once banners are on. The daemon reads this at
start, so `cctap stop` makes a change take effect immediately.

`"blink": true` brings back the blinking permission glyph. It is off by default because
blink is hard on photosensitive and vestibular readers, and red plus bold already reads
loud. `"motion": false` freezes the spinner and stops every ticker, for a terminal that
should hold still. `CCTAP_BLINK=1` and `CCTAP_MOTION=0` do the same for one shell,
without editing the file.

`"socket": "/tmp/cctap.sock"` moves the unix socket out of the tree. You only need it
if your home directory sits deep enough that the socket path passes the kernel limit
for unix socket paths, 103 bytes on macOS and 107 on Linux. cctap refuses to bind or
connect past that limit rather than let the kernel truncate the path, because two
truncated paths answer as one socket. A shorter `CCTAP_DIR` fixes it just as well.

| Variable | Effect |
|---|---|
| `CCTAP_DIR` | relocate `~/.cctap` (socket, state, spool, bin) |
| `CCTAP_CLAUDE_SETTINGS` | override the Claude Code settings file install-hooks edits |
| `CCTAP_THEME` | `unicode` or `ascii` |
| `CCTAP_NOTIFY=off` | force banners, bell and tmux messages off, whatever the config says |
| `CCTAP_NO_EXEC=1` | never spawn an external command, so no notifications and no jump |
| `CCTAP_BELL=1` | ring the terminal bell alongside every banner |
| `CCTAP_BLINK=1` | bring back the blinking permission glyph (off by default) |
| `CCTAP_MOTION=0` | freeze the spinner and stop every ticker (`1` forces motion back on) |
| `NO_COLOR` | drop colour, keep reverse video and bold |
| `FORCE_COLOR` | `0` or `false` turns escapes off, anything else turns them on |
| `CCTAP_COLOR` | `0` turns every escape off, `1` forces them on |
| `CCTAP_DEBUG=1` | the hook forwarder logs to stderr |

## Troubleshooting

`cctap doctor` is the first stop for everything below. It walks the hook registrations
and the node path recorded for them, the daemon over a real socket round trip with a
version match, the socket and directory permissions, the spool backlog, a stale
`daemon.json`, the terminal adapter, and macOS Automation consent.

**"Script Editor" wants to send a notification.** You only see this after `cctap notify
on`, since banners are off by default. It is cctap: macOS attributes `osascript`
notifications to Script Editor, so every banner cctap posts on macOS carries that name.
Nothing else is involved. `cctap doctor` says the same thing. `cctap notify off` takes
them away again, or turn off individual states in `~/.cctap/config.json`, for example
`{"notify": {"your_turn": false}}`.

**Jump does nothing and mentions Automation, or error -1743.** macOS asks once for
permission to control your terminal. Allow it in System Settings > Privacy & Security >
Automation, then run `cctap doctor` to confirm. Run `cctap jump --dry-run` first if you
want to see the exact command before anything is sent.

**The jump said it worked, but nothing moved.** Most often it did work. A jump raises
the target window and moves the keyboard focus there, so if that window was already
fully visible beside the one you were in, there is nothing to see: the same pixels stay
on screen and only the title bar changes. Two sessions as tabs in one window make it
obvious, because the tab visibly switches. `cat ~/.cctap/jump.json` records what the
last jump did and whether it landed.

**Hooks are installed but nothing shows up.** Claude Code watches its settings file, so
hooks normally start working within seconds, with no restart. If one session stays
missing, restart that session, then check `cctap doctor`.

**The strip is blank.** The daemon starts on the first hook event. `cctap doctor`
reports whether it is running.

**A state stopped firing after a Claude Code update.** Hook payloads were verified
against Claude Code 2.1.220 (2026-08-02). Run `cctap doctor`: it lists every
registration that has never fired.

**`claude -p` sessions never show `your_turn`.** Print mode fires no `Stop` hook, so
those sessions walk from working straight to ended. Interactive sessions are the point
of cctap, so this is documented rather than worked around.

**A session hangs around after I killed it.** The daemon checks the parent process
every 60 seconds and drops a dead session after a 60 second grace, so give it two
minutes.

## Uninstall, in detail

```bash
cctap uninstall-hooks --dry-run  # show what would be removed, write nothing
cctap uninstall-hooks            # removes only cctap's hooks, keeps ~/.cctap
cctap uninstall-hooks --purge    # also removes ~/.cctap
```

It backs up your settings file before changing it, prints what it removed and what it
left alone, and stops the daemon. It also removes the status line, if the one in your
settings is the one cctap wrote. Foreign hooks and a foreign status line are never touched. Claude
Code picks the removal up live, and any session that still reports in only needs a
restart.

Uninstall matches on the install it can see. If you installed with `CCTAP_DIR` set, set
the same value when you uninstall, otherwise nothing in the file looks like ours and
the run is a no-op that says so.
