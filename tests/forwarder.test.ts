/**
 * CONTRACTS section 5.3: I1 to I4 on the real bundled forwarder, including a
 * byte count on stdout and a measured runtime bound.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildWireEvent,
  captureEnv,
  FIELD_MAX_CHARS,
  HOOK_FIELD_WHITELIST,
  parseTag,
  pickHookFields,
} from '../src/hook/wire.js';
import { SUN_PATH_MAX } from '../src/paths.js';
import { distDir, getStateRaw, ms, runNode, socketUp, startDaemon, tempEnv, waitFor } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const FORWARDER = join(distDir(), 'hook-forward.mjs');
const BUDGET_MS = 100;
/** Process spawn plus node startup dwarfs the forwarder's own budget. */
const WALL_ALLOWANCE_MS = 1500;

const hookStdin = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/repos/authsvc',
    hook_event_name: 'Notification',
    permission_mode: 'default',
    ...extra,
  });

describe('forwarder wire format', () => {
  it('reads the tag from argv, not from the payload text', () => {
    assert.deepEqual(parseTag(['/x/hook-forward.mjs', '--event=Notification', '--notif=permission_prompt']), {
      event: 'Notification',
      notif: 'permission_prompt',
    });
    assert.deepEqual(parseTag(['--event=Stop']), { event: 'Stop' });
    assert.deepEqual(parseTag([]), { event: '' });
  });

  it('captures exactly the documented env keys', () => {
    const env = captureEnv({ TMUX_PANE: '%12', TERM_PROGRAM: 'Apple_Terminal', SECRET: 'nope' });
    assert.deepEqual(env, { TMUX_PANE: '%12', TERM_PROGRAM: 'Apple_Terminal' });
    // The kitty jump needs the remote-control socket, so the capture list carries it.
    assert.deepEqual(captureEnv({ KITTY_WINDOW_ID: '4', KITTY_LISTEN_ON: 'unix:/tmp/kitty-9' }), {
      KITTY_WINDOW_ID: '4',
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-9',
    });
  });

  it('wraps the hook payload verbatim', () => {
    const msg = buildWireEvent(hookStdin({ message: 'hi' }), ['--event=Notification', '--notif=idle_prompt'], {}, 42, 7);
    assert.equal(msg.v, 1);
    assert.equal(msg.kind, 'event');
    assert.equal(msg.ts, 42);
    assert.equal(msg.ppid, 7);
    assert.deepEqual(msg.tag, { event: 'Notification', notif: 'idle_prompt' });
    assert.equal(msg.hook.session_id, 'sess-1');
    assert.equal(msg.hook.message, 'hi');
  });

  it('survives malformed stdin and still carries the tag', () => {
    const msg = buildWireEvent('{not json', ['--event=Stop'], {}, 1, 2);
    assert.deepEqual(msg.tag, { event: 'Stop' });
    assert.deepEqual(msg.hook, {});
  });

  it('falls back to hook_event_name when argv carries no tag', () => {
    const msg = buildWireEvent(hookStdin(), [], {}, 1, 2);
    assert.equal(msg.tag.event, 'Notification');
  });
});

describe('hook field whitelist (I13)', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  /** A realistic payload: everything Claude Code sends, including the sensitive parts. */
  const fatPayload = {
    session_id: 'sess-1',
    hook_event_name: 'PreToolUse',
    cwd: '/repos/authsvc',
    transcript_path: '/tmp/t.jsonl',
    tool_name: 'Bash',
    agent_id: 'a1',
    agent_type: 'general-purpose',
    source: 'startup',
    message: 'needs permission',
    reason: 'other',
    permission_mode: 'default',
    prompt: 'my secret prompt about the acquisition',
    tool_input: { command: 'cat ~/.ssh/id_rsa', description: 'read the key' },
    tool_response: 'ssh-rsa AAAAB3NzaC1yc2EAAAA',
    extra_future_field: 'whatever Claude Code adds next',
  };

  it('copies the ten whitelisted fields and nothing else', () => {
    const picked = pickHookFields(fatPayload);
    assert.deepEqual(Object.keys(picked).sort(), [...HOOK_FIELD_WHITELIST].sort());
    assert.equal(HOOK_FIELD_WHITELIST.length, 10);
  });

  it('drops prompt, tool_input and tool_response by name and by value', () => {
    const line = JSON.stringify(buildWireEvent(JSON.stringify(fatPayload), ['--event=PreToolUse'], {}, 1, 2));
    for (const name of ['prompt', 'tool_input', 'tool_response', 'permission_mode', 'extra_future_field']) {
      assert.equal(line.includes(name), false, `field name ${name} leaked`);
    }
    for (const value of ['acquisition', 'id_rsa', 'ssh-rsa', 'AAAAB3', 'read the key']) {
      assert.equal(line.includes(value), false, `value ${value} leaked`);
    }
    assert.ok(line.includes('sess-1'), 'the session id still travels');
    assert.ok(line.includes('Bash'), 'the tool name still travels');
  });

  it('drops non-string values so an object cannot smuggle text through a whitelisted key', () => {
    const picked = pickHookFields({ tool_name: { nested: 'secret' }, session_id: 'ok', cwd: 123 });
    assert.deepEqual(picked, { session_id: 'ok' });
  });

  it('keeps nothing at all from an empty or hostile payload', () => {
    assert.deepEqual(pickHookFields({}), {});
    assert.deepEqual(pickHookFields({ __proto__: { polluted: true }, prompt: 'x' }), {});
  });

  it('the spool on disk carries no prompt text either (I13 end to end)', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, ['--event=UserPromptSubmit'], {
      env: t.env,
      input: JSON.stringify({
        session_id: 'sp-1',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/repos/x',
        prompt: 'the secret prompt nobody should find on disk',
        tool_input: { command: 'rm -rf /' },
      }),
    });
    assert.equal(r.code, 0);
    const spooled = fs.readFileSync(join(t.dir, 'spool', 'events.ndjson'), 'utf8');
    assert.equal(spooled.includes('secret prompt'), false, 'prompt text reached the disk');
    assert.equal(spooled.includes('prompt'), false, 'even the field name reached the disk');
    assert.equal(spooled.includes('rm -rf'), false, 'tool input reached the disk');
    assert.ok(spooled.includes('sp-1'), 'the session id is still there');
  });
});

