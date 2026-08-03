# The README hero still: a four-session board rendered exactly as the status line
# renders it, with the you-marker and the one-time jump hint. Record from the repo
# root with: vhs scripts/hero.tape
# Then crop the band and move it into place:
#   ffmpeg -y -i hero-full.png -vf "crop=1620:84:0:6" docs/statusline.png
#   rm -f hero-full.png hero-tmp.gif

Output hero-tmp.gif

Set FontSize 26
Set Width 1620
Set Height 170
Set Padding 24

Hide
Type `D=$(mktemp -d /tmp/cc-hero-XXXXXX); printf '{"socket":"/tmp/cc-hero.sock"}' > "$D/config.json"; export CCTAP_DIR="$D" CCTAP_NOTIFY=off COLUMNS=100; R="$PWD"`
Enter
Type `(node "$R/dist/cctap.mjs" daemon >/dev/null 2>&1 &); sleep 1.5; node "$R/scripts/hero-world.mjs" /tmp/cc-hero.sock; sleep 1`
Enter
Sleep 4s
Type `clear; printf '{"session_id":"s-authsvc"}' | CCTAP_COLOR=1 node "$R/dist/cctap.mjs" strip | cat; sleep 25`
Enter
Sleep 2s
Show
Screenshot hero-full.png
Sleep 300ms
