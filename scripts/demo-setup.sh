# Sourced by scripts/demo.tape inside the vhs shell. Builds a throwaway world on a
# scratch daemon, so the recording types plain `cctap` commands against the same
# four-session board the README hero shows.
D=$(mktemp -d /tmp/cctap-demo-XXXXXX)
printf '{"socket":"/tmp/cc-demo.sock"}' > "$D/config.json"
export CCTAP_DIR="$D" CCTAP_NOTIFY=off
# Piped one-shot renders read COLUMNS (a pipe has no tty width). Wide enough for
# the strip plus the one-time jump hint, inside the recording's real column count.
export COLUMNS=100
CCTAP_REPO="$PWD"
cctap() { node "$CCTAP_REPO/dist/cctap.mjs" "$@"; }
# A real executable on PATH as well: the strip's one-time hint teaches the short
# `cctap` form only when one exists, and a shell function is invisible to that check.
mkdir -p "$D/pathbin"
printf '#!/bin/sh\nexec node "%s/dist/cctap.mjs" "$@"\n' "$CCTAP_REPO" > "$D/pathbin/cctap"
chmod +x "$D/pathbin/cctap"
export PATH="$D/pathbin:$PATH"
# The daemon first, then the paced board fill lands while the strip is on screen.
(node "$CCTAP_REPO/dist/cctap.mjs" daemon >/dev/null 2>&1 &)
sleep 1.5
( sleep 2; node "$CCTAP_REPO/scripts/hero-world.mjs" /tmp/cc-demo.sock paced ) >/dev/null 2>&1 &
disown
sleep 0.3
clear
