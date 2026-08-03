/**
 * CONTRACTS section 5.6: simulate through a real socket with get_state assertions,
 * plus the non-TTY `top` snapshot golden and the jump/doctor surfaces.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pickJumpTarget, findSession, needsAttention } from '../src/core/priority.js';
import { baseLabel, formatDuration, sortSessions, truncateLabel } from '../src/core/labels.js';
import type { WireSession } from '../src/core/types.js';
import { VERSION } from '../src/version.js';
import { snapshotText } from '../src/commands/top.js';
import { adapterFor, detectLocalAdapter } from '../src/terminal/adapter.js';
import { resolveTheme } from '../src/render/theme.js';
import { connect, subscribePersistent } from '../src/client.js';
import { cctapDir, paths, socketPathError, SUN_PATH_MAX, writeFileAtomic } from '../src/paths.js';
import {
  distDir,
  getStateRaw,
  ms,
  runNode,
  sendLines,
  linkFakeCctap,
  socketUp,
  startDaemon,
  tempEnv,
  visibleText,
  waitFor,
  wireEvent,
} from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const CLI = join(distDir(), 'cctap.mjs');

function session(over: Partial<WireSession> & { sessionId: string }): WireSession {
  return {
    slot: 1,
    project: 'proj',
    branch: 'main',
    cwd: '/repos/proj',
    transcriptPath: '',
    sessionSource: 'startup',
    state: 'working',
    displayState: 'working',
    stateSince: 1000,
    lastEventTs: 1000,
    sessionStart: 1000,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal: { kind: 'unknown' },
    ppid: 0,
    ...over,
  };
}

describe('ordering and labels (D4)', () => {
  it('sorts by project, then branch, then session start', () => {
    const list = [
      session({ sessionId: 'c', project: 'blog', branch: 'draft', sessionStart: 100 }),
      session({ sessionId: 'a', project: 'authsvc', branch: 'oauth', sessionStart: 900 }),
      session({ sessionId: 'b', project: 'authsvc', branch: 'main', sessionStart: 500 }),
      session({ sessionId: 'd', project: 'authsvc', branch: 'main', sessionStart: 200 }),
    ];
    assert.deepEqual(
      sortSessions(list).map((s) => s.sessionId),
      ['d', 'b', 'a', 'c'],
    );
  });

  it('never sorts by recency', () => {
    const older = session({ sessionId: 'old', sessionStart: 100, lastEventTs: 9999 });
    const newer = session({ sessionId: 'new', sessionStart: 200, lastEventTs: 1 });
    assert.deepEqual(
      sortSessions([newer, older]).map((s) => s.sessionId),
      ['old', 'new'],
    );
  });

  it('labels and truncation behave', () => {
    assert.equal(baseLabel({ project: 'authsvc', branch: 'main' }), 'authsvc:main');
    assert.equal(baseLabel({ project: 'authsvc', branch: '' }), 'authsvc');
    assert.equal(truncateLabel('authsvc:oauth', 8), 'authsvc…');
    assert.equal(truncateLabel('short', 20), 'short');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(65_000), '1m05s');
    assert.equal(formatDuration(3_725_000), '1h02m');
  });
});

describe('jump priority', () => {
  it('prefers the oldest permission_wait, then failed, then your_turn', () => {
    const list = [
      session({ sessionId: 'turn', displayState: 'your_turn', stateSince: 10 }),
      session({ sessionId: 'fail', displayState: 'failed', stateSince: 20 }),
      session({ sessionId: 'perm-new', displayState: 'permission_wait', stateSince: 90 }),
      session({ sessionId: 'perm-old', displayState: 'permission_wait', stateSince: 30 }),
    ];
    assert.equal(pickJumpTarget(list)?.sessionId, 'perm-old');
    assert.equal(pickJumpTarget(list.filter((s) => !s.sessionId.startsWith('perm')))?.sessionId, 'fail');
    assert.equal(pickJumpTarget([list[0] as WireSession])?.sessionId, 'turn');
  });

  it('never targets working, compacting or ended', () => {
    const list = [
      session({ sessionId: 'w', displayState: 'working' }),
      session({ sessionId: 'c', displayState: 'compacting' }),
      session({ sessionId: 'e', displayState: 'ended' }),
    ];
    assert.equal(pickJumpTarget(list), undefined);
    assert.equal(list.some(needsAttention), false);
  });

  it('matches an explicit query by id prefix then by label', () => {
    const list = [
      session({ sessionId: 'a3f9', project: 'authsvc', branch: 'main' }),
      session({ sessionId: 'b7e2', project: 'blog', branch: 'draft' }),
    ];
    const label = (s: WireSession): string => baseLabel(s);
    assert.equal(findSession(list, 'b7', label)?.sessionId, 'b7e2');
    assert.equal(findSession(list, 'blog', label)?.sessionId, 'b7e2');
    assert.equal(findSession(list, 'draft', label)?.sessionId, 'b7e2');
    assert.equal(findSession(list, 'nope', label), undefined);
  });
});

describe('terminal adapters', () => {
  it('picks the adapter from the captured terminal and degrades when a handle is missing', () => {
    assert.equal(adapterFor(session({ sessionId: 'x', terminal: { kind: 'tmux', tmuxPane: '%4' } })).kind, 'tmux');
    assert.equal(adapterFor(session({ sessionId: 'x', terminal: { kind: 'tmux' } })).kind, 'fallback');
    assert.equal(
      adapterFor(session({ sessionId: 'x', terminal: { kind: 'apple-terminal', tty: 'ttys003' } })).kind,
      'apple-terminal',
    );
    assert.equal(adapterFor(session({ sessionId: 'x', terminal: { kind: 'unknown' } })).kind, 'fallback');
  });

  it('detects the local adapter from env', () => {
    assert.equal(detectLocalAdapter({ TMUX: '/x', TMUX_PANE: '%1' }).kind, 'tmux');
    assert.equal(detectLocalAdapter({ TERM_PROGRAM: 'vscode' }).kind, 'fallback');
  });
});

describe('top snapshot (golden)', () => {
  const list = [
    session({
      sessionId: 'a1',
      slot: 1,
      project: 'authsvc',
      branch: 'main',
      displayState: 'working',
      currentTool: 'Bash',
      stateSince: 5000,
    }),
    session({
      sessionId: 'a2',
      slot: 2,
      project: 'authsvc',
      branch: 'oauth',
      displayState: 'permission_wait',
      currentTool: 'Bash',
      stateSince: 2000,
      subagents: { active: 2, running: ['x'], anonymous: 1, blocked: ['x'] },
    }),
    session({ sessionId: 'b1', slot: 3, project: 'blog', branch: 'draft', displayState: 'your_turn', stateSince: 0 }),
  ];

  it('renders the unicode table', () => {
    const text = snapshotText(list, 65_000, { CCTAP_THEME: 'unicode' } as NodeJS.ProcessEnv);
    assert.equal(
      text,
      [
        `cctap ${VERSION}  3 sessions`,
        '1  ⠋   authsvc:main   working          1m00s  Bash',
        '2  !!  authsvc:oauth  permission_wait  1m03s  Bash  ×2',
        '3  ▲   blog:draft     your_turn        1m05s',
      ].join('\n'),
    );
  });

  it('renders the ascii fallback for plain terminals', () => {
    const text = snapshotText(list, 65_000, { TERM: 'vt100' } as NodeJS.ProcessEnv);
    assert.match(text, /^1\s+[/\-\\]\s+authsvc:main/m, 'slot, then a rotating-bar frame');
    assert.match(text, /^2\s+!\s+authsvc:oauth/m);
    assert.match(text, /^3\s+\^\s+blog:draft/m);
    assert.equal(resolveTheme({ TERM: 'vt100' } as NodeJS.ProcessEnv).name, 'ascii');
  });

  it('says so when there is nothing to show', () => {
    assert.equal(snapshotText([], 0, {} as NodeJS.ProcessEnv), `cctap ${VERSION}  0 sessions\nno sessions`);
  });
});

describe('cli end to end', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('simulate feeds the daemon and top reads it back', async () => {
    const t = tempEnv();
    envs.push(t);
    // Branch resolution is a git spawn, so this run is allowed to make them.
    const env = { ...t.env };
    delete env.CCTAP_NO_EXEC;
    const sim = await runNode(CLI, ['simulate', 'busy-day', '--speed=60', '--quiet'], { env, timeoutMs: 30000 });
    assert.equal(sim.code, 0, sim.stderr.toString());

    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await socketUp(sock), 'simulate started a daemon');

    const state = await getStateRaw(sock);
    const list = (state?.sessions ?? []) as WireSession[];
    assert.equal(list.length, 3, 'three sessions from busy-day');
    const byId = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    assert.equal(byId.s1?.displayState, 'permission_wait', 'the extended scenario ends on an attention state');
    assert.equal(byId.s2?.displayState, 'working');
    assert.equal(byId.s3?.displayState, 'your_turn');
    assert.equal(byId.s1?.project, 'authsvc');
    assert.equal(byId.s1?.branch, 'main', 'branch resolved from the simulated repo');
    assert.equal(byId.s3?.branch, 'tf');

    const top = await runNode(CLI, ['top'], { env });
    assert.equal(top.code, 0);
    const lines = top.stdout.toString().trim().split('\n');
    assert.match(lines[0] as string, new RegExp(`^cctap ${VERSION.replace(/\./g, '\\.')} {2}3 sessions$`));
    assert.equal(lines.length, 4);
    assert.match(lines[1] as string, /authsvc:main\s+permission_wait/);
    assert.match(lines[2] as string, /blog:draft\s+working/);
    assert.match(lines[3] as string, /infra:tf\s+your_turn/);
    // Neither the slot column nor the two-cell permission glyph may shift the labels.
    const labelStart = lines.slice(1).map((l) => {
      const project = /(authsvc|blog|infra)/.exec(l as string);
      return project?.index ?? -1;
    });
    assert.equal(new Set(labelStart).size, 1, `labels start in one column: ${lines.join('|')}`);
    assert.equal(labelStart.length, 3);
    for (const [i, want] of [[1, '1'], [2, '2'], [3, '3']] as const) {
      assert.match(lines[i] as string, new RegExp(`^${want} `), `row ${i} opens with its slot`);
    }

    const jump = await runNode(CLI, [], { env: t.env });
    assert.equal(jump.code, 0);
    assert.match(jump.stdout.toString(), /^authsvc:main: needs permission \[Write\]/);
    assert.match(jump.stdout.toString(), /no terminal here that cctap can focus/, 'simulated sessions have no real terminal');

    const byName = await runNode(CLI, ['jump', 'infra'], { env: t.env });
    assert.equal(byName.code, 0);
    assert.match(byName.stdout.toString(), /^infra:tf: your turn/);
  });

  it('strip and status read the same daemon', async () => {
    const t = tempEnv();
    envs.push(t);
    // Two distinct projects, so the strip has two groups to pack across rows.
    const alpha = join(t.dir, 'alpha');
    const beta = join(t.dir, 'beta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'a', source: 'startup', cwd: alpha }),
      wireEvent({ event: 'PreToolUse', sessionId: 'a', toolName: 'Bash' }),
      wireEvent({ event: 'Notification', notif: 'permission_prompt', sessionId: 'a', message: 'need it' }),
      wireEvent({ event: 'SessionStart', sessionId: 'b', source: 'startup', cwd: beta }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[]).length === 2));

    const strip = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '100' } });
    assert.equal(strip.code, 0, strip.stderr.toString());
    const line = strip.stdout.toString().trim();
    assert.match(line, /!!/, 'the loud glyph is there');
    assert.equal(line.includes('['), false, 'no ansi when stdout is not a tty');

    const status = await runNode(CLI, ['status'], { env: t.env });
    assert.equal(status.code, 0);
    assert.match(status.stdout.toString(), /^1 working, 1 blocked: /);

    // At 16 columns one row sheds the calm label and keeps the loud one. The jump
    // handle in front of every entry is what moved these widths up by four.
    const narrow = (await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '16' } })).stdout.toString();
    assert.ok(narrow.includes('alpha'), `the waiting session keeps its label: "${narrow.trim()}"`);
    assert.equal(narrow.includes('beta'), false, 'the calm label goes first');
    assert.ok(narrow.includes('!!'));

    // Two rows buy back the label that one row had to drop, in snapshot mode too.
    const two = await runNode(CLI, ['strip', '--rows', '2'], { env: { ...t.env, COLUMNS: '16' } });
    assert.equal(two.code, 0);
    const rows = two.stdout.toString().replace(/\n$/, '').split('\n');
    assert.equal(rows.length, 2, 'two rows on request');
    assert.notEqual(rows.join('\n'), narrow.replace(/\n$/, ''), 'not byte-identical to one row');
    assert.ok(rows.some((l) => l.includes('beta')), 'both labels are back');
    for (const l of rows) assert.ok(l.length <= 16, `"${l}" fits`);

    // A snapshot always owns exactly `rows` lines, even when one would do.
    const wide = await runNode(CLI, ['strip', '--rows', '2'], { env: { ...t.env, COLUMNS: '120' } });
    const wideRows = wide.stdout.toString().replace(/\n$/, '').split('\n');
    assert.equal(wideRows.length, 2, 'the second row is still written');
    assert.equal(wideRows[1], '', 'and it is empty');

    d.kill('SIGTERM');
  });

  it('a jump fallback highlights the session in every attached renderer', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const p = { ...paths(t.env) };
    assert.ok(await waitFor(() => socketUp(p.sock)));
    await sendLines(p.sock, [wireEvent({ event: 'Stop', sessionId: 'hl', cwd: t.dir })]);
    assert.ok(await waitFor(async () => ((await getStateRaw(p.sock))?.sessions as unknown[]).length === 1));

    // Stand in for a running strip: subscribe and watch for the rebroadcast.
    const seen: Record<string, unknown>[] = [];
    const link = subscribePersistent(p, { onState: () => {}, onMessage: (m) => seen.push(m) });
    assert.ok(await waitFor(() => seen.length >= 0));

    // The fallback adapter cannot focus anything, so jump degrades to awareness.
    const jump = await runNode(CLI, ['jump', 'hl'], { env: t.env });
    assert.equal(jump.code, 0);
    assert.match(jump.stdout.toString(), /no terminal here that cctap can focus/);

    assert.ok(await waitFor(() => seen.some((m) => m.kind === 'highlight')), 'renderer got the highlight');
    const msg = seen.find((m) => m.kind === 'highlight');
    assert.equal(msg?.sessionId, 'hl');

    link.close();
    d.kill('SIGTERM');
  });

  it('marks the session whose id Claude Code piped in, and nobody else', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'm1', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'SessionStart', sessionId: 'm2', source: 'startup', cwd: t.dir }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[])?.length === 2));
    const env = { ...t.env, COLUMNS: '120', CCTAP_COLOR: '1' };

    // The real shape Claude Code pipes into a status line command.
    const mine = await runNode(CLI, ['strip'], {
      env,
      input: `${JSON.stringify({ session_id: 'm2', cwd: t.dir, model: { id: 'x', display_name: 'X' } })}\n`,
    });
    assert.equal(mine.code, 0, mine.stderr.toString());
    const marked = mine.stdout.toString();
    assert.equal((marked.match(/;7m|\[7m/g) ?? []).length, 1, `exactly one entry marked: ${JSON.stringify(marked)}`);
    assert.match(marked, /\u001b\[2myou\u001b\[0m/, 'and it says which one');

    // Nothing on stdin is the tmux case: byte-identical to before the feature existed.
    const bare = await runNode(CLI, ['strip'], { env });
    assert.equal(/;7m|\[7m/.test(bare.stdout.toString()), false, 'no stdin, no marker');

    const garbage = await runNode(CLI, ['strip'], { env, input: 'not json at all\n' });
    assert.equal(garbage.code, 0, 'garbage on stdin is not an error');
    assert.equal(/;7m|\[7m/.test(garbage.stdout.toString()), false, 'and changes nothing');

    const unknown = await runNode(CLI, ['strip'], { env, input: '{"session_id":"gone"}' });
    assert.equal(/;7m|\[7m/.test(unknown.stdout.toString()), false, 'an id we do not have marks nobody');
    d.kill('SIGTERM');
  });

  it('the piped strip stays plain, and colours up when asked (the status line case)', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'c1', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'Notification', sessionId: 'c1', notif: 'permission_prompt', message: 'need it' }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[])?.length === 1));

    const plain = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '80' } });
    assert.equal(plain.code, 0, plain.stderr.toString());
    assert.equal(/\[/.test(plain.stdout.toString()), false, 'piped output is plain by default');

    const colored = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '80', CCTAP_COLOR: '1' } });
    assert.equal(colored.code, 0, colored.stderr.toString());
    assert.match(colored.stdout.toString(), /\[91;1m/, 'the loud permission colour survives the pipe');
    assert.equal(
      colored.stdout.toString().replace(/\[[0-9;]*m/g, ''),
      plain.stdout.toString(),
      'same line, only dressed',
    );
    d.kill('SIGTERM');
  });

  it('says the daemon is unreachable rather than pretending the board is empty', async () => {
    const t = tempEnv();
    envs.push(t);
    // No daemon has ever run here, so nothing can distinguish calm from unknown except
    // the socket itself. Every read-only surface has to say which one it is.
    for (const argv of [['strip'], ['status'], ['top']]) {
      const r = await runNode(CLI, argv, { env: t.env });
      assert.equal(r.code, 0, r.stderr.toString());
      assert.match(r.stdout.toString(), /daemon not running, state unknown/, `${argv[0]} is honest`);
      assert.equal(r.stdout.toString().includes('no sessions'), false, `${argv[0]} does not claim calm`);
    }
  });

  it('reports a genuinely empty board differently from a missing daemon', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    assert.ok(await waitFor(() => socketUp(join(t.dir, 'cctap.sock'))));

    const strip = await runNode(CLI, ['strip'], { env: t.env });
    assert.match(strip.stdout.toString(), /^no sessions yet/, 'a live daemon with nothing on it');
    assert.equal(strip.stdout.toString().split('\n').filter(Boolean).length, 1, 'one line at rows 1');

    const two = await runNode(CLI, ['strip', '--rows', '2'], { env: t.env });
    assert.equal(two.stdout.toString().replace(/\n$/, '').split('\n').length, 2, 'two lines at rows 2');

    const status = await runNode(CLI, ['status'], { env: t.env });
    assert.equal(status.stdout.toString(), 'no sessions\n');
    d.kill('SIGTERM');
  });

  it('says so out loud when CCTAP_NO_EXEC suppressed the jump', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'nx', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'Stop', sessionId: 'nx' }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[]).length === 1));

    const r = await runNode(CLI, ['jump', 'nx'], { env: t.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /external commands disabled by CCTAP_NO_EXEC/);

    const on: NodeJS.ProcessEnv = { ...t.env };
    delete on.CCTAP_NO_EXEC;
    const quiet = await runNode(CLI, ['jump', 'nx'], { env: on });
    assert.equal(quiet.stdout.toString().includes('CCTAP_NO_EXEC'), false, 'no noise when the switch is off');
    d.kill('SIGTERM');
  });

  it('prints all clear when nothing needs attention', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['jump'], { env: t.env });
    assert.equal(r.code, 0);
    const out = r.stdout.toString();
    assert.match(out, /^no daemon running\./, 'a missing daemon is not the same fact as an empty board');
    assert.match(out, /run: cctap install-hooks/, 'and points at the install, the way doctor does');
    assert.match(out, /cctap doctor/);

    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [wireEvent({ event: 'SessionStart', sessionId: 'w', source: 'startup', cwd: t.dir })]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[]).length === 1));

    const busy = await runNode(CLI, ['jump'], { env: t.env });
    assert.equal(busy.stdout.toString(), 'all clear\n', 'a working session is not an interruption');
    d.kill('SIGTERM');
  });

  it('top on a daemon-less dir says so instead of printing an empty board', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['top'], { env: t.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /daemon not running, state unknown/);
  });

  it('doctor reports a fresh environment without failing', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['doctor'], {
      env: { ...t.env, CCTAP_CLAUDE_SETTINGS: join(t.dir, 'settings.json') },
    });
    assert.equal(r.code, 0, `a not-yet-installed setup is warnings, not failures:\n${r.stdout.toString()}`);
    const out = r.stdout.toString();
    assert.match(out, /hooks not installed/);
    assert.match(out, /daemon not running/);
    assert.match(out, /0 failures/);
  });

  it('doctor turns green-ish after install and a live daemon', async () => {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: settings };
    assert.equal((await runNode(CLI, ['install-hooks'], { env })).code, 0);

    const d = startDaemon(env);
    assert.ok(await waitFor(() => socketUp(join(t.dir, 'cctap.sock'))));
    await sendLines(join(t.dir, 'cctap.sock'), [
      wireEvent({
        event: 'SubagentStart',
        sessionId: 'sub',
        agentId: 'a1',
        cwd: t.dir,
        env: { TMUX_PANE: '%9', TMUX: '/tmp/x' },
      }),
    ]);
    await waitFor(async () => ((await getStateRaw(join(t.dir, 'cctap.sock')))?.sessions as unknown[]).length === 1);
    // Force the debounced snapshot out so doctor can read the observations.
    d.kill('SIGTERM');
    await new Promise((r) => d.on('close', r));

    const r = await runNode(CLI, ['doctor'], { env });
    const out = r.stdout.toString();
    assert.match(out, /hooks installed \(19\/19\)/);
    assert.match(out, /node path valid/);
    assert.match(out, /subagent-tagged events observed/);
    assert.match(out, /hook env captured: .*TMUX_PANE/);
    assert.equal(r.code, 0, out);
  });

  it('doctor explains the banner state and the Script Editor attribution', async () => {
    const t = tempEnv();
    envs.push(t);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: join(t.dir, 'settings.json') };

    const off = await runNode(CLI, ['doctor'], { env });
    assert.match(off.stdout.toString(), /desktop banners off \(CCTAP_NOTIFY\)/);

    // Banners on takes both: the setting, and an env that is not forcing them off.
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(join(t.dir, 'config.json'), `${JSON.stringify({ notify: { enabled: true } })}\n`);
    const on: NodeJS.ProcessEnv = { ...env };
    delete on.CCTAP_NOTIFY;
    const r = await runNode(CLI, ['doctor'], { env: on });
    assert.match(r.stdout.toString(), /desktop banners on for permission_wait, failed and your_turn/);
    if (process.platform === 'darwin') {
      assert.match(r.stdout.toString(), /Script Editor/, 'the attribution quirk is answered in doctor');
      assert.match(r.stdout.toString(), /Automation consent unknown/);
    }
    assert.equal(r.code, 0);
  });

  it('doctor reads Automation consent from the last jump', async () => {
    const t = tempEnv();
    envs.push(t);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: join(t.dir, 'settings.json') };
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(
      join(t.dir, 'jump.json'),
      JSON.stringify({ at: 1, kind: 'apple-terminal', ok: false, consent: 'denied', detail: 'blocked' }),
    );
    const r = await runNode(CLI, ['doctor'], { env });
    if (process.platform === 'darwin') {
      assert.match(r.stdout.toString(), /Automation consent denied/);
      assert.match(r.stdout.toString(), /Privacy & Security/);
      assert.equal(r.code, 1, 'a denied consent is a failure to fix');
    }

    fs.writeFileSync(
      join(t.dir, 'jump.json'),
      JSON.stringify({ at: 2, kind: 'apple-terminal', ok: true, consent: 'granted', detail: 'selected the tab' }),
    );
    const good = await runNode(CLI, ['doctor'], { env });
    if (process.platform === 'darwin') {
      assert.match(good.stdout.toString(), /Automation consent granted/);
      assert.equal(good.code, 0);
    }
  });

  it('doctor fails loudly when a hook points at a missing forwarder', async () => {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: settings };
    await runNode(CLI, ['install-hooks'], { env });
    fs.rmSync(join(t.dir, 'bin', 'hook-forward.mjs'));

    const r = await runNode(CLI, ['doctor'], { env });
    assert.equal(r.code, 1, 'a broken install is a failure');
    assert.match(r.stdout.toString(), /hook target missing/);
  });

  it('cctap stop stops the daemon and says so', async () => {
    const t = tempEnv();
    envs.push(t);
    const noDaemon = await runNode(CLI, ['stop'], { env: t.env });
    assert.equal(noDaemon.code, 0);
    assert.equal(noDaemon.stdout.toString(), 'no daemon running\n');

    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    const r = await runNode(CLI, ['stop'], { env: t.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^stopped the daemon \(pid \d+\)$/m);
    assert.ok(await waitFor(async () => !(await socketUp(sock))), 'the socket is gone');
    d.kill('SIGKILL');
  });

  it('doctor names registrations that have never fired', async () => {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: settings };
    await runNode(CLI, ['install-hooks'], { env });

    const d = startDaemon(env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [wireEvent({ event: 'SessionStart', sessionId: 'o1', source: 'startup', cwd: t.dir })]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[]).length === 1));
    d.kill('SIGTERM');
    await new Promise((r) => d.on('close', r));

    const r = await runNode(CLI, ['doctor'], { env });
    const out = r.stdout.toString();
    assert.match(out, /never observed:/);
    assert.match(out, /Notification\(permission_prompt\)/, 'a silent registration is named');
    assert.equal(/never observed:[^\n]*SessionStart/.test(out), false, 'the one that fired is not listed');
  });

  it('rejects an unknown scenario', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['simulate', 'nope'], { env: t.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /unknown scenario/);
  });

  it('reports a failure when the daemon dies mid-replay', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));

    // busy-day runs 30 s at speed 1, so the daemon is gone long before the last event.
    const sim = runNode(CLI, ['simulate', 'busy-day', '--quiet'], { env: t.env, timeoutMs: ms(20000) });
    await new Promise((r) => setTimeout(r, ms(600)));
    d.kill('SIGKILL');

    const r = await sim;
    assert.equal(r.code, 1, 'a replay into the void is not a success');
    assert.match(r.stderr.toString(), /the daemon stopped listening after \d+ events/);
  });

  it('bare simulate lists the scenarios instead of starting one', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['simulate'], { env: t.env });
    assert.equal(r.code, 0, r.stderr.toString());
    const out = r.stdout.toString();
    assert.match(out, /scenarios you can replay:/);
    for (const name of ['busy-day', 'elicitation', 'idle-upgrade-only', 'subagent-permission']) {
      assert.match(out, new RegExp(`\\b${name}\\b`), `${name} is listed`);
    }
    assert.match(out, /cctap simulate busy-day/);
    assert.equal(fs.existsSync(join(t.dir, 'cctap.sock')), false, 'listing starts no daemon');
  });

  it('a replay opens by naming the scenario and how to watch it', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['simulate', 'idle-upgrade-only', '--speed=60'], { env: t.env, timeoutMs: 30000 });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /^replaying idle-upgrade-only, watch it with: cctap strip\n/);
  });

  it('cctap notify flips the banner setting and keeps the rest of the config', async () => {
    const t = tempEnv();
    envs.push(t);
    const cfg = join(t.dir, 'config.json');
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(cfg, `${JSON.stringify({ theme: 'ascii', notify: { your_turn: false } }, null, 2)}\n`);
    // The command reads the real setting, so this env must not force it off.
    const env = { ...t.env, CCTAP_NOTIFY: 'on' };

    const before = await runNode(CLI, ['notify'], { env });
    assert.equal(before.code, 0, before.stderr.toString());
    assert.match(before.stdout.toString(), /desktop banners are off/, 'off out of the box');

    const on = await runNode(CLI, ['notify', 'on'], { env });
    assert.equal(on.code, 0, on.stderr.toString());
    assert.match(on.stdout.toString(), /desktop banners on/);
    const written = JSON.parse(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>;
    assert.equal(written.theme, 'ascii', 'foreign keys survive');
    assert.deepEqual(written.notify, { your_turn: false, enabled: true }, 'per-state toggles survive');

    const again = await runNode(CLI, ['notify', 'on'], { env });
    assert.match(again.stdout.toString(), /already on/, 'idempotent');

    const state = await runNode(CLI, ['notify'], { env });
    assert.match(state.stdout.toString(), /desktop banners are on/);

    const off = await runNode(CLI, ['notify', 'off'], { env });
    assert.equal(off.code, 0);
    assert.match(off.stdout.toString(), /desktop banners off/);
    assert.equal(((JSON.parse(fs.readFileSync(cfg, 'utf8')) as { notify: { enabled: boolean } }).notify.enabled), false);

    const bad = await runNode(CLI, ['notify', 'sometimes'], { env });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr.toString(), /takes on or off/);
  });

  it('the env force-off still wins over the setting, and doctor says which', async () => {
    const t = tempEnv();
    envs.push(t);
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(join(t.dir, 'config.json'), `${JSON.stringify({ notify: { enabled: true } })}\n`);

    // The command reports the SETTING and mentions the env separately. Reporting the
    // combined value made `notify off` a silent no-op under an exported CCTAP_NOTIFY=off.
    const r = await runNode(CLI, ['notify'], { env: t.env });
    assert.match(r.stdout.toString(), /desktop banners are on/);
    assert.match(r.stdout.toString(), /CCTAP_NOTIFY is set to off, which wins/);

    const off = await runNode(CLI, ['notify', 'off'], { env: t.env });
    assert.equal(off.code, 0, off.stderr.toString());
    assert.match(off.stdout.toString(), /desktop banners off/, 'the flip is not swallowed');
    assert.equal(
      (JSON.parse(fs.readFileSync(join(t.dir, 'config.json'), 'utf8')) as { notify: { enabled: boolean } }).notify
        .enabled,
      false,
      'and it reached the file',
    );
    const again = await runNode(CLI, ['notify', 'off'], { env: t.env });
    assert.match(again.stdout.toString(), /already off/, 'and now it knows it is off');

    const doc = await runNode(CLI, ['doctor'], { env: t.env });
    assert.match(doc.stdout.toString(), /desktop banners off \(CCTAP_NOTIFY\)/);
  });

  it('refuses to rewrite a config.json it cannot parse', async () => {
    const t = tempEnv();
    envs.push(t);
    fs.mkdirSync(t.dir, { recursive: true });
    const cfg = join(t.dir, 'config.json');
    // The escape hatch someone needed to make cctap work at all lives in this file.
    fs.writeFileSync(cfg, '{ "socket": "/tmp/cc.sock", }\n');
    const before = fs.readFileSync(cfg, 'utf8');

    const r = await runNode(CLI, ['notify', 'on'], { env: { ...t.env, CCTAP_NOTIFY: 'on' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /cannot parse .* as JSON/);
    assert.match(r.stderr.toString(), /Nothing was changed/);
    assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'the file is untouched');
  });

  it('doctor points at the command when banners are simply off', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['doctor'], { env: { ...t.env, CCTAP_NOTIFY: 'on' } });
    assert.match(r.stdout.toString(), /desktop banners off \(the default\)/);
    assert.match(r.stdout.toString(), /cctap notify on/);
  });

  it('jumps by slot, and a miss lists the slots that do exist', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'j1', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'SessionStart', sessionId: 'j2', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'Notification', sessionId: 'j2', notif: 'permission_prompt', message: 'need it' }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[])?.length === 2));
    const slots = Object.fromEntries(
      ((await getStateRaw(sock))?.sessions as WireSession[]).map((x) => [x.sessionId, x.slot]),
    );
    assert.deepEqual(Object.values(slots).sort(), [1, 2], 'the daemon handed out 1 and 2');

    // CCTAP_NO_EXEC means no terminal is focused, but the target resolution is the point.
    const hit = await runNode(CLI, ['jump', String(slots.j2)], { env: t.env });
    assert.equal(hit.code, 0, hit.stderr.toString());
    assert.match(hit.stdout.toString(), /needs permission/, 'slot 2 resolved to the blocked session');

    const bare = await runNode(CLI, [String(slots.j2)], { env: t.env });
    assert.equal(bare.code, 0, bare.stderr.toString());
    assert.equal(bare.stdout.toString(), hit.stdout.toString(), 'a bare number is the same jump');

    const miss = await runNode(CLI, ['jump', '5'], { env: t.env });
    assert.equal(miss.code, 1);
    assert.match(miss.stdout.toString(), /^no session in slot 5/, 'a number is a slot, never a prefix');
    assert.match(miss.stdout.toString(), /^ {2}1 {2}\S+/m, 'and the miss shows the slots that exist');
    d.kill('SIGTERM');
  });

  it('teaches the jump once, on the status line surface, until the first jump lands', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [wireEvent({ event: 'SessionStart', sessionId: 'h1', source: 'startup', cwd: t.dir })]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[])?.length === 1));

    const calm = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '80' } });
    assert.equal(calm.stdout.toString().includes('to jump there'), false, 'nothing needs a human yet');

    await sendLines(sock, [
      wireEvent({ event: 'Notification', sessionId: 'h1', notif: 'permission_prompt', message: 'need it' }),
    ]);
    assert.ok(
      await waitFor(async () => {
        const list = (await getStateRaw(sock))?.sessions as WireSession[];
        return list?.[0]?.displayState === 'permission_wait';
      }),
    );

    // The wording of the invocation is another test's subject; here it is pinned so this
    // one is about the hint. Without a cctap on PATH the honest form is `npx cctap`.
    linkFakeCctap(t);
    const taught = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '80' } });
    assert.match(taught.stdout.toString(), / · cctap 1 jumps there/, 'names the real slot');

    const narrow = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '20' } });
    assert.equal(narrow.stdout.toString().includes('to jump there'), false, 'never at the cost of the strip');

    // A landed jump retires it for good, even though this jump could not focus anything.
    fs.writeFileSync(
      join(t.dir, 'jump.json'),
      `${JSON.stringify({ at: 1, kind: 'tmux', ok: true, consent: 'unknown', detail: 'ok', firstJumpAt: 1 })}\n`,
    );
    const after = await runNode(CLI, ['strip'], { env: { ...t.env, COLUMNS: '80' } });
    assert.equal(after.stdout.toString().includes('to jump there'), false, 'retired permanently');
    d.kill('SIGTERM');
  });

  it('teaches the invocation that works on this machine, npx included', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'i1', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'Notification', sessionId: 'i1', notif: 'permission_prompt', message: 'need it' }),
    ]);
    assert.ok(
      await waitFor(async () => ((await getStateRaw(sock))?.sessions as WireSession[])?.[0]?.slot === 1),
    );

    // The default test PATH carries no cctap, which is the honest state of a machine
    // that has only ever run `npx cctap`. Teaching a bare `cctap` there would hand
    // someone a command-not-found at the exact teachable moment.
    const env = { ...t.env, COLUMNS: '90' };
    const viaNpx = await runNode(CLI, ['strip'], { env });
    assert.match(
      viaNpx.stdout.toString(),
      / · npx @chipmates\/cctap 1 jumps there/,
      'the scoped package is what npx needs, so that is what it teaches',
    );
    const keysNpx = await runNode(CLI, ['keys'], { env });
    assert.match(keysNpx.stdout.toString(), /npx @chipmates\/cctap 2 +slot 2, from any shell/);
    assert.match(keysNpx.stdout.toString(), /not on your PATH/);

    // Put a cctap on PATH and the wording flips to the short form.
    linkFakeCctap(t);
    const viaPath = await runNode(CLI, ['strip'], { env });
    assert.match(viaPath.stdout.toString(), / · cctap 1 jumps there/, 'and the short form when it exists');
    const keysPath = await runNode(CLI, ['keys'], { env });
    assert.equal(keysPath.stdout.toString().includes('npx @chipmates/cctap'), false);
    d.kill('SIGTERM');
  });

  /**
   * The pane is the cross-OS instant path: the number under the glyph is also the key.
   * The mapping is pure and tested exhaustively in the unit suite; a live pane needs a
   * real terminal on stdout, so the end-to-end proof runs where a pty is available.
   */
  describe('digit keys in a live pane', () => {
    /** BSD script needs a terminal on its own stdin, which a test runner never has. */
    const ptyAvailable = process.platform === 'linux';

    /**
     * A pane repaints continuously, so its output is a stream of overlapping frames,
     * wrapped at the terminal width and cut wherever the kill landed. Never assert on a
     * frame: accumulate everything, strip escapes, and wait until the marker shows up
     * anywhere in it (or the deadline passes).
     */
    const inPty = async (
      argv: string[],
      send: string,
      env: NodeJS.ProcessEnv,
      until?: RegExp,
    ): Promise<{ text: string; exited: boolean }> => {
      const inner = [process.execPath, CLI, ...argv].map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(' ');
      return new Promise((resolve) => {
        const child = spawn('script', ['-q', '-c', inner, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let seen = '';
        let settled = false;
        const done = (exited: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(keyTimer);
          clearTimeout(deadline);
          child.kill('SIGKILL');
          // Wrapping puts newlines mid-word, so collapse them for the search.
          resolve({ text: visibleText(seen).replace(/\n+/g, ' '), exited });
        };
        const take = (c: Buffer): void => {
          seen += c.toString('utf8');
          if (until && until.test(visibleText(seen).replace(/\n+/g, ' '))) setTimeout(() => done(false), ms(150));
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        const keyTimer = setTimeout(() => child.stdin.write(send), ms(700));
        const deadline = setTimeout(() => done(false), ms(4000));
        child.on('close', () => done(true));
        child.on('error', () => done(false));
      });
    };

    const board = async (t: ReturnType<typeof tempEnv>): Promise<ReturnType<typeof startDaemon>> => {
      const d = startDaemon(t.env);
      const sock = join(t.dir, 'cctap.sock');
      assert.ok(await waitFor(() => socketUp(sock)));
      await sendLines(sock, [
        wireEvent({ event: 'SessionStart', sessionId: 'k1', source: 'startup', cwd: t.dir }),
        wireEvent({ event: 'Notification', sessionId: 'k1', notif: 'permission_prompt', message: 'need it' }),
      ]);
      assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as WireSession[])?.[0]?.slot === 1));
      return d;
    };

    // Short enough to survive wrapping at any width the runner picks.
    const JUMPED = /needs permission|no terminal here|jumped to/;

    it('a digit in the strip jumps, and the pane keeps rendering after it', { skip: !ptyAvailable }, async () => {
      const t = tempEnv();
      envs.push(t);
      const d = await board(t);
      const r = await inPty(['strip'], '1', { ...t.env, COLUMNS: '100' }, JUMPED);
      assert.match(r.text, JUMPED, `the key reached the jump path: ${JSON.stringify(r.text.slice(-240))}`);
      assert.equal(r.exited, false, 'focus moves to the session, the pane stays');
      d.kill('SIGTERM');
    });

    it('an unknown digit says so and jumps nowhere', { skip: !ptyAvailable }, async () => {
      const t = tempEnv();
      envs.push(t);
      const d = await board(t);
      const r = await inPty(['strip'], '7', { ...t.env, COLUMNS: '100' }, /no session 7/);
      assert.match(r.text, /no session 7/);
      assert.equal(JUMPED.test(r.text), false, 'nothing was attempted');
      d.kill('SIGTERM');
    });

    it('q still leaves the strip', { skip: !ptyAvailable }, async () => {
      const t = tempEnv();
      envs.push(t);
      const d = await board(t);
      const r = await inPty(['strip'], 'q', { ...t.env, COLUMNS: '100' });
      assert.equal(r.exited, true);
      d.kill('SIGTERM');
    });

    it('a digit in top is the same jump as Enter on that row', { skip: !ptyAvailable }, async () => {
      const t = tempEnv();
      envs.push(t);
      const d = await board(t);
      const env = { ...t.env, COLUMNS: '100', LINES: '20' };
      const byDigit = await inPty(['top'], '1', env, JUMPED);
      const byEnter = await inPty(['top'], '\r', env, JUMPED);
      const outcome = (text: string): string => (JUMPED.exec(text) ?? [''])[0];
      assert.notEqual(outcome(byDigit.text), '', JSON.stringify(byDigit.text.slice(-240)));
      assert.equal(outcome(byDigit.text), outcome(byEnter.text), 'same outcome as Enter');
      assert.match(byDigit.text, /1-9 jump/, 'and the footer teaches it');
      d.kill('SIGTERM');
    });
  });

  it('cctap keys leads with the one setup command and follows with quoted absolute recipes', async () => {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings } });

    const r = await runNode(CLI, ['keys'], { env: t.env });
    assert.equal(r.code, 0, r.stderr.toString());
    const out = r.stdout.toString();
    // The key is the instant path, so setup opens the listing and the paste-a-line
    // recipes that spell out what it does follow it.
    const lead = out.indexOf('the instant jump is a system-wide key');
    const recipe = out.indexOf('what that does by hand');
    assert.equal(lead, 0, 'the one command opens the listing');
    assert.ok(recipe > lead, 'the by-hand recipes follow it');
    assert.match(
      out,
      /^the instant jump is a system-wide key, and setup carries it as far as your OS allows:$/m,
    );
    // The invocation is another test's subject, so this one takes whichever form works.
    assert.match(
      out,
      /^ {2}\S.*keys setup {8}macOS to the Shortcuts doorstep, GNOME written for you, tmux bound live$/m,
    );
    // Neither in-session path is instant mid-turn: `!` queues behind the running turn
    // and a prompt token is handed over just as late. Neither is taught.
    assert.equal(out.includes('! cctap'), false, 'the composer path is not offered');
    assert.match(out, /press 2 +in a running cctap strip or cctap top/);
    assert.match(out, /desktop keyboard settings/, 'Linux gets its own line');
    // Single quotes, not double: these lines are pasted into Shortcuts, a GNOME command
    // field and tmux run-shell, and only single quotes leave `$` and a backtick alone.
    assert.ok(
      out.includes(`'${process.execPath}' '${join(t.dir, 'bin', 'cctap.mjs')}' jump 2`),
      'a per-slot line with both paths single-quoted and absolute',
    );
    assert.equal(out.includes(`"${process.execPath}"`), false, 'no double-quoted path anywhere in the listing');
    assert.match(out, /bind-key g run-shell -b /, 'the tmux line survives a server restart');
    // The printed tmux.conf recipe goes through the same quoting as the one setup binds.
    const jumpLine = `'${process.execPath}' '${join(t.dir, 'bin', 'cctap.mjs')}' jump`;
    assert.ok(
      out.includes(`bind-key g run-shell -b "${jumpLine} >/dev/null 2>&1"`),
      `the tmux.conf recipe is quoted for tmux, not hand-rolled: ${out}`,
    );
    assert.match(out, /cctap binds no keys/);
  });

  it('help and version are cheap and quiet', async () => {
    const t = tempEnv();
    envs.push(t);
    const v = await runNode(CLI, ['--version'], { env: t.env });
    assert.equal(v.stdout.toString(), `${VERSION}\n`);
    const h = await runNode(CLI, ['--help'], { env: t.env });
    const help = h.stdout.toString();
    assert.match(help, /cctap jump \[n\|prefix\]/);
    assert.match(help, /cctap <n> {17}jump to the session in slot n/);
    assert.match(help, /^ {2}cctap keys setup \[key\] {4}set up a jump key\. Inside tmux this binds prefix\+key live,$/m);
    assert.match(help, /^ {28}--os skips straight to the OS-wide key instead$/m);
    // The purge guard has an override, and a flag nobody can find is not an override.
    assert.match(help, /^ {28}--purge --force skips the keys-journal check$/m);
    // Every description starts in the same column, and every wrapped line lands under it.
    const described = help.split('\n').filter((l) => /^ {2}\S.* {2,}\S/.test(l));
    assert.ok(described.length > 15, 'the command block was found');
    for (const line of described) {
      assert.match(line, /^.{28}\S/, `description column drifted: ${JSON.stringify(line)}`);
    }
    for (const line of help.split('\n').filter((l) => /^ {3,}\S/.test(l))) {
      assert.match(line, /^ {28}\S/, `continuation column drifted: ${JSON.stringify(line)}`);
    }
    assert.equal(h.code, 0);
  });
});

