<div align="center">

<img src="https://raw.githubusercontent.com/chipmates/cctap/main/docs/logo.png" alt="cctap logo: a shell prompt with a red block cursor, a session waiting on you" width="128" height="128">

# cctap

The shoulder tap for parallel Claude Code sessions.

*Four sessions, full screen. One finished minutes ago. You were watching the wrong window.*

[![npm version](https://img.shields.io/npm/v/@chipmates/cctap.svg)](https://www.npmjs.com/package/@chipmates/cctap)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/chipmates/cctap/actions/workflows/ci.yml/badge.svg)](https://github.com/chipmates/cctap/actions/workflows/ci.yml)
[![local only](https://img.shields.io/badge/local%20only-no%20network%20calls-2ea44f)](docs/PRIVACY.md)

*An independent project, not affiliated with Anthropic.*

<img src="https://raw.githubusercontent.com/chipmates/cctap/main/docs/statusline.png" alt="The strip at the bottom of a Claude Code session, four sessions on the board: 1 authsvc marked as the session you are in, 2 blog with a green spinner, 3 docs in red saying needs you, 4 infra in yellow saying your turn, then a dim hint naming the command that jumps to number 3." width="736">

After the install, this line shows up by itself at the bottom of every Claude Code
session. When one of them turns red, your jump key puts you there.

<img src="https://raw.githubusercontent.com/chipmates/cctap/main/docs/demo.gif" alt="The same line, animated. Four sessions on the board: authsvc marked as yours, docs red saying needs you, infra at the yellow your-turn triangle. blog fans out subagents, a x2 counter becomes x5, its own turn ends while they run so it stays a working spinner, and when the last subagent finishes it flips to the yellow triangle." width="736">

The same line, animated: agents fan out and come home, and the session that needs you
stays red until you take care of it.

</div>

A session that is working does not need you. The one that stopped does, and with four
windows open, the stop is easy to miss. cctap watches every session through its hooks
and adds one line at the bottom of each: a numbered glyph per session, green while it
works, red and in words when one waits on you. The number is how you get there, and one
key lands you in the right window, `prefix + g` inside tmux. On a terminal cctap cannot
drive, it highlights the session rather than pretending it landed. Notifications tell
you that something happened. cctap takes you to it.

> Local only. cctap reads your Claude Code hook events, keeps the state in a daemon on a
> unix socket under `~/.cctap/`, and makes no network calls of any kind. Your prompts
> never reach it. [Privacy, exactly.](docs/PRIVACY.md)

## Quick start

macOS and Linux, and on Windows inside WSL. [What that means on Windows.](docs/KEYS.md#the-key-on-windows)

Setup is two commands. The first installs the tap:

```bash
npx @chipmates/cctap install-hooks     # backs your settings up before changing them, --dry-run previews it all
```

Claude Code picks the hooks up live, normally within seconds. From then on the strip
sits at the bottom of every session. Nothing to copy here, this is just how it looks,
for example with four sessions running:

```
1 authsvc ⠧ you │ 2 blog ⠴ │ 3 docs !! needs you │ 4 infra ▲ your turn
```

The second command gives you the jump key that takes you there:

```bash
npx @chipmates/cctap keys setup     # macOS: guided Shortcuts setup. GNOME: written for you. tmux: bound live
```

One press and you are in the session that needs you, at any moment, full screen
included, even while Claude is mid-turn in the session you are sitting in. Inside tmux
that press is `prefix + g`, and on a terminal cctap cannot drive it becomes a highlight
rather than a landing. Setup carries you as far as your OS allows, about a minute
either way: macOS copies the command and opens Shortcuts for the last few steps, GNOME
writes the binding and shows the undo, tmux binds the key live. Nothing is bound
without you asking, everything bound is journaled, and undo is one command.
[The key, per OS.](docs/KEYS.md)

A shell works too, if you keep one open:

```bash
npm install -g @chipmates/cctap
cctap 2      # straight to the session holding number 2
cctap        # whatever needs you most
```

cctap does not pop anything up. Desktop banners exist, they are off until you ask
(`cctap notify on`).

Want to see it move before wiring anything up:

```bash
npx @chipmates/cctap strip                 # in one window, Ctrl-C to leave
npx @chipmates/cctap simulate busy-day     # in another, runs about 30 seconds
```

## What you get

- **The strip at the bottom of every Claude Code session**, wired by `install-hooks`
  unless you already have a status line: each session a numbered coloured glyph, words
  when one needs you, a marker on the session you are reading it from. This is the
  product. You look down, you know everything.
- **`cctap`** the jump. Oldest permission prompt first, then failures, then finished
  turns. It prints `all clear` when nothing needs you.
- **`cctap 2`** the same jump, straight to the session holding that number. A session
  keeps its number for as long as it lives.
- **Desktop notifications**, optional and one command away: `cctap notify on`.

And for tmux layouts, spare monitors, and anyone who wants a dedicated surface:

- **`cctap top`** the full list, numbers in the first column. Press a number to jump,
  or j/k and Enter, q to quit.
- **`cctap strip`** the same line as the status line, standalone: an animated pane that
  fits down to a handful of columns. Press a number in it to jump.
- **`cctap status`** one plain sentence for a tmux bar, or for anyone who prefers words
  to glyphs.

## States

| Glyph | State | Reads as |
|---|---|---|
| `⠋` green | working | a spinner explains itself |
| `!!` bright red, bold | blocked on a permission prompt or a question | `!! needs you` |
| `▲` yellow | the turn finished, it is waiting for you | `▲ your turn` |
| `✗` red | the turn ended in an error | `✗ failed` |
| `◌` cyan | context compaction | counted as working |
| `·` dim | ended cleanly, drops off after 5 minutes | not counted |
| the number in reverse video | the session you are reading this in | `you` |

*Colour is on the names, the words appear when there is room, and the glyph shapes
carry the same information on their own.*

Suffix `×n` counts running subagents, and a session whose own turn ended while its
subagents still run stays a spinner: the triangle means the whole tree is done and the
next move is yours. A blocked subagent turns the whole session red, because that is
what actually needs you.

`CCTAP_THEME=ascii` swaps the glyphs for plain ascii when a terminal draws them as
boxes, `NO_COLOR` drops the hues while keeping the shapes, the words and the reverse
video, and `CCTAP_MOTION=0` freezes the spinner for anyone who would rather it held
still.

## Commands

```
cctap                     jump to the session that needs you
cctap <n>                 jump to the session holding number n
cctap jump --dry-run      print the exact command a jump would run, run nothing
cctap top                 full-screen list, digits jump
cctap strip [--rows 2]    live one-line glyph strip for a slim pane
cctap status              one plain sentence
cctap keys                every way to reach a session, and the lines to paste
cctap keys setup [key]    set up a jump key (inside tmux: binds prefix+key live)
cctap keys undo           take back what keys setup bound, keys status lists it
cctap notify [on|off]     desktop banners, off by default
cctap doctor              check hooks, daemon, socket, terminal adapter
cctap install-hooks       register the hooks and the status line (--dry-run supported)
cctap uninstall-hooks     remove them (--dry-run, --purge also removes ~/.cctap)
cctap simulate [name]     replay a bundled scenario, bare lists them
```

## When something looks off

```bash
cctap doctor
```

It checks the hook registrations and the node path recorded for them, the daemon over a
real socket round trip with a version match, the permissions on the socket and the
directory, the spool backlog, and a `daemon.json` left behind by a daemon that is gone.
Every failure comes with its remedy.

## Trust, in five lines

1. Local only: no network calls of any kind, asserted by a test on every run.
   [Privacy, exactly.](docs/PRIVACY.md)
2. Your prompts and tool inputs are dropped by name before anything touches disk.
3. It edits one file of yours, backs it up before changing it, prints every change, and
   `--dry-run` shows the plan. Its own copies, the three bundles and the install record,
   go under `~/.cctap/`. [What install-hooks does.](docs/GUIDE.md#what-install-hooks-does)
4. Nothing pops up and nothing is key-bound unless you ask.
5. `cctap uninstall-hooks` reverses everything and never touches what is not ours.

The tarball is six readable files, published with npm provenance, and the build
reproduces byte-identically from the repo. [Verify it yourself.](docs/PRIVACY.md#verify-what-you-install)

## Going further

Jump keys per OS live in [getting to a session](docs/KEYS.md). Terminal support, the
status line internals, configuration, the daemon, and troubleshooting live in
[the guide](docs/GUIDE.md). The exact fields cctap reads and stores live in
[privacy, exactly](docs/PRIVACY.md).

## Uninstall

```bash
cctap uninstall-hooks            # removes only cctap's hooks and status line
cctap uninstall-hooks --purge    # also removes ~/.cctap
```

## License

MIT. Zero runtime dependencies. Node 22 or newer.

cctap is an independent project, not affiliated with or endorsed by Anthropic. Claude
and Claude Code are trademarks of Anthropic.
