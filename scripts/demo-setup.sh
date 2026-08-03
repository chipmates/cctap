# Sourced by scripts/demo.tape inside the vhs shell. Builds a throwaway world
# so the recording types plain `cctap` commands against simulated sessions.
D=$(mktemp -d /tmp/cctap-demo-XXXXXX)
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
# Delayed start: the strip goes up first, so the recording catches the world
# filling and the flip to the red double bang instead of joining mid-churn.
( sleep 2; cctap simulate busy-day --speed=2 --quiet ) >/dev/null 2>&1 &
disown
sleep 0.3
clear
