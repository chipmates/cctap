#!/usr/bin/env bash
# QUALITY C8: the first-run story, from a packed tarball into a throwaway HOME.
# Installs nothing into the real home directory and fires no notifications.
#
#   scripts/fresh-machine.sh
#
# Prints a timing line per step and the total. Cleans up after itself.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(mktemp -d /tmp/cctap-fresh-XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT

export HOME="$ROOT/home"
export CCTAP_DIR="$ROOT/home/.cctap"
export CCTAP_CLAUDE_SETTINGS="$ROOT/home/.claude/settings.json"
export CCTAP_NOTIFY=off
export CCTAP_NO_EXEC=1
export npm_config_yes=true
mkdir -p "$HOME/.claude"

START=$(date +%s)
step() { printf '%6ss  %s\n' "$(( $(date +%s) - START ))" "$1"; }

step "start, HOME=$HOME"

cd "$REPO"
TARBALL="$ROOT/$(npm pack --pack-destination "$ROOT" --silent 2>/dev/null | tail -1)"
step "npm pack -> $(basename "$TARBALL")"

npm install --global --prefix "$ROOT/prefix" "$TARBALL" >/dev/null 2>&1
CCTAP="$ROOT/prefix/bin/cctap"
step "installed to $CCTAP"

"$CCTAP" --version >/dev/null
step "cctap --version"

"$CCTAP" install-hooks >"$ROOT/install.log"
step "install-hooks ($(grep -cE '^  [+~=] [A-Z]' "$ROOT/install.log") registrations)"

"$CCTAP" simulate busy-day --speed=40 --quiet >/dev/null
step "simulate busy-day"

COLUMNS=80 "$CCTAP" strip
"$CCTAP" status
step "strip and status rendered"

"$CCTAP" doctor >"$ROOT/doctor.log" || true
step "doctor: $(tail -1 "$ROOT/doctor.log")"

"$CCTAP" uninstall-hooks --purge >/dev/null
step "uninstall-hooks --purge"

TOTAL=$(( $(date +%s) - START ))
echo
echo "total ${TOTAL}s (budget 120s)"
[ -e "$HOME/.cctap" ] && { echo "FAIL: state dir survived --purge"; exit 1; }
[ "$TOTAL" -le 120 ] || { echo "FAIL: over the two minute budget"; exit 1; }
echo "PASS"
