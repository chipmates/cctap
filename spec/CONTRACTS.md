# cctap CONTRACTS

Normative. The implementation conforms to this file; tests prove it. Changes require
maintainer sign-off, recorded in git history.

## 1. Invariants

- **I1** The hook forwarder exits 0 under every code path: success, socket down, spawn failure,
  malformed stdin, timeout. No exceptions escape.
- **I2** The forwarder writes zero bytes to stdout under every code path. stderr only
  when `CCTAP_DEBUG=1`. (A one-line carve-out existed for a few hours on 2026-08-03
  for the typed jump; §6 records why it was removed.)
- **I3** The forwarder self-terminates within 100 ms wall-clock (`setTimeout(...).unref()` +
  hard `process.exit(0)`).
- **I4** The forwarder never loses an attention-relevant event silently: if the socket is
  unreachable after one spawn attempt + one retry, the wrapped line is appended to
  `~/.cctap/spool/events.ndjson` (best effort, still within I3).
  - **Known gap.** A daemon stopped with SIGSTOP still has its socket accepting into the
    kernel buffer, so a forwarder's write succeeds and the forwarder exits having done
    its job. Those events live only in that buffer: `SIGCONT` delivers them, `kill -9`
    while stopped loses them. cctap does not try to detect a stopped peer, because a
    write that the kernel accepted is indistinguishable from one that was read. The
    spool covers an unreachable daemon, not a frozen one.
- **I5** `~/.cctap/` is created 0700; the socket and all files inside are 0600. The daemon
  verifies and repairs modes on start.
- **I6** cctap never writes to a Claude session's terminal or injects input anywhere (D6).
- **I7** `package.json` `"dependencies"` is `{}`. Runtime imports are `node:*` builtins only.
- **I8** All state files are written atomically (tmp + rename). `state.json` persistence is
  debounced (≥1 s) and flushed on clean shutdown.
- **I9** Exactly one daemon per socket path: lock file with pid; a stale lock (dead pid) is
  broken; a losing racer exits silently while the winner serves. The lock is published
  atomically with its owner inside it (write a temp file, then `link`), so it is never
  observable as an empty file that a second daemon would treat as garbage. A lock whose
  pid cannot be read yet belongs to a daemon mid-acquire and is waited out, not stolen;
  only after a bounded grace does it count as an orphan. No process ever removes a lock
  that does not name it. `EADDRINUSE` after taking the lock is probed before the socket
  file is removed: if something is still serving there, the newcomer stands down instead
  of unlinking a live daemon's socket.
- **I10** The state machine is a **pure reducer**: `reduce(model, normalizedEvent) -> model`.
  No clock reads, no I/O, no randomness inside. Time enters only through `event.ts`
  and explicit `sweep(model, nowTs)` calls.
- **I11** The daemon treats forwarder input as untrusted: per-line size cap 1 MB, malformed
  JSON dropped without crashing, unknown fields ignored, unknown event names ignored. The
  forwarder guarantees it never offers a line that large: stdin is read to a bounded
  prefix and every free-text field is truncated before encoding, because a line the
  daemon drops on overflow is an event lost after the forwarder already reported success.
  A payload too truncated to parse still yields its identifying fields, and an event with
  no session id is dropped at the forwarder rather than spooled unattributable.
- **I15** The spool is bounded. Past 10000 events the oldest are dropped and the count of
  what went is kept in the file where `cctap doctor` can report it.
- **I12** No network egress of any kind anywhere in the codebase.
- **I13** The wire event and the spool never contain prompt text, tool inputs, tool
  responses, or any hook field outside the §2 whitelist. A test feeds the forwarder a
  payload containing `prompt` and `tool_input` and asserts the emitted line contains
  neither the field names nor their values.
- **I14** No component binds or connects to a socket path longer than the platform
  `sun_path` limit (104 bytes on darwin, 107 on linux). The kernel truncates silently,
  which makes two long `CCTAP_DIR`s share one socket and one daemon's sessions. Daemon,
  client, cli and forwarder all refuse and name the two remedies: a shorter `CCTAP_DIR`,
  or `"socket"` in `config.json`. `doctor` reports it as a failure and still runs.
  The cli-level refusal applies only to commands that reach the socket: `keys` (and
  `keys setup`) never touch it and must run under an over-long path anyway.

## 2. Socket protocol (ndjson over Unix socket, one JSON object per line)

Path: `~/.cctap/cctap.sock` (override: `CCTAP_DIR` relocates `~/.cctap` entirely — tests use
this; keep socket paths short, macOS caps them at 104 bytes).