describe('forwarder contract (I1-I4)', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('daemon down: exits 0, writes no stdout, spools the event', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, ['--event=Notification', '--notif=permission_prompt'], {
      env: t.env,
      input: hookStdin({ message: 'needs permission' }),
    });
    assert.equal(r.code, 0, 'I1: exit 0');
    assert.equal(r.stdout.byteLength, 0, `I2: stdout must be empty, got ${JSON.stringify(r.stdout.toString())}`);
    assert.ok(r.ms < WALL_ALLOWANCE_MS, `I3: wall clock ${r.ms}ms`);

    const spool = join(t.dir, 'spool', 'events.ndjson');
    assert.ok(fs.existsSync(spool), 'I4: spool file written');
    const lines = fs.readFileSync(spool, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const msg = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(msg.kind, 'event');
    assert.deepEqual(msg.tag, { event: 'Notification', notif: 'permission_prompt' });
    assert.equal((msg.hook as Record<string, unknown>).session_id, 'sess-1');
    assert.ok(typeof msg.ppid === 'number' && msg.ppid > 0, 'ppid captured');
  });

  it('an over-long socket path spools instead of delivering into a stranger (I14)', async () => {
    const t = tempEnv();
    envs.push(t);
    // A truncated path belongs to whoever bound it first, so nothing may be sent there.
    const pad = SUN_PATH_MAX + 24 - t.dir.length - '/cctap.sock'.length;
    const dir = join(t.dir, 'd'.repeat(Math.max(pad, 1)));
    fs.mkdirSync(dir, { recursive: true });

    const r = await runNode(FORWARDER, ['--event=Stop'], {
      env: { ...t.env, CCTAP_DIR: dir },
      input: hookStdin(),
    });
    assert.equal(r.code, 0, 'I1 still holds');
    assert.equal(r.stdout.byteLength, 0, 'I2 still holds');
    assert.ok(r.ms < WALL_ALLOWANCE_MS, `I3: wall clock ${r.ms}ms`);
    assert.equal(fs.existsSync(join(dir, 'cctap.sock')), false, 'no socket, truncated or otherwise');
    const spooled = fs.readFileSync(join(dir, 'spool', 'events.ndjson'), 'utf8').trim().split('\n');
    assert.equal(spooled.length, 1, 'I4: the event is kept, not dropped');
  });

  /**
   * A line over the daemon's 1 MiB cap used to be destroyed on arrival while the
   * forwarder had already reported success: no delivery, no spool, exit 0. And a huge
   * stdin blew the 100 ms budget in the encode. Both are bounded now.
   */
  for (const [label, size] of [
    ['900 KiB', 900 * 1024],
    ['1 MiB', 1024 * 1024],
    ['25 MiB', 25 * 1024 * 1024],
  ] as const) {
    it(`survives a ${label} message: the event still lands, truncated and in budget`, async () => {
      const t = tempEnv();
      envs.push(t);
      const r = await runNode(FORWARDER, ['--event=Notification', '--notif=permission_prompt'], {
        env: t.env,
        input: hookStdin({ message: 'x'.repeat(size) }),
      });
      assert.equal(r.code, 0, 'I1');
      assert.equal(r.stdout.byteLength, 0, 'I2');
      assert.ok(r.ms < WALL_ALLOWANCE_MS, `I3: wall clock ${r.ms}ms for ${label}`);

      const spooled = fs.readFileSync(join(t.dir, 'spool', 'events.ndjson'), 'utf8').trim().split('\n');
      assert.equal(spooled.length, 1, 'I4: exactly one event kept');
      const line = spooled[0] as string;
      assert.ok(line.length < 1024 * 1024, `the wire line fits the daemon cap: ${line.length} bytes`);
      const msg = JSON.parse(line) as { hook: Record<string, string> };
      assert.equal(msg.hook.session_id, 'sess-1', 'and it is still attributable');
      const kept = msg.hook.message ?? '';
      assert.ok(kept.length > 0 && kept.length <= FIELD_MAX_CHARS + 1, `free text truncated, not dropped: ${kept.length}`);
      assert.match(kept, /^x+…?$/, 'and what is kept is the real prefix');
    });
  }

  it('spool file and directory keep 0600/0700 (I5)', () => {
    const t = envs[0] as ReturnType<typeof tempEnv>;
    assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(t.dir, 'spool', 'events.ndjson')).mode & 0o777, 0o600);
  });

  it('malformed stdin still exits 0 with empty stdout', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, ['--event=Stop'], { env: t.env, input: 'this is not json at all' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);
  });

  it('empty stdin still exits 0 with empty stdout', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, ['--event=Stop'], { env: t.env, input: '' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);
  });

  it('no argv tag at all still exits 0 with empty stdout', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, [], { env: t.env, input: hookStdin() });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);
  });

  it('an unwritable cctap dir still exits 0 with empty stdout', async () => {
    const t = tempEnv();
    envs.push(t);
    fs.chmodSync(t.dir, 0o500);
    try {
      const r = await runNode(FORWARDER, ['--event=Stop'], { env: t.env, input: hookStdin() });
      assert.equal(r.code, 0, 'I1 holds even when the spool cannot be written');
      assert.equal(r.stdout.byteLength, 0);
    } finally {
      fs.chmodSync(t.dir, 0o700);
    }
  });

  it('self-reports an internal runtime inside the 100 ms budget (I3)', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(FORWARDER, ['--event=Stop'], {
      env: { ...t.env, CCTAP_DEBUG: '1' },
      input: hookStdin({ hook_event_name: 'Stop' }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0, 'CCTAP_DEBUG writes to stderr only (I2)');
    const m = /done in (\d+)ms/.exec(r.stderr.toString());
    assert.ok(m, `expected a timing line, got: ${r.stderr.toString()}`);
    const elapsed = Number.parseInt(m[1] as string, 10);
    assert.ok(elapsed < BUDGET_MS, `I3: forwarder ran ${elapsed}ms, budget ${BUDGET_MS}ms`);
  });

  it('a huge payload still exits 0 inside the budget', async () => {
    const t = tempEnv();
    envs.push(t);
    const big = hookStdin({ message: 'x'.repeat(200_000) });
    const r = await runNode(FORWARDER, ['--event=Notification', '--notif=idle_prompt'], { env: t.env, input: big });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);
  });

  it('daemon up: delivers over the socket and leaves no spool', async () => {
    const t = tempEnv();
    envs.push(t);
    const daemon = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)), 'daemon came up');

    const r = await runNode(FORWARDER, ['--event=SessionStart'], {
      env: t.env,
      input: hookStdin({ hook_event_name: 'SessionStart', source: 'startup' }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);

    const seen = await waitFor(async () => {
      const state = await getStateRaw(sock);
      const sessions = (state?.sessions ?? []) as { sessionId: string }[];
      return sessions.some((s) => s.sessionId === 'sess-1');
    });
    assert.ok(seen, 'the daemon received the forwarded event');
    assert.equal(fs.existsSync(join(t.dir, 'spool', 'events.ndjson')), false, 'nothing spooled on the happy path');
    daemon.kill('SIGTERM');
  });

  // Spawns a real daemon and waits on a real socket, so it carries its own deadline:
  // on a slow runner this is the test most likely to sit and wait.
  it('spawns the daemon from the stable bin path when one is installed', { timeout: ms(25_000) }, async () => {
    const t = tempEnv();
    envs.push(t);
    fs.mkdirSync(join(t.dir, 'bin'), { recursive: true });
    fs.copyFileSync(join(distDir(), 'daemon.mjs'), join(t.dir, 'bin', 'daemon.mjs'));

    const r = await runNode(FORWARDER, ['--event=SessionStart'], {
      env: t.env,
      input: hookStdin({ hook_event_name: 'SessionStart', source: 'startup' }),
      timeoutMs: ms(10_000),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.byteLength, 0);

    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)), 'the forwarder started a daemon');

    // The first event may land in the spool; the daemon replays it either way.
    const seen = await waitFor(async () => {
      const state = await getStateRaw(sock);
      const sessions = (state?.sessions ?? []) as { sessionId: string }[];
      return sessions.some((s) => s.sessionId === 'sess-1');
    }, 6000);
    assert.ok(seen, 'the event reached the spawned daemon');
  });
});
