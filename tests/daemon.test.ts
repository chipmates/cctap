/**
 * CONTRACTS section 5.4: lock racing, snapshot round-trip, spool replay order,
 * liveness sweep removal, malformed-line resilience (I11).
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { detectTerminal, normalize } from '../src/daemon/normalize.js';
import { normalizeTty } from '../src/daemon/resolve.js';
import { loadSnapshot, PPID_TRUST_MS, serialize } from '../src/daemon/snapshot.js';
import { replaySpool, rotateSpool, spoolBacklog, spoolDropped, SPOOL_DROP_MARK } from '../src/daemon/spool.js';
import { acquireLock, readLockPid, UNREADABLE_GRACE_MS } from '../src/daemon/lock.js';
import { configFromEnv, Daemon } from '../src/daemon/main.js';
import { paths } from '../src/paths.js';
import { markStaleCandidates, reduce } from '../src/core/reducer.js';
import { emptyModel, type NormalizedEvent } from '../src/core/types.js';
import type { WireEvent } from '../src/proto.js';
import { splitLines } from '../src/proto.js';
import { VERSION } from '../src/version.js';
import {
  distDir,
  getStateRaw,
  ms,
  runNode,
  sendLines,
  socketUp,
  startDaemon,
  tempEnv,
  waitFor,
  wireEvent,
} from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const DAEMON = join(distDir(), 'daemon.mjs');

interface StateSession {
  sessionId: string;
  displayState: string;
  state: string;
  project: string;
  branch: string;
  currentTool?: string;
  subagents: { active: number; blocked: string[] };
  ppid: number;
  deadSince?: number;
  staleCandidate?: boolean;
}

async function sessions(sock: string): Promise<StateSession[]> {
  const msg = await getStateRaw(sock);
  return ((msg?.sessions ?? []) as StateSession[]) ?? [];
}

describe('normalize', () => {
  it('maps a wire event onto the normalized shape', () => {
    const wire = JSON.parse(
      wireEvent({
        event: 'Notification',
        notif: 'permission_prompt',
        sessionId: 's1',
        cwd: '/repos/x',
        message: 'needs permission',
        ppid: 4242,
        env: { TERM_PROGRAM: 'Apple_Terminal', TERM_SESSION_ID: 'abc', CLAUDE_PROJECT_DIR: '/repos/x' },
      }),
    ) as WireEvent;
    const ev = normalize(wire, 999);
    assert.ok(ev);
    assert.equal(ev.sessionId, 's1');
    assert.equal(ev.event, 'Notification');
    assert.equal(ev.notif, 'permission_prompt');
    assert.equal(ev.message, 'needs permission');
    assert.equal(ev.meta?.ppid, 4242);
    assert.equal(ev.meta?.projectDir, '/repos/x');
    assert.equal(ev.meta?.terminal?.kind, 'apple-terminal');
  });

  it('drops an event with no session id', () => {
    const wire = { v: 1, kind: 'event', ts: 1, tag: { event: 'Stop' }, hook: {}, env: {}, ppid: 1 } as WireEvent;
    assert.equal(normalize(wire, 1), undefined);
  });

  it('detects terminals with tmux winning over the host', () => {
    assert.equal(detectTerminal({ TMUX: '/tmp/x', TMUX_PANE: '%3', TERM_PROGRAM: 'iTerm.app' }).kind, 'tmux');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }).kind, 'apple-terminal');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }).kind, 'iterm2');
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: '4' }).kind, 'kitty');
    assert.deepEqual(detectTerminal({ KITTY_WINDOW_ID: '4', KITTY_LISTEN_ON: 'unix:/tmp/kitty-9' }), {
      kind: 'kitty',
      kittyWindowId: '4',
      kittyListenOn: 'unix:/tmp/kitty-9',
    });
    assert.deepEqual(detectTerminal({ KITTY_WINDOW_ID: '4', KITTY_LISTEN_ON: '' }), {
      kind: 'kitty',
      kittyWindowId: '4',
    });
    assert.equal(detectTerminal({ WEZTERM_PANE: '2' }).kind, 'wezterm');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode' }).kind, 'unknown');
    assert.equal(detectTerminal({}).kind, 'unknown');
  });

  it('normalizes tty output from both platforms', () => {
    assert.equal(normalizeTty('s003'), 'ttys003');
    assert.equal(normalizeTty('pts/4'), 'pts/4');
    assert.equal(normalizeTty('??'), undefined);
    assert.equal(normalizeTty('   '), undefined);
    assert.equal(normalizeTty(undefined), undefined);
  });
});

describe('protocol framing (I11)', () => {
  it('splits complete lines and keeps the tail', () => {
    const r = splitLines('{"a":1}\n{"b":2}\n{"c":');
    assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
    assert.equal(r.rest, '{"c":');
    assert.equal(r.overflow, false);
  });

  it('drops a line over the 1 MB cap', () => {
    const r = splitLines(`${'x'.repeat(1024 * 1024 + 1)}\n{"ok":1}\n`);
    assert.deepEqual(r.lines, ['{"ok":1}']);
    assert.equal(r.overflow, true);
  });

  it('discards an unterminated line over the cap instead of buffering it', () => {
    const r = splitLines('y'.repeat(1024 * 1024 + 1));
    assert.equal(r.rest, '');
    assert.equal(r.overflow, true);
  });
});

describe('spool discipline', () => {
  it('replays claim files oldest first across the pid digit boundary', () => {
    const t = tempEnv();
    const dir = join(t.dir, 'spool');
    fs.mkdirSync(dir, { recursive: true });
    const spool = join(dir, 'events.ndjson');
    const line = (id: string): string =>
      `${JSON.stringify({ v: 1, kind: 'event', ts: 1, tag: { event: 'Stop' }, hook: { session_id: id }, env: {}, ppid: 1 })}\n`;

    // Two leftovers whose pids straddle the digit boundary: 999 sorts after 1000 as a
    // string, which used to replay the older file second and resurrect answered state.
    fs.writeFileSync(`${spool}.replaying-00000000001000-999`, line('first'));
    fs.writeFileSync(`${spool}.replaying-00000000002000-1000`, line('second'));

    const seen: string[] = [];
    replaySpool(spool, (msg) => {
      const hook = msg.hook as { session_id: string };
      seen.push(hook.session_id);
    });
    assert.deepEqual(seen, ['first', 'second'], 'time order, not string order over pids');
    t.cleanup();
  });

  /** Sets up an empty spool directory and returns its path plus the temp env. */
  const spoolEnv = (): { t: ReturnType<typeof tempEnv>; spool: string } => {
    const t = tempEnv();
    const dir = join(t.dir, 'spool');
    fs.mkdirSync(dir, { recursive: true });
    return { t, spool: join(dir, 'events.ndjson') };
  };

  const eventLine = (id: string): string =>
    `${JSON.stringify({ v: 1, kind: 'event', ts: 1, tag: { event: 'Stop' }, hook: { session_id: id }, env: {}, ppid: 1 })}\n`;

  const segments = (spool: string): string[] =>
    fs
      .readdirSync(join(spool, '..'))
      .filter((n) => n.startsWith('events.ndjson.replaying-'))
      .sort();

  it('rotates instead of rewriting, so a concurrent append cannot be lost', () => {
    const { t, spool } = spoolEnv();
    // The repro: one writer appends, hits the bound and rotates, while a second writer
    // appends around it. The rewrite version read the whole file, filtered it and wrote
    // it back, so whichever append landed between the read and the write was gone.
    fs.appendFileSync(spool, eventLine('before-rotation'));
    fs.appendFileSync(spool, 'x'.repeat(2048));

    assert.equal(rotateSpool(spool, 1024), 0, 'under the segment cap nothing is dropped');
    assert.equal(fs.existsSync(spool), false, 'the live file was renamed aside, not rewritten');
    fs.appendFileSync(spool, eventLine('after-rotation'));

    const seen: string[] = [];
    replaySpool(spool, (msg) => seen.push((msg.hook as { session_id: string }).session_id));
    assert.deepEqual(seen, ['before-rotation', 'after-rotation'], 'both survived, in order');
    t.cleanup();
  });

  it('leaves a spool under the size bound completely alone', () => {
    const { t, spool } = spoolEnv();
    fs.writeFileSync(spool, eventLine('small'));
    const before = fs.statSync(spool);
    assert.equal(rotateSpool(spool, 1024 * 1024), 0);
    assert.equal(fs.statSync(spool).ino, before.ino, 'same inode: the fast path only stats');
    assert.equal(segments(spool).length, 0, 'and creates no segment');
    assert.equal(rotateSpool(join(spool, 'nope')), 0, 'a spool that does not exist is not an error');
    t.cleanup();
  });

  it('caps the segments, counting leftovers a crashed daemon left behind', () => {
    const { t, spool } = spoolEnv();
    // Three leftovers as if a daemon had crashed between claiming and unlinking.
    for (const [i, stamp] of ['00000000001000', '00000000002000', '00000000003000'].entries()) {
      fs.writeFileSync(`${spool}.replaying-${stamp}-99`, eventLine(`old-${i}`));
    }
    // One live event, padded past the size bound so the rotation triggers.
    fs.writeFileSync(spool, eventLine('live'.padEnd(2048, 'y')));

    // Cap of 3 with 3 leftovers plus the one we are about to rotate in: one must go.
    assert.equal(rotateSpool(spool, 1024, 3), 1, 'the oldest segment went, one event with it');
    assert.equal(segments(spool).length, 3, 'and the namespace converges on the cap');
    assert.equal(spoolDropped(spool), 1, 'the tally lands where doctor reads it');
    // old-1, old-2 and the freshly rotated live event: the tally line is not one of them.
    assert.equal(spoolBacklog(spool).lines, 3, 'the tally is not counted as an event');
    t.cleanup();
  });

  it('replays segments oldest first and carries the drop count out of the file', () => {
    const { t, spool } = spoolEnv();
    fs.writeFileSync(`${spool}.replaying-00000000001000-999`, `${SPOOL_DROP_MARK}7\n${eventLine('first')}`);
    fs.writeFileSync(`${spool}.replaying-00000000002000-1000`, eventLine('second'));
    fs.writeFileSync(spool, eventLine('live'));

    const seen: string[] = [];
    const r = replaySpool(spool, (msg) => seen.push((msg.hook as { session_id: string }).session_id));
    assert.deepEqual(seen, ['first', 'second', 'live'], 'across segments, oldest first');
    assert.equal(r.events, 3);
    assert.equal(r.dropped, 7, 'the marker is read out before its file is unlinked');
    assert.equal(segments(spool).length, 0, 'every claimed segment is gone');
    t.cleanup();
  });
});

