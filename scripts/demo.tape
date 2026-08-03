# cctap README demo. Record from the repo root with: vhs scripts/demo.tape
# The strip is the status line, not a command, so the strip beats show the bare
# living line with nothing typed: the launch is hidden and `clear` inside the same
# line removes the echo. Only top and status, which really are commands, are typed
# on camera. Same four-session world as the hero still.

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
Type "clear; cctap strip"
Enter
Sleep 200ms
Show

Sleep 9s

Hide
Ctrl+C
Sleep 300ms
Type `clear; printf '{"session_id":"s-authsvc"}' | CCTAP_COLOR=1 cctap strip | cat; sleep 20`
Enter
Sleep 400ms
Show

Sleep 3s

Hide
Ctrl+C
Sleep 200ms
Type "clear"
Enter
Sleep 300ms
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
Type "disown; clear; cctap strip"
Enter
Sleep 200ms
Show

Sleep 9.5s
Hide
Ctrl+C
Sleep 300ms
Show