/**
 * The kernel truncates an over-long sun_path without a word, which made two long
 * CCTAP_DIRs share one socket and one daemon's sessions. Nothing may proceed past it.
 */
describe('the unix socket path limit', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));
  const DAEMON = join(distDir(), 'daemon.mjs');

  /** A CCTAP_DIR whose socket path lands past the platform limit, inside a temp tree. */
  function overlongEnv(suffix = ''): { dir: string; env: NodeJS.ProcessEnv; sock: string } {
    const t = tempEnv();
    envs.push(t);
    const pad = SUN_PATH_MAX + 24 - t.dir.length - '/cctap.sock'.length - suffix.length;
    const dir = join(t.dir, 'd'.repeat(Math.max(pad, 1)) + suffix);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, env: { ...t.env, CCTAP_DIR: dir }, sock: join(dir, 'cctap.sock') };
  }

  it('names the limit and both remedies, and stays quiet under it', () => {
    assert.equal(socketPathError('/tmp/short/cctap.sock'), undefined);
    const long = `/tmp/${'d'.repeat(SUN_PATH_MAX)}/cctap.sock`;
    const msg = socketPathError(long) ?? '';
    assert.match(msg, new RegExp(`${SUN_PATH_MAX} byte limit`), 'the limit is named');
    assert.match(msg, /CCTAP_DIR/, 'remedy one');
    assert.match(msg, /"socket".*config\.json/s, 'remedy two');
  });

  /**
   * The sun_path field is 104 bytes on darwin and 108 on linux, and both counts include
   * the NUL, so the longest usable path is one byte short of the field. Off by one here
   * is the silent truncation this whole guard exists to prevent.
   */
  it('accepts a path exactly at the limit and refuses the next byte', () => {
    assert.equal(SUN_PATH_MAX, process.platform === 'darwin' ? 103 : 107, 'one short of the field');

    const at = `/tmp/${'d'.repeat(SUN_PATH_MAX - 5)}`;
    assert.equal(Buffer.byteLength(at), SUN_PATH_MAX);
    assert.equal(socketPathError(at), undefined, 'exactly at the limit fits, NUL included');
    assert.notEqual(socketPathError(`${at}x`), undefined, 'one byte more does not');

    // Bytes, not characters: a multi-byte path runs out sooner than its length suggests.
    const wide = `/tmp/${'ä'.repeat((SUN_PATH_MAX - 4) / 2)}`;
    assert.equal(Buffer.byteLength(wide) > wide.length, true, 'sanity: multi-byte');
    assert.equal(socketPathError(wide) === undefined, Buffer.byteLength(wide) <= SUN_PATH_MAX);
  });

  it('the daemon refuses to bind it', async () => {
    const o = overlongEnv();
    const r = await runNode(DAEMON, [], { env: o.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /over the \d+ byte limit/);
    assert.equal(fs.existsSync(o.sock), false, 'no socket, truncated or otherwise');
  });

  it('connect rejects it instead of landing on a truncated path', async () => {
    const o = overlongEnv();
    await assert.rejects(() => connect(o.sock, 200), /byte limit this platform puts on unix sockets/);
  });

  it('the cli refuses every command that would touch the socket', async () => {
    const o = overlongEnv();
    for (const cmd of ['status', 'strip', 'jump']) {
      const r = await runNode(CLI, [cmd], { env: o.env });
      assert.equal(r.code, 1, `${cmd} exits 1`);
      assert.match(r.stderr.toString(), /over the \d+ byte limit/, `${cmd} says why`);
      assert.equal(r.stdout.toString(), '', `${cmd} prints no fake answer`);
    }
  });

  it('lets keys through, because it never opens a socket (I14)', async () => {
    const o = overlongEnv();
    // No "socket" override in config.json here: the path really is over the limit, so a
    // gate that covered every command would refuse the one listing that explains the fix.
    assert.equal(fs.existsSync(join(o.dir, 'config.json')), false);

    const listing = await runNode(CLI, ['keys'], { env: o.env });
    assert.equal(listing.code, 0, listing.stderr.toString());
    assert.equal(listing.stderr.toString().includes('byte limit'), false, 'no refusal');
    assert.match(listing.stdout.toString(), /the instant jump is a system-wide key/, 'the listing, not an error');

    const setup = await runNode(CLI, ['keys', 'setup'], { env: o.env });
    assert.equal(setup.stderr.toString().includes('byte limit'), false, 'setup is not gated either');
  });

  it('doctor still runs, and calls it a failure', async () => {
    const o = overlongEnv();
    const r = await runNode(CLI, ['doctor'], { env: o.env });
    assert.equal(r.code, 1, 'a truncating path is a failure, not a warning');
    assert.match(r.stdout.toString(), /socket path too long/);
    assert.match(r.stdout.toString(), /CCTAP_DIR/);
  });

  it('two directories sharing a truncated path both refuse (the collision)', async () => {
    const a = overlongEnv('AAA');
    const b = overlongEnv('BBB');
    assert.equal(
      a.sock.slice(0, SUN_PATH_MAX) === b.sock.slice(0, SUN_PATH_MAX),
      false,
      'sanity: distinct temp roots',
    );
    for (const o of [a, b]) {
      const r = await runNode(CLI, ['status'], { env: o.env });
      assert.equal(r.code, 1);
      assert.equal(fs.existsSync(o.sock), false);
    }
  });

  it('a short socket path in config.json is the way out', async () => {
    const o = overlongEnv();
    const short = join(o.dir.slice(0, 20).replace(/\/$/, ''), 'cc.sock');
    fs.mkdirSync(join(o.dir), { recursive: true });
    fs.writeFileSync(join(o.dir, 'config.json'), `${JSON.stringify({ socket: short })}\n`);
    const r = await runNode(CLI, ['status'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    // It connected, which is the point: a short path is accepted rather than refused.
    assert.match(r.stdout.toString(), /daemon not running, state unknown/, 'the short path is accepted');
    assert.equal(r.stderr.toString().includes('byte limit'), false, 'no refusal');
  });
});

/**
 * CCTAP_DIR names the whole tree, and the purge and the mode repair both walk it. A
 * value that resolves somewhere different in every process, or onto a home directory,
 * is refused rather than interpreted.
 */
describe('what CCTAP_DIR is allowed to be', () => {
  const home = homedir();

  it('takes an absolute path, and expands a leading tilde like the socket path does', () => {
    assert.equal(cctapDir({ CCTAP_DIR: '/tmp/cc-abs' }), '/tmp/cc-abs');
    assert.equal(cctapDir({ CCTAP_DIR: '  /tmp/cc-abs/  ' }), '/tmp/cc-abs', 'trimmed, and no trailing slash');
    assert.equal(cctapDir({ CCTAP_DIR: '~/somewhere' }), join(home, 'somewhere'));
    assert.equal(cctapDir({}), join(home, '.cctap'), 'and the default is unchanged');
    assert.equal(cctapDir({ CCTAP_DIR: '   ' }), join(home, '.cctap'), 'an empty value is no value');
  });

  /**
   * Hooks run with the project's cwd, so a relative value quietly gives every project
   * its own tree and its own daemon, with nothing anywhere saying so.
   */
  it('refuses a relative path instead of resolving it against whoever asked', () => {
    for (const bad of ['cctap', './cctap', '../cctap', 'a/b']) {
      assert.throws(() => cctapDir({ CCTAP_DIR: bad }), /absolute/, bad);
      assert.throws(() => cctapDir({ CCTAP_DIR: bad }), new RegExp(bad.replace(/[.\\]/g, '\\$&')), `${bad} is named`);
    }
  });

  it('refuses a home directory or a filesystem root', () => {
    for (const bad of ['/', '~', home, `${home}/`, '/tmp/..']) {
      assert.throws(() => cctapDir({ CCTAP_DIR: bad }), /directory of its own/, bad);
    }
    assert.doesNotThrow(() => cctapDir({ CCTAP_DIR: join(home, '.cctap') }), 'the default itself is fine');
  });
});

describe('the atomic write leaves nothing behind', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('writes through a temp name and cleans it up when the write fails', () => {
    const dir = tempEnv().dir;
    dirs.push(dir);
    const file = join(dir, 'x.json');
    writeFileAtomic(file, 'one\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    writeFileAtomic(file, 'two\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n', 'a rewrite replaces it');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no temp file survives a write');

    // A write into a directory that does not exist is the ordinary failure shape.
    assert.throws(() => writeFileAtomic(join(dir, 'gone', 'y.json'), 'z'), /ENOENT/);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'and it leaves nothing either');
  });
});

