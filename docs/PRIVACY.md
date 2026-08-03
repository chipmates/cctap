# Privacy, exactly

What cctap reads. The hook forwarder copies exactly ten fields out of each hook payload
and drops the rest before anything is written:

- `session_id`, `hook_event_name`, `agent_id`, `agent_type`, `tool_name`, `source`,
  `cwd`, `message`, `reason`, `transcript_path`.
- `prompt`, `tool_input` and `tool_response` are dropped by name. Your prompts and your
  tool arguments never reach the socket, and never reach the spool on disk.
- The branch and repository root, by running `git rev-parse` in the session's directory.
- The controlling terminal of the session process, by running `ps -o tty=`.
- Nine terminal environment variables (`TMUX`, `TMUX_PANE`, `TERM_PROGRAM`,
  `TERM_SESSION_ID`, `ITERM_SESSION_ID`, `KITTY_WINDOW_ID`, `KITTY_LISTEN_ON`,
  `WEZTERM_PANE`, `CLAUDE_PROJECT_DIR`) so a jump knows where to land.

One field cctap makes up rather than reads: `eid`, a random id per forwarder run, so the
daemon can recognise the same event delivered twice. It carries no content.

What it stores, in `~/.cctap/` with the directory at 0700 and every file at 0600:

- `state.json`, one record per session with the fields above plus the derived state,
  and a copy of the last notification line Claude Code sent. Beside the sessions it
  keeps an `observed` block, which is bookkeeping about cctap itself rather than about
  you: whether any subagent event has ever arrived, which of the nine environment keys
  above have ever shown up, and, per hook registration name, the timestamp that
  registration first fired. The file also carries its own `savedAt` and `version`.
- `spool/events.ndjson`, only while the daemon is down, and emptied on the next start.
  A spool that keeps growing rotates into replay segments in the same directory, at most
  five of them, and the oldest is dropped with a marker counting the lines that went
  with it.
- `install.json`, the node path and forwarder path recorded at install time.
- `jump.json`, the outcome of the last jump, which is how doctor knows about Automation
  consent.
- `daemon.json`, the running daemon's pid, version and socket path.
- `daemon.lock`, a pid file so two daemons cannot serve one socket.

What it never touches: your transcripts (the path is stored, the file is never opened),
your prompts, your tool inputs, your code, your keys, the network. No `http`, `https`,
`http2`, `dns`, `tls`, `dgram` or `inspector` import appears anywhere in the shipped
bundles, and neither does `curl`, `wget` or `nc`. The only socket is the local unix
one. A test asserts every line of this on every run.

## What it does not do

- No telemetry, no analytics, no network calls of any kind.
- No web UI and no server. Terminal only.
- No input injection. cctap never types into a Claude session. Jumping there is the
  approve flow, and the decision stays yours.
- No token or cost counting. That problem is solved elsewhere.
- No native Windows jump.

## Verify what you install

- Releases are published from GitHub Actions with npm provenance: the npm page carries
  an attestation tying the exact tarball to the exact commit and workflow on the public
  repo. From your side, `npm audit signatures` checks it in any project that installs
  cctap.
- The tarball is six files and the three bundles are readable JavaScript.
  `npm pack @chipmates/cctap --dry-run` lists exactly what would land on your disk.
- Rebuild it yourself: clone the repo at the release tag, then
  `pnpm install --frozen-lockfile && pnpm build`, and compare `dist/` against the
  tarball. Zero runtime dependencies and a pinned lockfile keep the build reproducible,
  and the bundles come out byte-identical.
