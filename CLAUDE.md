# CLAUDE.md - cctap

Guidance for Claude Code and any other coding agent working in this repository.
Contribution guidelines are in CONTRIBUTING.md.

## What this is

**cctap** is a terminal-native attention router for parallel Claude Code sessions. It
watches sessions through hooks, keeps one state model in a small local daemon, renders a
glyph strip, and jumps you to the session that needs you.

## Hard rules

- **Zero runtime dependencies.** `package.json` `dependencies` stays `{}` forever.
  Runtime imports are `node:*` builtins or relative paths, nothing else.
- **Hooks must never disturb Claude Code.** The forwarder always exits 0, never writes to
  stdout, and self-terminates inside 100 ms. See invariants I1 to I3 in
  `spec/CONTRACTS.md`. On several hook events, stdout becomes model context and exit 2
  blocks the action, so both are absolute.
- **Never inject input into a Claude session.** Jumping there is the approve flow. The
  decision stays with the human.
- **Local only.** A unix socket under `~/.cctap/`, directory 0700, files 0600. No TCP, no
  telemetry, no network egress of any kind.
- **The state machine is a pure reducer.** No clock reads, no I/O, no randomness. Time
  enters through an event timestamp or an explicit sweep call.
- TypeScript strict, Node 22 or newer, pnpm.

## The spec is normative

- `spec/CONTRACTS.md`: socket protocol, wire shapes, invariants I1 to I19, test
  requirements.
- `spec/transitions.md`: the state machine, single source of truth for the reducer.
- `spec/fixtures/*.json`: acceptance fixtures, consumed verbatim by the test suite.

If code and spec disagree, the spec wins. Change the spec deliberately, in its own commit.

## Test hygiene, not negotiable

- Every test and every manual run sets `CCTAP_DIR` to a temp directory. Never the real
  `~/.cctap`.
- Anything touching Claude Code settings sets `CCTAP_CLAUDE_SETTINGS`. Never the real
  `~/.claude`.
- Every test file sets `CCTAP_NOTIFY=off` and `CCTAP_NO_EXEC=1` at import time, and
  `tempEnv()` passes both to child processes. No test may fire a desktop banner, send an
  Apple event, or pop an Automation consent dialog.
- `tests/invariants.test.ts` enforces the two rules above and will fail if they are
  weakened.
- State machine changes need a row in `tests/coverage.test.ts`, which walks the whole
  event table.

## Conventions

- Comments state a constraint the code cannot show, in one or two lines. No decision
  narratives, no history, no names anywhere in code, comments or commits.
- Commit subjects in the imperative mood, under 72 characters. No AI co-author trailers.
- Plain output, no colour library: raw ANSI behind a tiny util.
- Renderers are subscribers. They never write state back.
- External commands go through the single exec seam in `src/exec.ts`, so command
  construction stays pure and testable.

## Layout

```
src/core/       pure reducer, labels, jump priority. No I/O.
src/daemon/     state ownership, socket, liveness, notifications, persistence.
src/hook/       the wire shape the forwarder sends, and the field whitelist it obeys.
src/install/    the hook set and the status line entry install-hooks writes.
src/render/     strip and table rendering. Pure functions.
src/terminal/   jump adapters. Commands built purely, run through one exec seam.
src/commands/   one file per CLI command.
```