describe('snapshot round-trip (I8)', () => {
  it('restores sessions and observations', () => {
    const model = reduce(emptyModel(), {
      ts: 1000,
      sessionId: 's1',
      event: 'SessionStart',
      source: 'startup',
      cwd: '/repos/x',
      meta: { ppid: 99, transcriptPath: '/t.jsonl', terminal: { kind: 'tmux', tmuxPane: '%1' } },
    });
    const text = serialize(model, { subagentEvents: true, envKeys: ['TMUX_PANE'] }, '0.1.0', 5000);
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    fs.writeFileSync(file, text);
    const back = loadSnapshot(file);
    assert.ok(back);
    assert.equal(back.model.sessions.s1?.ppid, 99);
    assert.equal(back.model.sessions.s1?.terminal.tmuxPane, '%1');
    assert.equal(back.observed.subagentEvents, true);
    assert.deepEqual(back.observed.envKeys, ['TMUX_PANE']);
    t.cleanup();
  });

  it('gives a collided slot to the oldest session', () => {
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    let model = emptyModel();
    for (const [i, id] of ['old', 'new'].entries()) {
      model = reduce(model, {
        ts: 1000 * (i + 1),
        sessionId: id,
        event: 'SessionStart',
        source: 'startup',
        cwd: '/r',
      } as NormalizedEvent);
    }
    // Hand-edited into a collision, with the younger session listed first.
    const raw = JSON.parse(serialize(model, { subagentEvents: false, envKeys: [] }, '0.1.0', 5000)) as {
      sessions: { sessionId: string; slot: number; sessionStart: number }[];
    };
    for (const x of raw.sessions) x.slot = 2;
    raw.sessions.sort((a, b) => b.sessionStart - a.sessionStart);
    fs.writeFileSync(file, JSON.stringify(raw));

    const back = loadSnapshot(file);
    assert.equal(back?.model.sessions.old?.slot, 2, 'the session that held it longest keeps it');
    assert.equal(back?.model.sessions.new?.slot, 1, 'the newcomer takes the next free number');
    t.cleanup();
  });

  it('does not trust a recorded ppid from a snapshot old enough to have been recycled', () => {
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    let model = reduce(emptyModel(), {
      ts: 1000,
      sessionId: 'ghost',
      event: 'SessionStart',
      source: 'startup',
      cwd: '/r',
      meta: { ppid: process.pid },
    } as NormalizedEvent);
    model = reduce(model, { ts: 2000, sessionId: 'ghost', event: 'Stop' } as NormalizedEvent);

    // Written long enough ago that the pid may belong to something else entirely.
    const old = Date.now() - PPID_TRUST_MS - 1;
    fs.writeFileSync(file, serialize(model, { subagentEvents: false, envKeys: [] }, '0.1.0', old));
    const stale = loadSnapshot(file);
    assert.ok(stale);
    assert.equal(markStaleCandidates(stale.model, true).sessions.ghost?.ppid, 0, 'the pid is not evidence');

    // A fresh snapshot keeps it: a daemon restart must not orphan live sessions.
    fs.writeFileSync(file, serialize(model, { subagentEvents: false, envKeys: [] }, '0.1.0', Date.now()));
    const fresh = loadSnapshot(file);
    assert.equal(markStaleCandidates(fresh?.model ?? emptyModel(), false).sessions.ghost?.ppid, process.pid);
    t.cleanup();
  });

  it('survives a snapshot with no displayState, and starts clean on an unknown version', () => {
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    const model = reduce(emptyModel(), {
      ts: 1000,
      sessionId: 'd1',
      event: 'Notification',
      notif: 'permission_prompt',
      message: 'need it',
    } as NormalizedEvent);
    const raw = JSON.parse(serialize(model, { subagentEvents: false, envKeys: [] }, '0.1.0', Date.now())) as {
      v: number;
      sessions: Record<string, unknown>[];
    };
    delete raw.sessions[0]?.displayState;
    fs.writeFileSync(file, JSON.stringify(raw));
    const back = loadSnapshot(file);
    assert.equal(back?.model.sessions.d1?.displayState, 'permission_wait', 'derived, not crashed on');

    raw.v = 99;
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(loadSnapshot(file), undefined, 'a protocol we do not know starts clean');
    t.cleanup();
  });

  it('carries slots through the snapshot round trip, and repairs one written without them', () => {
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    let model = emptyModel();
    for (const [i, id] of ['a', 'b'].entries()) {
      model = reduce(model, {
        ts: 1000 * (i + 1),
        sessionId: id,
        event: 'SessionStart',
        source: 'startup',
        cwd: '/r',
      } as NormalizedEvent);
    }
    fs.writeFileSync(file, serialize(model, { subagentEvents: false, envKeys: [] }, '0.1.0', 5000));
    const back = loadSnapshot(file);
    assert.equal(back?.model.sessions.a?.slot, 1, 'the number survives a restart');
    assert.equal(back?.model.sessions.b?.slot, 2);

    // A snapshot from before slots existed, or one hand-edited into a collision.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] };
    delete raw.sessions[0]?.slot;
    raw.sessions[1] = { ...raw.sessions[1], slot: 0 };
    fs.writeFileSync(file, JSON.stringify(raw));
    const repaired = loadSnapshot(file);
    const slots = Object.values(repaired?.model.sessions ?? {})
      .map((x) => x.slot)
      .sort();
    assert.deepEqual(slots, [1, 2], 'every session comes back with a distinct usable number');
    t.cleanup();
  });

  it('survives a truncated or hand-edited snapshot', () => {
    const t = tempEnv();
    const file = join(t.dir, 'state.json');
    fs.writeFileSync(file, '{"v":1,"sessions":[{"sessionId":"bad"}]}');
    const back = loadSnapshot(file);
    assert.ok(back);
    assert.deepEqual(back.model.sessions.bad?.subagents, { active: 0, running: [], anonymous: 0, blocked: [] });
    fs.writeFileSync(file, 'not json');
    assert.equal(loadSnapshot(file), undefined);
    t.cleanup();
  });
});

