// Injects a four-session world into a scratch cctap daemon: the board the README
// hero shows. States: authsvc working (the "you" session), blog working, docs
// blocked on a permission, infra at your-turn.
import net from 'node:net';

const sock = process.argv[2];
const now = Date.now();
const ppid = process.pid;

const ev = (sid, dir, event, extra = {}, notif) => JSON.stringify({
  v: 1, kind: 'event', ts: now, tag: notif ? { event, notif } : { event },
  hook: { session_id: sid, hook_event_name: event, cwd: dir, ...extra },
  env: { CLAUDE_PROJECT_DIR: dir }, ppid,
}) + '\n';

const lines = [
  ev('s-authsvc', '/tmp/authsvc', 'SessionStart', { source: 'startup' }),
  ev('s-authsvc', '/tmp/authsvc', 'UserPromptSubmit'),
  ev('s-authsvc', '/tmp/authsvc', 'PreToolUse', { tool_name: 'Bash' }),
  ev('s-blog', '/tmp/blog', 'SessionStart', { source: 'startup' }),
  ev('s-blog', '/tmp/blog', 'UserPromptSubmit'),
  ev('s-docs', '/tmp/docs', 'SessionStart', { source: 'startup' }),
  ev('s-docs', '/tmp/docs', 'UserPromptSubmit'),
  ev('s-docs', '/tmp/docs', 'PreToolUse', { tool_name: 'Bash' }),
  ev('s-docs', '/tmp/docs', 'Notification', { message: 'Claude needs your permission to use Bash' }, 'permission_prompt'),
  ev('s-infra', '/tmp/infra', 'SessionStart', { source: 'startup' }),
  ev('s-infra', '/tmp/infra', 'UserPromptSubmit'),
  ev('s-infra', '/tmp/infra', 'Stop'),
];

// Paced mode animates the fill: one session group lands per beat, so a recording
// catches the board growing instead of appearing fully formed.
const paced = process.argv[3] === 'paced';
const groups = [lines.slice(0, 3), lines.slice(3, 5), lines.slice(5, 9), lines.slice(9)];
const c = net.connect(sock, async () => {
  if (!paced) {
    c.end(lines.join(''), () => process.exit(0));
    return;
  }
  for (const g of groups) {
    c.write(g.join(''));
    await new Promise((r) => setTimeout(r, 1400));
  }
  c.end('', () => process.exit(0));
});
c.on('error', (e) => { console.error(String(e)); process.exit(1); });
