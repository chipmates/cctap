# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-03

### Added

- Jumping into tmux from the outside. An OS hotkey firing `cctap jump` used to be
  refused with "not inside tmux"; now it moves your most recently active attached
  client to the right session and pane. The refusal remains only when no client is
  attached at all.
- `cctap keys setup` inside tmux binds `prefix + g` in the running server: no file
  written, one command undoes it, and the output carries the `~/.tmux.conf` line for
  anyone who wants it permanent. A key already bound to something else is never taken
  over unless you pass that key explicitly, and then the previous binding is printed.
  `--os` skips the tmux branch and sets up the OS-wide key instead.
- The install epilogue, the strip's one-time hint and `cctap keys` all lead with the
  jump key now: the system key is the one path that stays instant while Claude is
  mid-turn, which is when another session usually needs you.

### Fixed

- `cctap keys` no longer refuses to print under an over-long `CCTAP_DIR`: it never
  touches the socket, so the socket-path limit does not apply to it.

## [0.1.0] - 2026-08-03

### Added

- Re-installing after the cctap directory moved now adopts the registrations that are
  already there instead of adding a second set beside them. The old rule matched one exact
  path, so a moved install left 19 dead hooks forking a failing process on every event,
  invisible to uninstall and counted as healthy by doctor. Ownership is by shape now, for
  the hooks and the status line alike, and doctor fails loudly on a registration whose
  forwarder is gone.
- A hook payload can no longer produce a wire line the daemon drops. stdin is read to a
  bounded prefix and the free-text fields are truncated before encoding, so an event
  always lands; a payload too truncated to parse still yields its identifying fields, and
  one with no session id is dropped rather than spooled unattributable.
- `cctap notify off` works while `CCTAP_NOTIFY=off` is exported. It compared the setting
  against the setting-plus-env, so the flip was a silent no-op. The env is reported as the
  override it is.
- A daemon whose socket file was deleted under it re-binds on the next sweep instead of
  listening on an inode nobody can reach, and a daemon that is not the one serving never
  removes the socket path on its way out.
- The spool is bounded at 10000 events, drop-oldest, with the count kept for doctor.
  Claim files are named so replay order is time order: pid 999 used to replay after pid
  1000 and resurrect a permission prompt that had been answered.
- A restored session whose recorded pid may have been recycled no longer haunts the board
  forever or holds the idle exit open.
- Smaller ones: `uninstall-hooks` writes nothing on a no-op run, so repeated runs cannot
  rotate the pre-install backup away; `cctap notify` refuses to rewrite a config.json it
  cannot parse; a snapshot missing a derived field is repaired rather than fatal and an
  unknown snapshot version starts clean; `cctap simulate` exits 1 when the daemon dies
  mid-replay.
- Subagents are tracked by identity rather than by tally. A repeated `SubagentStop`, a
  stop for an id that never started, and a repeated `SubagentStart` are all no-ops now.
  Each of them used to corrupt the count: the first two reported a finished turn while a
  subagent was still working (and left the real tree-rest notification silent), the third
  left a session spinning forever after its tree was done.
- `CCTAP_NO_EXEC=1` now really spawns nothing. The daemon resolved git branches and the
  controlling tty through `execFile` directly, outside the one exec seam, so it ran git
  twice and ps once per session no matter what the flag said. Everything goes through the
  seam; with it set, labels fall back to the directory name, jumps degrade to awareness,
  and `cctap doctor` says so.
- An ended session stays ended. A late `Stop` used to revive it as a finished turn that
  still carried its ended reason, escaping the cleanup sweep and offering itself as a jump
  target. Only a `SessionStart` brings a session back.
- `cctap strip`, `cctap status` and piped `cctap top` say when the daemon is unreachable
  instead of printing a calm empty board. The two states looked identical while persisted
  state could hold blocked sessions.
- A failure with nothing to report no longer borrows the last thing that happened. An old
  permission prompt could be presented as the reason a turn failed, in the jump output and
  in the notification.
- Sessions in one directory no longer disagree about the branch for a minute after one of
  them notices a switch.
