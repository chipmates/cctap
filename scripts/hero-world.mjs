// Injects a four-session world into a scratch cctap daemon: the board the README
// shows. States: authsvc working (the "you" session), blog working, docs blocked on
// a permission, infra at your-turn. Paced mode replays it as a timeline and adds the
// delegation arc: blog fans out subagents (x2, then x5), its own turn ends while
// they run, and the last stop flips it to your-turn.
import net from 'node:net';

const sock = process.argv[2];
const now = Date.now();
const ppid = process.pid;

const ev = (sid, dir, event, extra = {}, notif) => JSON.stringify({
  v: 1, kind: 'event', ts: now, tag: notif ? { event, notif } : { event },
  hook: { session_id: sid, hook_event_name: event, cwd: dir, ...extra },
  env: { CLAUDE_PROJECT_DIR: dir }, ppid,
}) + '\n';

const base = [
  [
    ev('s-authsvc', '/tmp/authsvc', 'SessionStart', { source: 'startup' }),
    ev('s-authsvc', '/tmp/authsvc', 'UserPromptSubmit'),
    ev('s-authsvc', '/tmp/authsvc', 'PreToolUse', { tool_name: 'Bash' }),
  ],
  [
    ev('s-blog', '/tmp/blog', 'SessionStart', { source: 'startup' }),
    ev('s-blog', '/tmp/blog', 'UserPromptSubmit'),
  ],
  [
    ev('s-docs', '/tmp/docs', 'SessionStart', { source: 'startup' }),
    ev('s-docs', '/tmp/docs', 'UserPromptSubmit'),
    ev('s-docs', '/tmp/docs', 'PreToolUse', { tool_name: 'Bash' }),
    ev('s-docs', '/tmp/docs', 'Notification', { message: 'Claude needs your permission to use Bash' }, 'permission_prompt'),
  ],
  [
    ev('s-infra', '/tmp/infra', 'SessionStart', { source: 'startup' }),
    ev('s-infra', '/tmp/infra', 'UserPromptSubmit'),
    ev('s-infra', '/tmp/infra', 'Stop'),
  ],
];

const delegation = [
  [
    ev('s-blog', '/tmp/blog', 'SubagentStart', { agent_id: 'a1' }),
    ev('s-blog', '/tmp/blog', 'SubagentStart', { agent_id: 'a2' }),
  ],
  [
    ev('s-blog', '/tmp/blog', 'SubagentStart', { agent_id: 'a3' }),
    ev('s-blog', '/tmp/blog', 'SubagentStart', { agent_id: 'a4' }),
    ev('s-blog', '/tmp/blog', 'SubagentStart', { agent_id: 'a5' }),
  ],
  [
    ev('s-blog', '/tmp/blog', 'Stop'),
    ev('s-blog', '/tmp/blog', 'SubagentStop', { agent_id: 'a1' }),
    ev('s-blog', '/tmp/blog', 'SubagentStop', { agent_id: 'a2' }),
    ev('s-blog', '/tmp/blog', 'SubagentStop', { agent_id: 'a3' }),
  ],
  [
    ev('s-blog', '/tmp/blog', 'SubagentStop', { agent_id: 'a4' }),
    ev('s-blog', '/tmp/blog', 'SubagentStop', { agent_id: 'a5' }),
  ],
];

const paced = process.argv[3] === 'paced';

const c = net.connect(sock, async () => {
  if (!paced) {
    c.end(base.flat().join(''), () => process.exit(0));
    return;
  }
  for (const g of [...base, ...delegation]) {
    c.write(g.join(''));
    await new Promise((r) => setTimeout(r, 1600));
  }
  c.end('', () => process.exit(0));
});
c.on('error', (e) => { console.error(String(e)); process.exit(1); });
