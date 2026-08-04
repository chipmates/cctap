/** The published session shape is exactly CONTRACTS section 2, no more, no less. */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { getStateRaw, sendLines, socketUp, startDaemon, tempEnv, waitFor, wireEvent } from './helpers.js';
import { VERSION } from '../src/version.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const REQUIRED = [
  'sessionId',
  'slot',
  'project',
  'branch',
  'cwd',
  'transcriptPath',
  'sessionSource',
  'state',
  'displayState',
  'stateSince',
  'lastEventTs',
  'sessionStart',
  'subagents',
  'terminal',
  'ppid',
];

const OPTIONAL = ['currentTool', 'lastMessage', 'attentionKind', 'inferred', 'endedReason'];

describe('wire shape', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('publishes every contract field and nothing else', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    await sendLines(sock, [
      wireEvent({
        event: 'SessionStart',
        sessionId: 'w1',
        source: 'startup',
        cwd: t.dir,
        env: { TMUX: '/tmp/s', TMUX_PANE: '%7', CLAUDE_PROJECT_DIR: t.dir },
      }),
      wireEvent({ event: 'PreToolUse', sessionId: 'w1', toolName: 'Bash' }),
      wireEvent({ event: 'Notification', notif: 'permission_prompt', sessionId: 'w1', message: 'permission?' }),
      wireEvent({ event: 'SubagentStart', sessionId: 'w1', agentId: 'a1' }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[]).length === 1));

    const msg = await getStateRaw(sock);
    assert.equal(msg?.v, 1);
    assert.equal(msg?.kind, 'state');
    const s = (msg?.sessions as Record<string, unknown>[])[0] as Record<string, unknown>;

    for (const key of REQUIRED) assert.ok(key in s, `missing ${key}`);
    const extra = Object.keys(s).filter((k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k));
    assert.deepEqual(extra, [], 'no fields beyond the contract');

    assert.equal(s.state, 'permission_wait');
    assert.equal(s.displayState, 'permission_wait');
    assert.equal(s.attentionKind, 'permission');
    assert.equal(s.lastMessage, 'permission?');
    assert.equal(s.currentTool, 'Bash');
    // Tracked by identity: the running set is published, and active is its size plus
    // the anonymous count, so a renderer never has to add anything up itself.
    assert.deepEqual(s.subagents, { active: 1, running: ['a1'], anonymous: 0, blocked: [] });
    assert.deepEqual(s.terminal, { kind: 'tmux', tmuxPane: '%7' });
    assert.equal(s.ppid, process.pid);
    assert.equal(typeof s.stateSince, 'number');
    assert.equal(typeof s.sessionStart, 'number');
    assert.equal(typeof s.lastEventTs, 'number');
    d.kill('SIGTERM');
  });

  it('reads config.json for the theme', async () => {
    const t = tempEnv();
    envs.push(t);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ theme: 'ascii' }));
    const { runNode, distDir } = await import('./helpers.js');
    const env = { ...t.env };
    delete env.CCTAP_THEME;
    // A live daemon, so this reads an actually empty board rather than a missing one.
    const d = startDaemon(env);
    assert.ok(await waitFor(() => socketUp(join(t.dir, 'cctap.sock'))));
    const r = await runNode(join(distDir(), 'cctap.mjs'), ['top'], { env });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString(), `cctap ${VERSION}  0 sessions\nno sessions\n`);
    d.kill('SIGTERM');
  });

  it('repairs loose permissions on start (I5)', async () => {
    const t = tempEnv();
    envs.push(t);
    const fs = await import('node:fs');
    fs.mkdirSync(join(t.dir, 'spool'), { recursive: true });
    fs.writeFileSync(join(t.dir, 'state.json'), '{"v":1,"sessions":[]}', { mode: 0o644 });
    fs.chmodSync(t.dir, 0o755);

    const d = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(join(t.dir, 'cctap.sock'))));
    assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700, 'directory repaired');
    assert.equal(fs.statSync(join(t.dir, 'state.json')).mode & 0o777, 0o600, 'state.json repaired');
    d.kill('SIGTERM');
  });
});
