# cctap README demo. Record from the repo root with: vhs scripts/demo.tape
# Beats: the strip waits, the world fills with spinners, a hidden cut lands on
# the settled red tableau, top shows the full list, status closes the loop.
# The mid-strip Hide skips the scenario's churn: capture stops, time passes.

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
Sleep 5.5s
Hide
Sleep 13s
Show
Sleep 2.5s
Ctrl+C
Sleep 300ms

Hide
Type "clear"
Enter
Sleep 1s
Show

Type 'CCTAP_COLOR=1 cctap strip | cat   # the line at the bottom of every session'
Enter
Sleep 3.5s

Hide
Type "clear"
Enter
Sleep 500ms
Show

Type "cctap top"
Enter
Sleep 2.5s
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
Type 'D2=$(mktemp -d /tmp/cctap-demo2-XXXXXX); export CCTAP_DIR="$D2"; ( sleep 1.5; cctap simulate delegated-turn --speed=2 --quiet ) >/dev/null 2>&1 &'
Enter
Type "disown; clear"
Enter
Show

Type "cctap strip"
Enter
Sleep 9.5s
Ctrl+C
Sleep 300ms
