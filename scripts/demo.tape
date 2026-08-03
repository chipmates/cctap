# cctap README demo. Record from the repo root with: vhs scripts/demo.tape
# Beats: the strip fills with the four-session board, the one-shot status line with
# the you-marker and the hint, top with the red row selected, status in words, then
# the delegated-turn scene. Same world as the hero still.

Output docs/demo.gif

Set FontSize 20
Set Width 1280
Set Height 300
Set Padding 16
Set TypingSpeed 45ms

Hide
Type "source scripts/demo-setup.sh"
Enter
Sleep 500ms
Show

Type "cctap strip"
Enter
Sleep 9s
Ctrl+C
Sleep 300ms

Hide
Type "clear"
Enter
Sleep 1s
Show

Type `printf '{"session_id":"s-authsvc"}' | CCTAP_COLOR=1 cctap strip | cat   # the line at the bottom of every session`
Enter
Sleep 3.5s

Hide
Type "clear"
Enter
Sleep 500ms
Show

Type "cctap top"
Enter
Sleep 1.2s
Type "j"
Sleep 400ms
Type "j"
Sleep 1.8s
Type "q"
Sleep 300ms

Hide
Type "clear"
Enter
Show

Type "cctap status"
Enter
Sleep 2s

Hide
Type "cctap stop"
Enter
Type 'D2=$(mktemp -d /tmp/cctap-demo2-XXXXXX); printf "{\"socket\":\"/tmp/cc-demo2.sock\"}" > "$D2/config.json"; export CCTAP_DIR="$D2"; ( sleep 1.5; cctap simulate delegated-turn --speed=2 --quiet ) >/dev/null 2>&1 &'
Enter
Type "disown; clear"
Enter
Show

Type "cctap strip"
Enter
Sleep 9.5s
Ctrl+C
Sleep 300ms
