# cctap README demo: the status line itself and nothing else, animated. The renderer
# is re-run in place exactly like Claude Code re-runs a status line, while the world
# fills behind it, so the one visible line is the product. Record from the repo root
# with: vhs scripts/demo.tape

Output docs/demo.gif

Set FontSize 26
Set Width 1620
Set Height 130
Set Padding 24

Hide
Type `D=$(mktemp -d /tmp/cctap-demo-XXXXXX); printf '{"socket":"/tmp/cc-demo.sock"}' > "$D/config.json"; export CCTAP_DIR="$D" CCTAP_NOTIFY=off COLUMNS=100; R="$PWD"; mkdir -p "$D/pb"; printf '#!/bin/sh\nexec node "%s/dist/cctap.mjs" "$@"\n' "$R" > "$D/pb/cctap"; chmod +x "$D/pb/cctap"; export PATH="$D/pb:$PATH"; printf '{"ok":true,"firstJumpAt":1}' > "$D/jump.json"`
Enter
Type `(node "$R/dist/cctap.mjs" daemon >/dev/null 2>&1 &); sleep 1.5; ( sleep 2; node "$R/scripts/hero-world.mjs" /tmp/cc-demo.sock paced ) >/dev/null 2>&1 & disown`
Enter
Type `clear; tput civis; while true; do L=$(printf '{"session_id":"s-authsvc"}' | CCTAP_COLOR=1 cctap strip); tput cup 0 0; tput el; printf '%s' "$L"; sleep 0.4; done`
Enter
Sleep 300ms
Show

Sleep 17s