- Fixed a race that let two daemons hold one lock and serve one socket. The lock used to
  be created empty and filled in a moment later, and a second daemon that read it in that
  window saw no owner and took it. It is now published atomically with its owner inside
  it, a lock that cannot be read yet is waited out rather than stolen, no process removes
  a lock that does not name it, and a daemon that finds the address in use checks for a
  live server before removing the socket file.
- The narrow-width count line reads glyph first (`!!3`), so it can never be mistaken for
  the slot form (`3 !!`).
- A number on every session, and the number is the jump handle. The daemon hands out the
  lowest free one on first sight, a session keeps it for life through renames, branch
  changes and state churn, it survives a daemon restart, and it comes free only when the
  session record drops. The strip and `cctap top` show it, and as the strip narrows the
  numbers stay with the glyphs while the labels go.
- The status line marks the session you are reading it from. Claude Code pipes its session
  data into the command, so the strip reverse-videos that session's number and, where
  there is room, says `you` after its glyph. No stdin and no match mean no marker, so a
  tmux bar renders exactly as before.
- In a live `cctap strip` or `cctap top`, the number under each glyph is also its key:
  press it and you are there. No setup and no permissions, on any OS. `q` or Ctrl-C leaves
  the pane, and the pane keeps rendering after a jump.
- `cctap keys setup`, which carries the system-wide hotkey as far as each OS allows: on
  macOS it copies the command, opens Shortcuts and prints the three steps; on GNOME it
  writes the custom keybinding through gsettings and tells you how to undo it; anywhere
  else it prints the line to bind. `CCTAP_NO_EXEC` makes it print instead of doing.
- `cctap 2`, or `cctap jump 2`: jump straight to the session holding that number. A purely
  numeric argument is always a slot, never a label prefix, and a miss lists the numbers
  that do exist. Inside a Claude Code composer, `! cctap 2` works without leaving.
- One dim hint on the status line, naming the number to type, shown only while a session
  is actually waiting on you and only until your first jump lands. Then it is gone for good.
  It names the invocation that works on your machine, `npx cctap 2` when cctap is not on
  your PATH, so the taught command is never one that fails.
- `cctap keys`, which prints every way to reach a session: the zero-setup ones first, then
  the macOS Shortcuts and tmux recipes with real absolute quoted paths, per number. cctap
  still binds no keys and edits none of your config.
- A display state that answers one question, does this need me right now. A session whose
  main turn has stopped while its subagents are still running keeps the spinner and the
  `xn` count, and only becomes `your_turn` when the whole tree comes to rest, which is
  also the single moment the notification fires. A blocked subagent still outranks
  everything. State machine rule R8, fixture `spec/fixtures/delegated-turn.json`, which
  doubles as a `cctap simulate delegated-turn` scenario.
- A traffic-light colour system, identical in the strip pane, the piped one-shot strip and
  `cctap top`, in 16-colour-safe codes: green while working, bright red bold when blocked,
  plain red for a failure, yellow for your turn, dim for ended, each across the whole entry
  so the board reads as coloured names. Compacting alone tints just its glyph. The three
  states that want a human also say so in words when there is room, and those words are the
  first thing the strip drops as it narrows. The one-shot strip steps its spinner off the wall clock, so a status line that
  re-runs every couple of seconds animates instead of freezing.
- `cctap strip`, a live one-line glyph strip. One glyph per session, grouped by project,
  ordered by project then branch then start time. Fits any width by shortening labels,
  then dropping labels from the quiet sessions, then all labels, then the quiet sessions
  themselves. Below that it falls back to one count per state. Attention glyphs are the
  last thing to go. `--rows 2` for two-line panes, with projects holding their row across
  repaints. With no sessions it says so instead of drawing a blank line: a dim placeholder
  in a terminal, and a short note about hooks and `cctap doctor` when piped. Piped output is
  plain, unless `CCTAP_COLOR=1` asks for the colours, which is how the Claude Code status
  line keeps them.
- `cctap top`, a full-screen session list with j/k selection, Enter to jump and q to quit.
  Prints one plain snapshot and exits when stdout is not a terminal.