/**
 * The exit codes are a contract, and deliberately not "did the terminal move": tmux
 * run-shell prints a box over the pane on any nonzero exit, and a jump that fell back
 * to awareness has already said so. 1 is reserved for a named target that is not there.
 */
describe('jump exit codes', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('exits 0 when it could not focus, and 1 only when the named target is missing', async () => {
    const t = tempEnv();
    envs.push(t);
    const d = startDaemon(t.env);
    const sock = join(t.dir, 'cctap.sock');
    assert.ok(await waitFor(() => socketUp(sock)));
    await sendLines(sock, [
      wireEvent({ event: 'SessionStart', sessionId: 'x1', source: 'startup', cwd: t.dir }),
      wireEvent({ event: 'Notification', sessionId: 'x1', notif: 'permission_prompt', message: 'need it' }),
    ]);
    assert.ok(await waitFor(async () => ((await getStateRaw(sock))?.sessions as unknown[])?.length === 1));

    // A simulated session has no terminal to raise, so this is the failed-focus path.
    const failed = await runNode(CLI, ['jump'], { env: t.env });
    assert.equal(failed.code, 0, `a delivered fallback is not an error: ${failed.stdout.toString()}`);
    assert.match(failed.stdout.toString(), /no terminal here that cctap can focus/);

    const missing = await runNode(CLI, ['jump', 'nosuchproject'], { env: t.env });
    assert.equal(missing.code, 1, 'a name that matches nothing answers so');
    assert.match(missing.stdout.toString(), /no session matches "nosuchproject"/);

    const deadSlot = await runNode(CLI, ['jump', '9'], { env: t.env });
    assert.equal(deadSlot.code, 1, 'and so does a slot nobody is in');

    const live = await runNode(CLI, ['jump', '1'], { env: t.env });
    assert.equal(live.code, 0, 'a slot that exists is a jump, however it ends');

    const dry = await runNode(CLI, ['jump', '--dry-run'], { env: t.env });
    assert.equal(dry.code, 0, 'and a dry run always answers 0');
    d.kill('SIGTERM');
  });

  it('exits 0 with no daemon at all, because that is a fact and not a failure', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['jump'], { env: t.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^no daemon running\./);
  });
});

describe('doctor prints a paste-ready jump key line', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('quotes both absolute paths once the cli is installed', async () => {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: settings };
    await runNode(CLI, ['install-hooks'], { env });

    const r = await runNode(CLI, ['doctor'], { env });
    const out = r.stdout.toString();
    assert.match(out, /global jump key/);
    assert.ok(
      out.includes(`"${process.execPath}" "${join(t.dir, 'bin', 'cctap.mjs')}" jump`),
      'the exact line, quoted and absolute',
    );
  });

  it('says what to run first when nothing is installed', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['doctor'], { env: t.env });
    assert.match(r.stdout.toString(), /no installed cli to bind a jump key to/);
  });
});
