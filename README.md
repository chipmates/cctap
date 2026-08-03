<div align="center">

<img src="docs/logo.svg" alt="cctap logo: a shell prompt with a red block cursor, a session waiting on you" width="128" height="128">

# cctap

The shoulder tap for parallel Claude Code sessions.

[![npm version](https://img.shields.io/npm/v/@chipmates/cctap.svg)](https://www.npmjs.com/package/@chipmates/cctap)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/chipmates/cctap/actions/workflows/ci.yml/badge.svg)](https://github.com/chipmates/cctap/actions/workflows/ci.yml)

<img src="docs/statusline.png" alt="The strip at the bottom of a Claude Code session: 1 authsvc:main in red saying needs you, 2 blog:draft with a green spinner, 3 infra:tf in yellow saying your turn, then a dim hint naming the command that jumps there." width="736">

After the install, this line shows up by itself at the bottom of every Claude Code
session. When one of them turns red, your jump key puts you there.

<img src="docs/demo.gif" alt="The states, animated. cctap strip starts waiting for sessions, three appear as a numbered line of glyphs with green spinners, then session 1 flips to the red double-bang because it needs permission while session 3 shows the yellow your-turn triangle. A one-shot render shows the exact line the status line carries, ending in a dim hint naming the jump command. cctap top lists all three numbered sessions with the blocked one selected, cctap status prints: 1 working, 1 blocked, 1 finished. A final scene shows a delegating session: a green spinner with a x2 subagent counter that stays working after its own turn ends, flashes red when a subagent needs permission, and turns into the yellow your-turn triangle only when the last subagent finishes." width="736">

The states, animated. Running `cctap strip` in a spare window, like the demo does, is
optional, the status line carries the same line by itself.

</div>

You run four sessions in parallel, full screen. One finished minutes ago. Another is
stuck on a permission prompt. You were watching the wrong window.

The expensive part isn't the model thinking. It's you, not noticing. cctap watches every
session through hooks and puts one line at the bottom of every Claude Code session:
each session a numbered glyph, green while it works, red and in words when one needs
you. The number is how you get there. One keypress puts you in the right window.
Plenty of tools notify you. Taking you to the right session is the missing part.

> Local only. cctap reads your Claude Code hook events, keeps the state in a daemon on a
> unix socket under `~/.cctap/`, and makes no network calls of any kind. Your prompts
> never reach it. [Privacy, exactly.](docs/PRIVACY.md)

## Quick start

```bash
npx @chipmates/cctap install-hooks --dry-run     # see exactly what it would change
npx @chipmates/cctap install-hooks     # backs your settings up first, uninstall-hooks reverses it
```

That is the first of two lines: the tap on the shoulder. Claude Code picks the hooks up
live, normally within seconds, and from then on the bottom of every Claude Code session
shows the strip:

```
1 authsvc:main !! needs you │ 2 blog:draft ⠴ │ 3 infra:tf ▲ your turn
```

The number is how you get there, and the second line is the key that takes you:

```bash
cctap keys setup     # macOS: Shortcuts doorstep. GNOME: written for you. tmux: bound live
```

One press and you are in the session that needs you. Any moment, full screen included,
and crucially also while Claude is mid-turn in the session you are sitting in, which is
exactly when another one usually taps your shoulder. Nothing typed into a busy session
can do that, so cctap does not pretend otherwise. Setup carries you as far as your OS
allows, about a minute either way: on macOS it copies the command and opens Shortcuts
for the last two clicks, on GNOME it writes the binding and shows the undo, inside tmux
it binds `prefix + g` in the running server and writes nothing. Nothing is ever bound
without you asking, everything bound is journaled, and undo is one command. Run it in
the shell you just installed from, or simply ask Claude to run it for you, inside the
session. [The full guide.](docs/GUIDE.md)

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

Colour is on the names, the words appear when there is room, and the glyph shapes carry
the same information on their own. Suffix `×n` counts running subagents, and a session
whose own turn ended while its subagents still run stays a spinner: the triangle means
the whole tree is done and the next move is yours. A blocked subagent turns the whole
session red, because that is what actually needs you.

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

## Trust, in five lines

1. Local only: no network calls of any kind, asserted by a test on every run.
   [Privacy, exactly.](docs/PRIVACY.md)
2. Your prompts and tool inputs are dropped by name before anything touches disk.
3. It edits one file, backs it up first, prints every change, and `--dry-run` shows the
   plan. [What install-hooks does.](docs/GUIDE.md#what-install-hooks-does)
4. Nothing pops up and nothing is key-bound unless you ask.
5. `cctap uninstall-hooks` reverses everything and never touches what is not ours.
   The tarball is six readable files, published with npm provenance, and the build
   reproduces byte-identically from the repo. [Verify it yourself.](docs/PRIVACY.md#verify-what-you-install)

## Everything else

Terminal support, the status line internals, jump keys per OS, configuration, the
daemon, and troubleshooting live in [the guide](docs/GUIDE.md). The exact fields cctap
reads and stores live in [privacy, exactly](docs/PRIVACY.md).

## Uninstall

```bash
cctap uninstall-hooks            # removes only cctap's hooks and status line
cctap uninstall-hooks --purge    # also removes ~/.cctap
```

## License

MIT. Zero runtime dependencies. Node 20 or newer.
