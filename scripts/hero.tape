# The README hero still: the strip exactly as the status line renders it, with the
# one-time typed-jump hint. Record from the repo root with: vhs scripts/hero.tape
# Then crop the band and move it into place, for example:
#   ffmpeg -y -i hero-full.png -vf "crop=1620:84:0:6" docs/statusline.png
#   rm -f hero-full.png hero-tmp.gif

Output hero-tmp.gif

Set FontSize 26
Set Width 1620
Set Height 170
Set Padding 24

Hide
Type `D=$(mktemp -d /tmp/cctap-hero-XXXXXX); export CCTAP_DIR="$D" CCTAP_NOTIFY=off COLUMNS=100; R="$PWD"`
Enter
Type `mkdir -p "$D/pb"; printf '#!/bin/sh\nexec node "%s/dist/cctap.mjs" "$@"\n' "$R" > "$D/pb/cctap"; chmod +x "$D/pb/cctap"; export PATH="$D/pb:$PATH"`
Enter
Type `node "$R/dist/cctap.mjs" simulate busy-day --speed=8 --quiet >/dev/null 2>&1`
Enter
Sleep 5s
Type `clear; CCTAP_COLOR=1 node "$R/dist/cctap.mjs" strip | cat; sleep 25`
Enter
Sleep 2s
Show
Screenshot hero-full.png
Sleep 300ms
