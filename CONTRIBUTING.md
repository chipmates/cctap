# Contributing

Thanks for looking. cctap is small on purpose, and the aim is to keep it that way.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test` builds first, then runs the suite with the node test runner. There is no watch
mode and no test framework. Node 22 or newer, pnpm, nothing else.

`pnpm build` produces three self-contained bundles in `dist/`: the CLI, the daemon and the
hook forwarder.

## Two hygiene rules that are not negotiable

**Never touch the real `~/.cctap` or `~/.claude`.** Every test and every manual run sets
`CCTAP_DIR` to a temp directory, and anything that reads Claude Code settings sets
`CCTAP_CLAUDE_SETTINGS`. A test that writes to a real home directory will be rejected.

**Never fire a real notification or a real terminal jump from a test.** Every test file
sets `CCTAP_NOTIFY=off` and `CCTAP_NO_EXEC=1` at import time, and `tempEnv()` passes both
to every child process it spawns. `tests/invariants.test.ts` fails if either guard is
removed. Desktop banners and Automation consent dialogs belong to the person running the
tool, not to a test run.

```bash
export CCTAP_DIR=$(mktemp -d /tmp/cctap-dev-XXXXXX)
export CCTAP_NOTIFY=off CCTAP_NO_EXEC=1
node dist/cctap.mjs simulate busy-day --quiet
node dist/cctap.mjs top          # Ctrl-C or q to leave
```

## The spec is normative

`spec/` is the source of truth, not the code:

- `spec/CONTRACTS.md` holds the protocol, the wire shapes and invariants I1 to I12.
- `spec/transitions.md` holds the state machine. The reducer implements this file.
- `spec/fixtures/*.json` are acceptance fixtures. The test suite consumes them verbatim.

If the code and the spec disagree, the spec wins. If you believe the spec is wrong, say so
in the pull request rather than quietly diverging.

## Verify a change locally

Beyond `pnpm test`, these are the checks worth running by hand before opening a pull
request. All of them use a throwaway directory and cannot touch your real setup.

```bash
export CCTAP_DIR=$(mktemp -d /tmp/cctap-dev-XXXXXX)
export CCTAP_NOTIFY=off CCTAP_NO_EXEC=1

# The whole surface, end to end
node dist/cctap.mjs simulate busy-day --speed=15 --quiet
node dist/cctap.mjs top | cat               # piped: one snapshot, no full screen
COLUMNS=90 node dist/cctap.mjs strip        # piped or redirected: one line, then exits
COLUMNS=12 node dist/cctap.mjs strip --rows 2
node dist/cctap.mjs status
node dist/cctap.mjs jump --dry-run          # prints the command, runs nothing
node dist/cctap.mjs stop                    # stop the daemon this run started

# On a terminal, strip and top take over until you leave them:
#   node dist/cctap.mjs strip     # Ctrl-C to leave
#   node dist/cctap.mjs top       # q or Ctrl-C to leave

# The hook forwarder must exit 0 and print nothing, ever
OUT=$(echo '{"session_id":"v","hook_event_name":"Stop"}' | node dist/hook-forward.mjs --event=Stop)
echo "exit=$? stdout_bytes=${#OUT}"          # exit=0 stdout_bytes=0

# install-hooks against a temp settings file, never your real one
export CCTAP_CLAUDE_SETTINGS=$CCTAP_DIR/settings.json
echo '{}' > "$CCTAP_CLAUDE_SETTINGS"
node dist/cctap.mjs install-hooks --dry-run
node dist/cctap.mjs install-hooks
node dist/cctap.mjs doctor
node dist/cctap.mjs uninstall-hooks --purge
```

The first-run story, from a packed tarball into a throwaway HOME, is scripted:

```bash
scripts/fresh-machine.sh     # fails itself if it takes over two minutes
```

## Pull requests

- Every behaviour change needs a test. State machine changes need a row in
  `tests/coverage.test.ts`, which walks the whole event table.
- Keep the runtime dependency count at zero. `dependencies` stays `{}`.
- TypeScript strict. No `any`.
- Comments state a constraint the code cannot show, in a line or two. No decision
  narratives, no names.
- Commit subjects in the imperative mood, under 72 characters.
- Run `pnpm typecheck && pnpm test` before pushing. CI runs both on Linux and macOS.

## Where things live

```
src/core/       the pure reducer, labels, jump priority. No I/O lives here.
src/daemon/     state ownership, socket, liveness, notifications, persistence.
src/render/     strip and table rendering. Pure functions, no terminal writes.
src/terminal/   jump adapters. Commands are built purely, then run through one exec seam.
src/commands/   one file per CLI command.
tests/          node:test, one file per area.
```

The reducer is pure by contract: no clock reads, no I/O, no randomness. Time enters
through an event timestamp or an explicit sweep call. Renderers are subscribers that never
write state back.