- `cctap status`, one plain line for a tmux status bar or a Claude Code status line.
- `cctap jump` (also bare `cctap`), which focuses the session that needs you: oldest
  permission prompt, then oldest failure, then oldest finished turn. `--dry-run` prints
  the exact command without running it.
- Terminal adapters for macOS Terminal.app, iTerm2, tmux, kitty and WezTerm. Anything
  else degrades to a desktop notification plus a five second highlight in any running
  strip or top.
- Desktop notifications on entering permission_wait, failed and your_turn, via osascript
  on macOS and notify-send on Linux, plus a tmux message when the session lives in tmux.
  One notification per session per five seconds, each state toggleable. Banners are **off
  by default**: out of the box cctap speaks through terminal surfaces only, and nothing
  pops up on a machine that just installed it. `cctap notify on` and `cctap notify off`
  flip the setting, bare `cctap notify` prints where it stands, and the tmux message stays
  on either way because it is terminal-native.
- `cctap stop`, which stops the daemon, and `cctap daemon`, which runs it in the
  foreground.
- `cctap install-hooks` and `cctap uninstall-hooks`. Backs up the settings file, merges 19
  hook registrations without touching foreign entries, is idempotent, heals a changed node
  path, and supports `--dry-run`. A run that changes nothing writes nothing and takes no
  backup. Pruned backups are named, not just counted. An unparseable settings file is
  reported as a JSON parse error with the line and column, and nothing is touched.
  Uninstall stops the daemon and takes `--purge`, and matches on the install it can see:
  run it with the same `CCTAP_DIR` you installed with, or it is a no-op that says so.
- The Claude Code status line, wired by `install-hooks` itself, and what it runs is the
  strip: one coloured glyph per session at the bottom of every session, refreshed every two
  seconds on top of Claude Code's own updates. It is written only when you have no status
  line of your own, it shows in the printed change list and in `--dry-run`, and
  `uninstall-hooks` removes it. Both paths are absolute and quoted, so a version manager or
  a space in a home directory cannot break it. A status line that is not ours is never
  rewritten, only reported with a one-line recipe for chaining cctap's output onto it.
  `--no-status-line` skips the whole step.
- `cctap doctor`, which checks hooks, the recorded node path, the daemon, socket
  permissions, the terminal adapter, macOS Automation consent, the spool backlog and
  whether subagent events have been observed. The socket check is a real round trip, not a
  stat, so a socket nobody serves cannot pass it. It also prints the exact quoted command
  to bind to a global jump key. Every failure carries a remedy, and facts a healthy install
  legitimately reports are notes rather than warnings.
- `cctap simulate <scenario>`, replaying bundled scenarios through the real socket. Bare
  `cctap simulate` lists what is available instead of starting one, and a replay opens by
  naming the scenario and how to watch it.
- A daemon holding one state model behind a unix socket, with an atomic debounced
  snapshot, spool replay, liveness sweeping by parent pid, and git branch resolution.
- A hook forwarder that always exits 0, never writes to stdout, finishes inside 100
  milliseconds, and spools to disk when the daemon is unreachable.
- A hard refusal when the unix socket path passes the platform sun_path limit, 104 bytes
  on macOS and 107 on Linux. The kernel truncates silently, and two truncated paths answer
  as one socket, so bind, connect, the hook forwarder and the cli all stop and name the two
  remedies. `"socket"` in `~/.cctap/config.json` moves the socket out of a deep tree.
- `CCTAP_NOTIFY=off` to silence all banners, and `CCTAP_NO_EXEC=1` to block every
  external command.
- An ascii theme for plain terminals, now with a rotating-bar spinner so working animates,
  and a capital `X` for failed so it cannot be read as the `xn` subagent multiplier.

### Notes

- Published as `@chipmates/cctap`. npm's similarity rule reserves the unscoped name for
  the existing `cc-tap` package, so the scope is the honest way in. The command, the
  directory and the brand are all still `cctap`.
- Zero runtime dependencies. Node 20 or newer. Linux and macOS.

[0.1.0]: https://github.com/chipmates/cctap