### Forwarder → daemon

```json
{"v":1,"kind":"event","ts":1754000000000,
 "tag":{"event":"Notification","notif":"permission_prompt"},
 "hook":{ ...WHITELISTED hook fields only, see below... },
 "env":{"TMUX":"","TMUX_PANE":"","TERM_PROGRAM":"Apple_Terminal",
        "TERM_SESSION_ID":"...","ITERM_SESSION_ID":"","KITTY_WINDOW_ID":"",
        "KITTY_LISTEN_ON":"","WEZTERM_PANE":"","CLAUDE_PROJECT_DIR":"/path"},
 "ppid":12345}
```

**Hook field whitelist (amended 2026-08-02 after adversarial review; supersedes the
original "verbatim" design).** The forwarder copies EXACTLY these fields from the hook
stdin payload and nothing else: `session_id`, `hook_event_name`, `agent_id`, `agent_type`,
`tool_name`, `source`, `cwd`, `message`, `reason`, `transcript_path`. In particular
`prompt`, `tool_input`, `tool_response`, and any unknown field never reach the socket,
the spool, or any file. This is what makes the README privacy sentence literally true on
every path, including the spool.

`tag` comes from the forwarder's own argv (`--event=`, `--notif=`), making classification
independent of payload text. `ppid` is the forwarder's parent pid (the Claude process) for
liveness and tty resolution.

### Renderer/CLI → daemon

- `{"v":1,"kind":"subscribe"}` → daemon replies `{"v":1,"kind":"state","sessions":[...]}` now
  and re-sends the **full state** on every change. No deltas.
- `{"v":1,"kind":"get_state"}` → one `state` reply, then the daemon closes that connection.
- Unknown `kind` → ignored.

### SessionState (wire shape, one element of `sessions`)

```ts
{ sessionId: string, slot: number,          // slot: stable jump handle, see below
  project: string, branch: string, cwd: string,
  transcriptPath: string, sessionSource: string,
  state: 'working'|'permission_wait'|'your_turn'|'failed'|'compacting'|'ended',
  displayState: same union,           // derived, what renderers show
  stateSince: number, lastEventTs: number, sessionStart: number,
  currentTool?: string, lastMessage?: string,
  attentionKind?: 'permission'|'elicitation'|'agent_needs_input'|'idle'|'agent_completed',
  subagents: { active: number, running: string[],     // all of it reaches displayState (R8)
               anonymous: number, blocked: string[] }, // active = running.length + anonymous
  terminal: { kind: 'tmux'|'apple-terminal'|'iterm2'|'kitty'|'wezterm'|'unknown',
              tmuxPane?: string, tty?: string, kittyWindowId?: string,
              kittyListenOn?: string,   // kitten @ needs --to <socket> outside kitty
              weztermPane?: string, termSessionId?: string },
  ppid: number, inferred?: boolean, endedReason?: string }
```

## 3. Normalized events

The daemon maps a wire event to a normalized event before reducing:

```ts
{ ts: number, sessionId: string, event: string,       // hook_event_name or tag.event
  notif?: string,                                      // tag.notif for Notification
  agentId?: string, toolName?: string, source?: string,
  cwd?: string, message?: string, reason?: string }
```

`spec/fixtures/*.json` contain normalized events. The reducer test harness feeds them directly.

### Slots (the jump handle)

Every session gets `slot`, the lowest free positive integer at the moment the reducer
first creates its record. A session keeps its slot for the life of that record, through
renames, branch changes and every state change; the number only comes free when the record
drops (ended TTL or liveness sweep), and the next new session takes the lowest free one
again. Slots survive the snapshot round trip, and a snapshot written before slots existed
is repaired on load. `cctap jump <n>` looks a session up by slot: a purely numeric argument
is always a slot, never a label prefix.

### Subagents and the display state (transitions.md R1 and R8)

Subagents are tracked by identity, not by tally: `running` is a set of agentIds, so a
duplicate `SubagentStart`, a duplicate `SubagentStop` and a `SubagentStop` for an id that
never started are all no-ops. Only events that carry no `agentId` touch `anonymous`, the
one plain counter. `active` is the published sum.

Events carrying `agentId` never change a session's `main` state. They do change what the
session shows, because `displayState` is derived from `main` plus the subagent state:

1. any blocked subagent → `permission_wait`
2. `main == failed` → `failed`
3. `main == your_turn` with running subagents > 0 → `working`
4. otherwise → `main`

