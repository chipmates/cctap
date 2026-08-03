# cctap state machine (single source of truth)

Pure reducer over normalized events (CONTRACTS §3). Session model per session:

```
main:      working | permission_wait | your_turn | failed | compacting | ended
slot:      number                // lowest free positive integer at creation, held for life
blocked:   Set<agentId>          // subagents waiting on permission/input
running:   Set<agentId>          // subagents currently running, by id
anonymous: number                // starts that carried no agentId (floor 0)
subagents: number                // running.size + anonymous, what `xn` shows
attentionKind, currentTool, lastMessage, ...metadata fields per CONTRACTS §2
```

## Display derivation (what renderers and jump use)

```
displayState(s):
  ended                                   if main == ended
  permission_wait                         if main == permission_wait OR blocked non-empty
  failed                                  if main == failed
  working                                 if main == your_turn AND subagents > 0     // R8
  your_turn                               if main == your_turn
  compacting                              if main == compacting
  working                                 otherwise
```

The state answers one question: **does this need me right now?** A session whose main turn
has stopped while its subagents still run does not, so it keeps the spinner (with the `xn`
suffix) and only becomes `your_turn` when the whole tree comes to rest. See R8.

Jump priority: oldest `permission_wait` → oldest `failed` → oldest `your_turn`
(by `stateSince` of the display state). Never `working`/`compacting`/`ended`.

## Rules

- **R1 — subagent isolation.** Events carrying `agentId` NEVER change `main`. They may only:
  add/remove that agentId in `blocked` and in `running`. A `PreToolUse` or
  `PermissionDenied` with `agentId` removes that agentId from `blocked` (its execution
  resumed). Subagents never touch `main`, but what they carry does reach `displayState`
  through R8.
  - `SubagentStart` with a known id is a **no-op**: a set, not a tally.
  - `SubagentStop` for an id that is not running is a **no-op**.
  - Only events with no `agentId` at all touch `anonymous`, which is a plain counter
    because there is nothing to identify.
  - This is where R7's "reapplying a transition is harmless" stops being free. A counter
    is not idempotent: a repeated `SubagentStop` used to decrement twice and report a
    finished tree while a subagent was still running, and a repeated `SubagentStart` used
    to leave the session spinning after the tree was done. Identity makes the repeats
    harmless again.
- **R2 — weak signals upgrade only.** `idle_prompt` and `agent_completed` set
  `main = your_turn` only from `working`. They never downgrade `permission_wait`, `failed`,
  or `compacting`.
- **R3 — user action resets.** `UserPromptSubmit`: `main = working`, `blocked` cleared,
  `attentionKind` cleared, `lastMessage` cleared (it described the turn that just ended).
- **R4 — main-agent activity clears waits.** `PreToolUse` without `agentId`:
  `main = working`, `currentTool = toolName` (clears permission_wait / your_turn / failed).
- **R5 — turn boundaries.** `Stop` (no agentId): `main = your_turn`, `currentTool` cleared.
  `StopFailure`: same, but `main = failed` and `lastMessage = error info`. Neither touches
  `blocked` or the subagent count: the tree can outlive the main turn, and R8 needs both.
  A blocked subagent therefore still shows `permission_wait` after a main `Stop`, which is
  correct, because that subagent is waiting on a human.
- **R8 — a delegated turn is not your turn.** `displayState` is derived from
  (`main`, running subagents, blocked subagents), in this order:

  | # | condition | displayState |
  |---|---|---|
  | 1 | any blocked subagent (or `main == permission_wait`) | `permission_wait` |
  | 2 | `main == failed` | `failed` |
  | 3 | `main == your_turn` and `running.size + anonymous > 0` | `working` (spinner + `xn`) |
  | 4 | otherwise | `main` |

  Order matters: a blocked subagent outranks a failed main turn, because a blocked
  subagent is the thing a human can act on. `main == ended` short-circuits everything
  above, so `SessionEnd` reads `ended` whatever the counts say.

  Consequences: the move INTO `your_turn` happens at the **last `SubagentStop`** when the
  main turn has already stopped, so `stateSince` and the desktop notification both land at
  tree rest, exactly once, and never at a main `Stop` that leaves subagents running. If the
  user interjects while subagents run (R3 → `main = working`), the last `SubagentStop`
  produces `working`, so there is no `your_turn` and no notification for that turn.

  Known cost: a `SubagentStop` that never arrives leaves the count above zero and the
  session on the spinner until `SessionEnd`. Preferred over the old reset, which reported
  a finished turn while the tree was still running.
- **R6 — unknown session.** Any event for an unknown sessionId creates the session
  (`inferred: true`), then applies the event. Best-guess `main = working` beforehand.
  Creation also assigns `slot`, the lowest positive integer no live session holds. A slot
  is never reassigned while its session record exists, and a re-seen sessionId keeps its
  record, so it keeps its number. `cctap jump <n>` resolves a purely numeric argument
  against `slot` and never against a label.