describe('daemon process', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  /** Stamps a redelivery id onto an encoded wire line, the way the forwarder does. */
  const withEid = (line: string, eid: string): string =>
    `${JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), eid })}\n`;

  it('serves get_state, keeps modes at 0600/0700 and writes daemon.json', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700, 'I5 dir');
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600, 'I5 socket');

    const info = JSON.parse(fs.readFileSync(join(t.dir, 'daemon.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(typeof info.pid, 'number');
    assert.equal(info.version, VERSION);

    const state = await getStateRaw(sock);
    assert.equal(state?.kind, 'state');
    assert.deepEqual(state?.sessions, []);
    d.kill('SIGTERM');
  });

  it('applies events, derives displayState and answers subscribers', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    // A subscriber sees the full state on every change (no deltas).
    const updates: number[] = [];
    const sub = net.connect(sock);
    sub.setEncoding('utf8');
    let buf = '';
    sub.on('data', (chunk: string) => {
      buf += chunk;
      const { lines, rest } = splitLines(buf);
      buf = rest;
      for (const line of lines) {
        const msg = JSON.parse(line) as { kind: string; sessions: unknown[] };
        if (msg.kind === 'state') updates.push(msg.sessions.length);
      }
    });
    await new Promise((r) => sub.on('connect', r));
    sub.write(`${JSON.stringify({ v: 1, kind: 'subscribe' })}\n`);
    assert.ok(await waitFor(() => updates.length >= 1), 'immediate state on subscribe');

    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'a', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'PreToolUse', sessionId: 'a', toolName: 'Bash' }),
      wireEvent({ event: 'Notification', notif: 'permission_prompt', sessionId: 'a', message: 'need it' }),
    ]);

    assert.ok(
      await waitFor(async () => (await sessions(sock))[0]?.displayState === 'permission_wait'),
      'state advanced to permission_wait',
    );
    const list = await sessions(sock);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.currentTool, 'Bash');
    assert.equal(list[0]?.deadSince, undefined, 'internal fields never reach the wire');
    assert.equal(list[0]?.staleCandidate, undefined, 'internal fields never reach the wire');
    assert.ok(await waitFor(() => updates.length >= 4), `subscriber saw ${updates.length} states`);
    sub.destroy();
    d.kill('SIGTERM');
  });

  it('rebroadcasts a highlight to subscribers (M2 awareness fallback)', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    const seen: Record<string, unknown>[] = [];
    const sub = net.connect(sock);
    sub.setEncoding('utf8');
    let buf = '';
    sub.on('data', (chunk: string) => {
      buf += chunk;
      const { lines, rest } = splitLines(buf);
      buf = rest;
      for (const line of lines) seen.push(JSON.parse(line) as Record<string, unknown>);
    });
    await new Promise((r) => sub.on('connect', r));
    sub.write(`${JSON.stringify({ v: 1, kind: 'subscribe' })}\n`);
    assert.ok(await waitFor(() => seen.length >= 1));

    await sendLines(sock, [`${JSON.stringify({ v: 1, kind: 'highlight', sessionId: 'abc' })}\n`]);
    assert.ok(await waitFor(() => seen.some((m) => m.kind === 'highlight')), 'highlight reached the subscriber');
    const msg = seen.find((m) => m.kind === 'highlight');
    assert.equal(msg?.sessionId, 'abc');
    assert.equal(msg?.ms, 5000, 'default duration filled in');
    assert.equal(msg?.v, 1);

    sub.destroy();
    d.kill('SIGTERM');
  });

  it('ignores malformed lines, unknown kinds and unknown events without dying (I11)', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    await sendLines(sock, [
      'not json at all\n',
      '[]\n',
      '{"v":1,"kind":"nonsense"}\n',
      '{"v":1,"kind":"event","hook":{}}\n',
      `${JSON.stringify({ v: 1, kind: 'event', ts: 1, tag: { event: 'Nope' }, hook: { session_id: 'z' }, env: {}, ppid: 1 })}\n`,
      wireEvent({ event: 'SessionStart', sessionId: 'ok', source: 'startup', cwd: t.dir }),
    ]);

    assert.ok(await waitFor(async () => (await sessions(sock)).length === 1), 'only the valid event landed');
    const list = await sessions(sock);
    assert.equal(list[0]?.sessionId, 'ok');
    assert.equal(await socketUp(sock), true, 'daemon still serving');
    d.kill('SIGTERM');
  });

  it('survives hostile input of every shape (QUALITY A4)', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    const deep = (n: number): string => `{"v":1,"kind":"event","hook":${'['.repeat(n)}${']'.repeat(n)}}`;
    const hostile = [
      `${'A'.repeat(2 * 1024 * 1024)}\n`, // oversized line
      `${Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f]).toString('binary')}\n`, // binary junk
      `${deep(2000)}\n`, // deep nesting
      '{"v":1,"kind":"event","ts":"not-a-number","tag":null,"hook":{"session_id":42},"env":7,"ppid":"x"}\n',
      '{"v":1,"kind":"event","tag":{"event":"Stop"},"hook":{"session_id":"","hook_event_name":"Stop"}}\n',
      '{"v":999,"kind":"subscribe"}\n',
      '[]\n',
      'null\n',
      '\n\n\n',
    ];
    for (const line of hostile) await sendLines(sock, [line]);

    // Duplicate session ids arriving twice must be one session, not two.
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'dup', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'SessionStart', sessionId: 'dup', source: 'startup', cwd: t.dir }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 1), 'only the valid session exists');
    assert.equal(await socketUp(sock), true, 'daemon still serving after all of that');
    assert.equal(d.exitCode, null, 'daemon still alive');
    d.kill('SIGTERM');
  });

  it('recovers from SIGKILL with no lost attention event (QUALITY A5)', async () => {
    const t = tempEnv({ CCTAP_SNAPSHOT_DEBOUNCE_MS: '50' });
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    const d = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)));

    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'k1', source: 'startup', cwd: t.dir, ppid: process.pid }),
      wireEvent({ event: 'PreToolUse', sessionId: 'k1', toolName: 'Bash', ppid: process.pid }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 1));
    await new Promise((r) => setTimeout(r, 150)); // let the snapshot land

    // Hard kill: no shutdown flush, no socket cleanup.
    d.kill('SIGKILL');
    await new Promise((r) => d.on('close', r));

    // A permission prompt arrives while nothing is listening: the forwarder spools it.
    const forwarder = join(distDir(), 'hook-forward.mjs');
    fs.mkdirSync(join(t.dir, 'bin'), { recursive: true });
    const r = await runNode(forwarder, ['--event=Notification', '--notif=permission_prompt'], {
      env: t.env,
      input: JSON.stringify({
        session_id: 'k1',
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      }),
    });
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(join(t.dir, 'spool', 'events.ndjson')), 'the attention event is spooled, not lost');

    const d2 = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)), 'a fresh daemon takes over the stale socket');
    assert.ok(
      await waitFor(async () => (await sessions(sock))[0]?.displayState === 'permission_wait'),
      'the spooled prompt survived the crash and the restart',
    );
    const restored = (await sessions(sock))[0];
    assert.equal(restored?.currentTool, 'Bash', 'pre-crash state came back from the snapshot');
    d2.kill('SIGTERM');
  });

  /**
   * CCTAP_NO_EXEC has to be true, not aspirational. resolve.ts used to call execFile
   * directly, so the daemon ran git twice and ps once per session with the flag set.
   */
  it('spawns absolutely nothing under CCTAP_NO_EXEC, git and ps included', async () => {
    const t = tempEnv();
    envs.push(t);
    // Shims that leave a trace if anything ever runs them, ahead of the real binaries.
    const binDir = join(t.dir, 'shims');
    const marker = join(t.dir, 'spawned.log');
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of ['git', 'ps']) {
      const shim = join(binDir, name);
      fs.writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(marker)}\nexit 0\n`);
      fs.chmodSync(shim, 0o755);
    }
    // The controlled PATH from tempEnv, with the shims in front. Splicing the host's
    // PATH in here would let whatever the developer has installed change the result.
    const env = { ...t.env, PATH: `${binDir}:${t.env.PATH ?? ''}` };

    const d = startDaemon(env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    // A burst that would normally resolve a branch and a tty for two sessions.
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'n1', source: 'startup', cwd: t.dir, ppid: process.pid }),
      wireEvent({ event: 'SessionStart', sessionId: 'n2', source: 'startup', cwd: t.dir, ppid: process.pid }),
      wireEvent({ event: 'CwdChanged', sessionId: 'n1', cwd: t.dir }),
      wireEvent({ event: 'PreToolUse', sessionId: 'n2', toolName: 'Bash' }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 2), 'the daemon processed the burst');
    await new Promise((r) => setTimeout(r, ms(300)));

    assert.equal(
      fs.existsSync(marker),
      false,
      `nothing was spawned; shim log says: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`,
    );
    // And the session still labels itself from the directory, without a branch.
    const list = await sessions(sock);
    assert.equal(list[0]?.branch, '', 'no branch, because asking for one costs a spawn');
    assert.ok((list[0]?.project ?? '') !== '', 'the project label still comes from the cwd');
    d.kill('SIGTERM');
  });

  it('resolves project and branch from a real git repo', async () => {
    const t = tempEnv();
    envs.push(t);
    const repo = join(t.dir, 'work', 'myproj');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[]): Promise<void> =>
      new Promise((res, rej) => {
        const c = spawn('git', args, { cwd: repo, stdio: 'ignore' });
        c.on('close', (code) => (code === 0 ? res() : rej(new Error(`git ${args.join(' ')} failed`))));
        c.on('error', rej);
      });
    await git(['init', '-q', '-b', 'feature-x']);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);

    // Resolution IS a spawn, so this is the one daemon that may make them. Banners stay
    // off. Before resolve.ts went through the seam, this passed with NO_EXEC still set,
    // which is exactly the bug: the flag promised silence and git ran anyway.
    const env = { ...t.env };
    delete env.CCTAP_NO_EXEC;
    const d = startDaemon(env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [wireEvent({ event: 'SessionStart', sessionId: 'g', source: 'startup', cwd: repo })]);

    assert.ok(
      await waitFor(async () => (await sessions(sock))[0]?.branch === 'feature-x'),
      'branch resolved from git',
    );
    assert.equal((await sessions(sock))[0]?.project, 'myproj');
    d.kill('SIGTERM');
  });

  it('replays the spool in order on start, then truncates it', async () => {
    const t = tempEnv();
    envs.push(t);
    fs.mkdirSync(join(t.dir, 'spool'), { recursive: true });
    const spool = join(t.dir, 'spool', 'events.ndjson');
    fs.writeFileSync(
      spool,
      [
        wireEvent({ event: 'SessionStart', sessionId: 'r1', source: 'startup', cwd: t.dir, ts: 1000 }),
        wireEvent({ event: 'PreToolUse', sessionId: 'r1', toolName: 'Bash', ts: 2000 }),
        'garbage line\n',
        wireEvent({ event: 'Notification', notif: 'permission_prompt', sessionId: 'r1', message: 'm', ts: 3000 }),
        wireEvent({ event: 'Stop', sessionId: 'r2', ts: 4000 }),
      ].join(''),
    );

    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    const list = await sessions(sock);
    const r1 = list.find((s) => s.sessionId === 'r1');
    const r2 = list.find((s) => s.sessionId === 'r2');
    assert.equal(r1?.displayState, 'permission_wait', 'last spooled state wins, so order held');
    assert.equal(r1?.currentTool, 'Bash');
    assert.equal(r2?.displayState, 'your_turn');
    assert.equal(fs.existsSync(spool), false, 'spool consumed');
    d.kill('SIGTERM');
  });

  it('folds a forced branch refresh into every session in that directory', async () => {
    const t = tempEnv();
    envs.push(t);
    const repo = join(t.dir, 'work', 'shared');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[]): Promise<void> =>
      new Promise((res, rej) => {
        const c = spawn('git', args, { cwd: repo, stdio: 'ignore' });
        c.on('close', (code) => (code === 0 ? res() : rej(new Error(`git ${args.join(' ')} failed`))));
        c.on('error', rej);
      });
    await git(['init', '-q', '-b', 'first']);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);

    const env = { ...t.env };
    delete env.CCTAP_NO_EXEC;
    const d = startDaemon(env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'p1', source: 'startup', cwd: repo }),
      wireEvent({ event: 'SessionStart', sessionId: 'p2', source: 'startup', cwd: repo }),
    ]);
    assert.ok(
      await waitFor(async () => (await sessions(sock)).every((x) => x.branch === 'first')),
      'both sessions see the first branch',
    );

    // A branch switch, announced by one session. The other must not sit on a stale
    // branch for a TTL just because the first one refreshed the cache.
    await git(['checkout', '-q', '-b', 'second']);
    await sendLines(sock, [wireEvent({ event: 'CwdChanged', sessionId: 'p1', cwd: repo })]);
    assert.ok(
      await waitFor(async () => {
        const list = await sessions(sock);
        return list.length === 2 && list.every((x) => x.branch === 'second');
      }),
      'both sessions moved to the new branch',
    );
    d.kill('SIGTERM');
  });

  it('removes a session whose parent process is gone', async () => {
    const t = tempEnv({
      CCTAP_SWEEP_INTERVAL_MS: '150',
      CCTAP_LIVENESS_GRACE_MS: '200',
    });
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'v', source: 'startup', cwd: t.dir, ppid: victim.pid }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 1), 'session registered');

    victim.kill('SIGKILL');
    await new Promise((r) => victim.on('close', r));
    assert.ok(
      await waitFor(async () => (await sessions(sock)).length === 0, 5000),
      'session removed after the grace period',
    );
    d.kill('SIGTERM');
  });

  it('removes an ended session once its ttl expires', async () => {
    const t = tempEnv({ CCTAP_SWEEP_INTERVAL_MS: '100', CCTAP_ENDED_TTL_MS: '300' });
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'e', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'SessionEnd', sessionId: 'e', reason: 'exit' }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock))[0]?.displayState === 'ended'));
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 0, 4000), 'ended session faded');
    d.kill('SIGTERM');
  });

  it('keeps exactly one daemon per socket path (I9)', async () => {
    const t = tempEnv();
    envs.push(t);
    const a = spawn(process.execPath, [DAEMON], { env: t.env, stdio: 'ignore' });
    const b = spawn(process.execPath, [DAEMON], { env: t.env, stdio: 'ignore' });
    const wait = (c: ReturnType<typeof spawn>): Promise<void> =>
      c.exitCode !== null || c.signalCode !== null
        ? Promise.resolve()
        : new Promise((r) => c.on('close', () => r()));

    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)), 'one of them is serving');
    await new Promise((r) => setTimeout(r, ms(400)));

    const info = JSON.parse(fs.readFileSync(join(t.dir, 'daemon.json'), 'utf8')) as { pid: number };
    assert.ok(info.pid === a.pid || info.pid === b.pid, 'the winner recorded itself');
    const loser = info.pid === a.pid ? b : a;
    const winner = info.pid === a.pid ? a : b;
    // A cold runner needs longer to get the loser all the way to its exit.
    await waitFor(() => loser.exitCode !== null, 3000);
    assert.notEqual(loser.exitCode, null, 'the losing racer exited');
    assert.equal(loser.exitCode, 0, 'and it exited silently with 0');
    assert.equal(winner.exitCode, null, 'the winner is still serving');

    winner.kill('SIGTERM');
    await Promise.all([wait(a), wait(b)]);
  });

  it('breaks a stale lock left by a dead daemon', async () => {
    const t = tempEnv();
    envs.push(t);
    // A pid that cannot be running: write a lock for a process we just reaped.
    const ghost = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => ghost.on('close', r));
    fs.writeFileSync(join(t.dir, 'daemon.lock'), `${ghost.pid}\n`);

    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)), 'daemon started despite the stale lock');
    d.kill('SIGTERM');
  });

  /**
   * The CI failure this suite kept hitting: a lock that exists but has no pid in it yet
   * is a daemon mid-acquire, not garbage. Stealing it put two daemons on one socket, so
   * the "loser" never exited and the file hung waiting for it.
   */
  it('never steals a lock from a daemon that is still writing its pid', async () => {
    const t = tempEnv();
    envs.push(t);
    const lock = join(t.dir, 'daemon.lock');
    const ready = join(t.dir, 'ready');
    const go = join(t.dir, 'go');
    fs.writeFileSync(lock, '');

    // A real second process, as in CI. Its startup happens BEFORE the grace window
    // opens: node can take longer to boot than the grace on a loaded machine, and a
    // test that races an unbounded process start is a test that flakes.
    const owner = spawn(process.execPath, [
      '-e',
      `const fs = require('fs');` +
        `fs.writeFileSync(${JSON.stringify(ready)}, '1');` +
        `const wait = setInterval(() => {` +
        `  if (!fs.existsSync(${JSON.stringify(go)})) return;` +
        `  clearInterval(wait);` +
        `  fs.writeFileSync(${JSON.stringify(lock)}, process.pid + '\\n');` +
        `}, 2);` +
        `setTimeout(() => {}, 8000);`,
    ]);
    try {
      assert.ok(await waitFor(() => fs.existsSync(ready), 8000), 'the other daemon is up');
      fs.writeFileSync(go, '1');
      assert.equal(acquireLock(lock), undefined, 'the owner appeared, so we stand down');
      assert.equal(readLockPid(lock), owner.pid, 'and the lock is theirs, not ours');
    } finally {
      owner.kill('SIGKILL');
      await new Promise((r) => owner.on('close', r));
    }
  });

  it('publishes the lock with its owner already inside it', async () => {
    const t = tempEnv();
    envs.push(t);
    const lock = join(t.dir, 'daemon.lock');
    const held = acquireLock(lock);
    assert.ok(held, 'acquired');
    // There is no window where the file exists without naming its owner.
    assert.equal(readLockPid(lock), process.pid);

    // A different live process holding it means we lose, promptly.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)']);
    fs.writeFileSync(lock, `${other.pid}\n`);
    try {
      const started = Date.now();
      assert.equal(acquireLock(lock), undefined, 'a live foreign owner wins');
      assert.ok(Date.now() - started < 200, 'and we do not sit waiting on a readable lock');
    } finally {
      other.kill('SIGKILL');
      await new Promise((r) => other.on('close', r));
    }
  });

  it('breaks a lock nobody is coming back for, and only that one', () => {
    const t = tempEnv();
    envs.push(t);
    const lock = join(t.dir, 'daemon.lock');
    fs.writeFileSync(lock, '');
    // Waiting it out is bounded: an orphan left by a hard kill must not block forever.
    const started = Date.now();
    const got = acquireLock(lock);
    const waited = Date.now() - started;
    assert.ok(got, `an orphaned empty lock is eventually broken (${waited}ms)`);
    assert.ok(waited >= UNREADABLE_GRACE_MS, `it waits the grace out first, waited ${waited}ms`);
    assert.equal(readLockPid(lock), process.pid);
    got?.release();
  });

  it('never deletes a lock it does not own', () => {
    const t = tempEnv();
    envs.push(t);
    const lock = join(t.dir, 'daemon.lock');
    const mine = acquireLock(lock);
    assert.ok(mine);
    // Someone else took over in the meantime, however that happened.
    fs.writeFileSync(lock, `${process.pid + 1}\n`);
    mine?.release();
    assert.equal(fs.existsSync(lock), true, 'the other owner keeps their lock');
    assert.equal(readLockPid(lock), process.pid + 1);
  });

  it('takes over a socket file whose daemon was killed, without hesitating', async () => {
    const t = tempEnv();
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    const first = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)), 'the first daemon is serving');
    // SIGKILL leaves both the socket file and the lock behind.
    first.kill('SIGKILL');
    await new Promise((r) => first.on('close', r));
    assert.equal(fs.existsSync(sock), true, 'the stale socket file is still there');

    const second = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)), 'the next daemon cleans up and serves');
    second.kill('SIGTERM');
    await new Promise((r) => second.on('close', r));
  });

  it('never unlinks a socket another daemon is still serving', async () => {
    const t = tempEnv();
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    const serving = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)), 'the first daemon is serving');

    // Reproduce the aftermath of the old lock race: the lock is gone, so a second
    // daemon acquires it and finds the address in use by a live server.
    fs.rmSync(join(t.dir, 'daemon.lock'), { force: true });
    const intruder = startDaemon(t.env);
    await waitFor(() => intruder.exitCode !== null, 5000);
    assert.equal(intruder.exitCode, 0, 'the intruder stands down quietly');
    assert.equal(fs.existsSync(sock), true, 'and leaves the socket file alone');
    assert.ok(await socketUp(sock), 'the original daemon is still answering on it');

    serving.kill('SIGTERM');
    await new Promise((r) => serving.on('close', r));
  });

  it('re-binds when its socket file is deleted under it', async () => {
    const t = tempEnv({ CCTAP_SWEEP_INTERVAL_MS: '150' });
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    // Someone deletes the socket. The daemon is still listening on an inode nobody can
    // reach: hooks spool, renderers see nothing, and only a manual stop used to cure it.
    fs.unlinkSync(sock);
    assert.ok(await waitFor(() => socketUp(sock), 4000), 'the sweep noticed and bound again');
    await sendLines(sock, [wireEvent({ event: 'SessionStart', sessionId: 'r1', source: 'startup', cwd: t.dir })]);
    assert.ok(await waitFor(async () => (await sessions(sock)).length === 1), 'and it serves state again');
    d.kill('SIGTERM');
  });

  it('a stale process does not take a live daemon\'s socket away on its way out', async () => {
    const t = tempEnv();
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    const serving = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)));

    // A second daemon that takes the lock (removed here) but never binds must leave the
    // socket alone when it stops: only the process that is serving may unlink the path.
    fs.rmSync(join(t.dir, 'daemon.lock'), { force: true });
    const intruder = startDaemon(t.env);
    await waitFor(() => intruder.exitCode !== null, 5000);
    assert.equal(intruder.exitCode, 0);
    assert.ok(await socketUp(sock), 'the original socket still answers');
    serving.kill('SIGTERM');
    await new Promise((r) => serving.on('close', r));
  });

  it('flushes state.json on shutdown and reloads it on the next start', async () => {
    const t = tempEnv({ CCTAP_SNAPSHOT_DEBOUNCE_MS: '50' });
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'p', source: 'startup', cwd: t.dir, ppid: process.pid }),
      wireEvent({ event: 'Stop', sessionId: 'p', ppid: process.pid }),
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock))[0]?.displayState === 'your_turn'));
    d.kill('SIGTERM');
    await new Promise((r) => d.on('close', r));

    const state = join(t.dir, 'state.json');
    assert.ok(fs.existsSync(state), 'snapshot flushed on shutdown');
    assert.equal(fs.statSync(state).mode & 0o777, 0o600, 'I5 on state.json');

    const d2 = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)));
    const list = await sessions(sock);
    assert.equal(list.length, 1, 'session restored');
    assert.equal(list[0]?.displayState, 'your_turn');
    d2.kill('SIGTERM');
  });

  it('drops a redelivered event, so one subagent start counts once (I17)', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    // The redelivery the forwarder can genuinely produce: the socket write is accepted
    // but its flush callback misses the deadline, so the same bytes are also spooled and
    // replayed. Anonymous subagent events are counters, so a duplicate inflates the tree.
    const dup = withEid(wireEvent({ event: 'SubagentStart', sessionId: 'e1' }), 'fixed-id-1');
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'e1', source: 'startup', cwd: t.dir }),
      dup,
      dup,
    ]);
    assert.ok(await waitFor(async () => (await sessions(sock))[0]?.subagents.active === 1));

    // A second, genuinely different event still counts: dedupe is per id, not per shape.
    await sendLines(sock, [withEid(wireEvent({ event: 'SubagentStart', sessionId: 'e1' }), 'fixed-id-2')]);
    assert.ok(await waitFor(async () => (await sessions(sock))[0]?.subagents.active === 2));

    const raw = await getStateRaw(sock);
    assert.equal(JSON.stringify(raw).includes('fixed-id-'), false, 'the id is never published');
    d.kill('SIGTERM');
  });

  it('a daemon that stands down leaves the spool for the one that is serving', async () => {
    const t = tempEnv();
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    const serving = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(sock)));

    // Spool an event by hand, then start a loser. Replaying before knowing whether we
    // are the one serving meant the loser consumed and deleted events on its way out,
    // and they never reached the daemon that was going to serve them.
    const spool = join(t.dir, 'spool', 'events.ndjson');
    fs.mkdirSync(join(t.dir, 'spool'), { recursive: true });
    fs.writeFileSync(spool, wireEvent({ event: 'SessionStart', sessionId: 'orphan', source: 'startup', cwd: t.dir }));

    fs.rmSync(join(t.dir, 'daemon.lock'), { force: true });
    const loser = startDaemon(t.env);
    await waitFor(() => loser.exitCode !== null, 5000);
    assert.equal(loser.exitCode, 0, 'it stood down');
    assert.ok(fs.existsSync(spool), 'and left the spool untouched');

    serving.kill('SIGTERM');
    await new Promise((r) => serving.on('close', r));
  });

  it('refuses to remove a non-socket sitting at the socket path', async () => {
    const t = tempEnv();
    envs.push(t);
    const sock = join(t.dir, 'cctap.sock');
    // The socket path is configurable, so it can point at anything. A regular file there
    // is a configuration conflict; deleting it would be data loss by a background process.
    fs.writeFileSync(sock, 'a real file someone cares about\n');
    const d = startDaemon(t.env);
    await waitFor(() => d.exitCode !== null, 5000);
    assert.notEqual(d.exitCode, 0, 'it failed loudly instead of deleting');
    assert.equal(fs.readFileSync(sock, 'utf8'), 'a real file someone cares about\n', 'the file survived');
  });

  it('a daemon that never bound removes neither the socket nor daemon.json', () => {
    const t = tempEnv();
    envs.push(t);
    const p = paths(t.env);
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(p.daemonInfo, '{"pid":1}\n');
    fs.writeFileSync(p.sock, 'not really a socket\n');

    // Never started, so it is serving nothing. Both files belong to whoever is.
    new Daemon(p, configFromEnv(t.env)).stop(0, false);
    assert.ok(fs.existsSync(p.daemonInfo), 'the info file of the daemon that is serving');
    assert.ok(fs.existsSync(p.sock), 'and the socket path it answers on');
  });

  it('keeps retrying the socket heal after a rebind fails', async () => {
    const t = tempEnv({ CCTAP_SWEEP_INTERVAL_MS: '150' });
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    // Delete the socket and block the path with a directory, so the rebind fails. Before,
    // `served` went false first and the guard `if (!served) return` meant the retry its
    // own comment promised could never run: a live, lock-holding daemon permanently
    // unreachable. Retried because the sweep may rebind between the two calls.
    assert.ok(
      await waitFor(() => {
        try {
          fs.rmSync(sock, { force: true });
          fs.mkdirSync(sock);
          return true;
        } catch {
          return false;
        }
      }, 5000),
      'blocked the socket path with a directory',
    );
    await new Promise((r) => setTimeout(r, ms(500)));
    assert.equal(d.exitCode, null, 'still alive, still holding the lock');

    // Clear the obstruction: a daemon that only healed once would stay dark forever.
    fs.rmdirSync(sock);
    assert.ok(await waitFor(() => socketUp(sock), 5000), 'a later sweep bound it after all');
    d.kill('SIGTERM');
  });
});