So a main `Stop` that arrives while subagents are still running does **not** report a
finished turn, and turn boundaries no longer reset the subagent bookkeeping. The move into
`your_turn` happens at the last `SubagentStop`, which is also the single moment the
`your_turn` desktop notification fires. `main == ended` outranks all of it.

## 4. install-hooks contract

All twelve rules are mandatory and tested:

1. Read the settings file; create `{}` if absent.
2. Back up to `settings.json.cctap-bak-<timestamp>` before any write.
3. Deep-merge our matcher groups; never remove, rewrite, or reorder anything foreign.
   Foreign entries are preserved content-identically (the file itself may normalize to
   2-space JSON).
4. Tag our entries by their `args[0]` signature so uninstall removes exactly and only
   them, and a changed node path heals on re-install instead of duplicating.
5. Validate a JSON round-trip, then write atomically (tmp + rename).
6. Print a per-registration summary and the backup path.
7. `--dry-run` prints the plan and writes nothing.
8. `CCTAP_CLAUDE_SETTINGS` overrides the settings path everywhere; tests never touch the
   real file.
9. Finish by reminding that hooks apply to sessions started after the install.
10. Set `statusLine` in the same settings file to `"<absolute node>" "<cctap.mjs>" status`,
    both paths quoted because a status line runs through a shell, but only when the key is
    absent or already ours (its command runs our `cctap.mjs status`). A foreign status line
    is never rewritten or removed; the install reports it and prints how to chain ours onto
    it. `--no-status-line` skips the step. Uninstall removes only ours.
11. One ownership answer per run. Hooks match on the recorded `forwarderPath` when
    `install.json` exists in the resolved `CCTAP_DIR`, the status line on the `cctap.mjs`
    beside it, and the `~/.cctap` tilde recipe counts as ours only when the resolved
    directory is the default. A run against a different `CCTAP_DIR` must be a no-op on
    both, never on one of the two.
12. A run that changes nothing writes nothing, and takes no backup.

## 5. Test requirements

1. Reducer: consumes every `spec/fixtures/*.json` verbatim; asserts `displayState` (and
   listed extra fields) after each event, for every session in `expect`.
2. Reducer edge scenarios beyond fixtures: listed at the end of `spec/transitions.md`,
   implemented as additional table-driven cases.
3. Forwarder contract: I1–I4 asserted, including a byte-count assertion on stdout and a
   measured runtime bound.
4. Daemon: lock racing (two starts, one survives), snapshot round-trip, spool replay order,
   liveness sweep removal, malformed-line resilience (I11).
5. Install: contract §4 against temp settings files.
6. End-to-end: `simulate` through a real socket + `get_state` assertions; non-TTY `top`
   snapshot golden test.
7. Removed with the typed jump (see §6): the forwarder emits nothing on stdout and
   forwards every prompt event unchanged, which section 5.3 already covers.
8. tmux out-of-client jump and runtime bind: §7 asserted through the exec seam with
   scripted `tmux` answers: no server, zero clients, one client, several clients (most
   recent activity wins), switch refusal; bind conflict scan, `-N` fallback, explicit
   key overwrite, `--os` bypass, `CCTAP_NO_EXEC` recipe degradation.

Everything runs with `pnpm test` (node:test), no network, no real `~/.claude` touched.

## 6. Removed: the typed jump (owner decision, 2026-08-03)

A `jj` prompt token shipped here for a few hours: the forwarder blocked the prompt on
a synchronous UserPromptSubmit hook and fired the jump, live-verified end to end. It
was removed the same day, before any release carried it. The reason is a product law,
not a defect: Claude Code hands queued prompts to hooks only after the running turn
finishes completely, so a typed token is instant at an idle composer but silently
deferred while Claude works, and the working phase is exactly when another session
taps your shoulder. A jump that is sometimes instant and sometimes late is worse than
no jump, because it breaks the expectation the whole tool exists to serve. Keybindings
inside Claude Code cannot run external commands (doc-verified 2026-08-03), so no typed
or in-session path can be instant mid-turn. The instant path is the system key, which
is what `cctap keys setup` exists for. Do not reintroduce a prompt token without a
Claude Code mechanism that fires hooks at Enter time.

## 7. tmux: jump from outside a client, and the runtime bind

- **X1** Inside tmux (`$TMUX` set): unchanged. Resolve the session name from the stored
  pane, `switch-client` the current client, then `select-window` and `select-pane`.