- **R9 — ended is terminal.** Once `main == ended`, only `SessionStart` changes anything
  (it revives the session and clears `endedReason`). Every other main event is a no-op.
  Without this a late `Stop` resurrects the session as `your_turn`, still carrying
  `endedReason`, which escapes the ended TTL sweep and becomes a jump target for a session
  that is gone. Subagent-tagged events keep following R1 and cannot revive anything.
- **R7 — idempotent / unknown-safe.** Unknown event names and unknown notif values are
  no-ops. Reapplying a transition already in effect is harmless.

## Event table (no `agentId` unless stated)

| Normalized event | Effect |
|---|---|
| `SessionStart` (any source) | ensure session; `main = working`; capture cwd/source/env/ppid/transcript; `source=compact` also ends any `compacting` |
| `UserPromptSubmit` | R3 |
| `PreToolUse` | R4 |
| `PreToolUse` + agentId | R1 (unblock agentId) |
| `PermissionDenied` | if `main == permission_wait` → `main = working` |
| `PermissionDenied` + agentId | R1 (unblock agentId) |
| `Notification permission_prompt` | `main = permission_wait`, kind `permission`, store message |
| `Notification permission_prompt` + agentId | R1 (block agentId) |
| `Notification agent_needs_input` [+ agentId] | as permission_prompt, kind `agent_needs_input` |
| `Notification elicitation_dialog` [+ agentId] | as permission_prompt, kind `elicitation` |
| `Notification elicitation_response` | if `main == permission_wait` and kind `elicitation` → `main = working` |
| `Notification elicitation_response` + agentId | R1 (unblock agentId) |
| `Notification elicitation_complete` [+ agentId] | identical to `elicitation_response` (ruling 2026-08-02) |
| `Notification idle_prompt` | R2 upgrade to `your_turn`, kind `idle` |
| `Notification agent_completed` | R2 upgrade to `your_turn`, kind `agent_completed` |
| `Stop` | R5 → `your_turn` (display stays `working` while subagents run, R8) |
| `StopFailure` | R5 → `failed`; `lastMessage` = message or reason, cleared when neither is given |
| `SubagentStart` + agentId | add to `running` (no-op when already there) |
| `SubagentStart` (no agentId) | `anonymous += 1` |
| `SubagentStop` + agentId | remove from `running` (no-op when not there); unblock agentId; the last one after a main `Stop` is what reveals `your_turn` (R8) |
| `SubagentStop` (no agentId) | `anonymous = max(0, anonymous-1)` |
| `PreCompact` | `main = compacting` |
| `PostCompact` | if `main == compacting` → `main = working` |
| `CwdChanged` | update cwd; re-resolve project/branch (daemon side effect) |
| `SessionEnd` | `main = ended`, store reason |
| any main event while `ended` | no-op (R9); `SessionStart` revives and clears `endedReason` |

`stateSince` updates whenever `displayState` changes value. `lastEventTs` updates on every
event for a **known** session, including unknown event names, which also clear liveness
flags but cause no transition (any event proves the session alive). An unknown event name
for an unknown session creates nothing: R7 wins over R6 (ruling 2026-08-02). Events are
processed in arrival order; `ts` is used for display and staleness only (same-machine
clocks; no reordering logic in v1).

## Sweeps (explicit `sweep(model, nowTs)`, called every 60 s and on demand)

- `ended` sessions: removed 5 min after entering `ended`.
- Liveness: `process.kill(ppid, 0)` fails → grace 60 s → session removed. Daemon-side; the
  reducer only exposes `markStaleCandidate`/`confirm` used after snapshot restore.

## Required test scenarios beyond the fixtures

1. Daemon-restart inference: mid-stream `PreToolUse` for unknown session (R6) → session exists,
   `inferred`, then `Notification permission_prompt` → `permission_wait`.
2. `PermissionDenied` after main `permission_wait` → `working` (and with agentId variant).
3. Compact cycle: `PreCompact` → `PostCompact` → `working`; and `PreCompact` →
   `SessionStart(source=compact)` → `working`.
4. `SubagentStop` for an agentId in `blocked` clears it (count and blocked both).
5. `SessionEnd` → `ended`; sweep removes after 5 min; earlier sweeps keep it.
6. R7: unknown event name, unknown notif, double `Stop`, `PostCompact` while `working`.
7. Label collision: two sessions same project:branch → distinct display labels (renderer
   layer, golden test).
8. `auth_success` notification is a no-op (not in table = R7).
9. R8 bookkeeping: a duplicate `SubagentStop`, a `SubagentStop` for an id that never
   started, and a duplicate `SubagentStart` all leave the running set correct, so the
   `your_turn` notification lands once at true tree rest. Fixture:
   `spec/fixtures/subagent-bookkeeping.json`.
10. R8: main `Stop` with subagents running → `working` with the `xn` suffix; a blocked
   subagent in that state → `permission_wait`; the last `SubagentStop` → `your_turn` and
   exactly one notification; the same run with a `UserPromptSubmit` interjection → no
   `your_turn` and no notification. Fixture: `spec/fixtures/delegated-turn.json`.