- **X2** Outside tmux (`$TMUX` unset: an OS hotkey, a Shortcuts action, a plain shell),
  refusing is wrong whenever a client is attached. The adapter asks
  `tmux list-clients -F '#{client_activity} #{client_tty}'`. No server or zero clients:
  the old refusal, whose detail names the pane and says attach first. Otherwise it
  targets the most recently active client:
  `switch-client -c <client_tty> -t <session>` chained with `select-window` and
  `select-pane` in one tmux invocation (`;` separators in argv, no shell). The success
  detail names the client tty it moved.
- **X3** `cctap keys setup` inside tmux binds at runtime and writes nothing: default key
  `g` in the prefix table. Conflict pre-scan first (`list-keys`); an existing non-cctap
  binding is never overwritten by default — the conflict, the existing command, and how
  to pick another key are printed instead. An explicitly passed key may overwrite, and
  the output then includes the previous binding and the line that restores it.
- **X4** The bound command is the absolute jump line with output redirected: `run-shell`
  shows stdout in a blocking view, and a jump that switched the client has nothing left
  to say. Bind with `-N '<note>'` first, retry without `-N` on older tmux. The output
  prints what was bound, the one-command undo (`tmux unbind-key <key>`), the
  `~/.tmux.conf` line to persist by hand, and that the bind lives until the tmux server
  exits. No file is written (writer law: no config writer ships unverified).
- **X5** `cctap keys setup --os` skips the tmux branch and runs the platform setup.

## 8. The keys journal (what setup changed, and the way back)

Prerequisite for every future config writer. The journal makes each write undoable and
each drift visible.

- **K1** `~/.cctap/keys.json` records every binding `keys setup` created or took over:
  one entry per write with `{ at, kind, key, command, undo, previous? }`, where `kind`
  names the mechanism (`tmux-bind`, `gnome-keybinding`, ...), `undo` is the exact
  command or write that reverses it, and `previous` carries what was replaced when a
  takeover happened. Atomic write, 0600, bounded (last 50 entries).
- **K2** The ephemeral tmux bind is journaled too: it dies with the tmux server, but
  until then `keys undo` must be able to take it back without the user remembering the
  key. An entry whose mechanism no longer shows the binding is reported as gone, not
  an error.
- **K3** `cctap keys status` prints each journaled binding with its live state:
  `active` (read back from the mechanism), `gone` (journaled but no longer bound),
  `changed` (bound, but to something that is not ours any more). Read-only.
- **K4** `cctap keys undo` reverses the most recent `active` entry (and says which);
  `cctap keys undo --all` walks all of them newest-first. A `changed` binding is never
  touched: undoing someone else's newer binding is exactly the harm the journal exists
  to prevent. Both print what they ran.
- **K5** `doctor` gains one drift line: journaled bindings that are `gone` or
  `changed`, with the remedy (`cctap keys status` for the detail).
- **K6** `uninstall-hooks --purge` refuses while the journal holds an `active` entry,
  naming `cctap keys undo --all` first; `--purge --force` overrides. Without `--purge`
  the journal is left alone like the rest of `~/.cctap`.
- **K7** GNOME writes journal `previous` as the full prior gsettings state of the
  cctap keybinding path (the same strings today's output prints), so undo restores
  rather than merely deletes.
- **K8** Tests: journal round-trip, undo argv exactness through the exec seam, status
  against scripted mechanism answers (active/gone/changed), the purge refusal, and a
  bounded-journal truncation case.

## 9. Wizard writer rules (GNOME today, every future writer)

- **W1** Write order: the object's own keys first (`name`, `command`, `binding`), the
  list registration last. GNOME watches the list, so registering a half-written object
  races the settings daemon; the current code does it backwards.
- **W2** Key tokens are validated before anything is written. `gnomeBinding` silently
  dropping an unknown modifier word turns `hyper+j` into plain `j`, which binds a bare
  letter system-wide. An unknown token means no write: print what was not understood
  and the accepted words instead.
- **W3** Read-back verify: after the writes, read the binding back and compare. A
  mismatch is reported as a failure with the undo lines, never as success (R2: an OS
  grab fails silently, read-back is the only honest answer).
- **W4** macOS doorstep copy: say that the clipboard is about to be replaced before
  pbcopy runs, name the "Allow Running Scripts" toggle in the Shortcuts editor, and
  warn that the FIRST hotkey press pops a second, differently worded Automation
  consent naming Shortcuts as the asker, which full screen can hide (R1: fire the
  action once while the user is still watching).
