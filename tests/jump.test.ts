/**
 * Jump adapters. Command construction is asserted argv by argv and
 * every adapter runs against a recording exec, so no AppleScript is ever sent and
 * no Automation consent dialog can appear.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { after, describe, it } from 'node:test';
import { recordingExec, type Command, type ExecResult } from '../src/exec.js';
import { paths } from '../src/paths.js';
import { tempDir } from './helpers.js';
import type { TerminalInfo, WireSession } from '../src/core/types.js';
import {
  appleTerminalCommand,
  findKeyBinding,
  isAppMissing,
  isConsentDenial,
  iterm2Command,
  kittyCommand,
  pickMostRecentClient,
  tmuxBindCommand,
  tmuxConfLine,
  tmuxFocusCommand,
  tmuxListClientsCommand,
  tmuxListKeysCommand,
  tmuxSessionNameCommand,
  tmuxUnbindLine,
  ttyPath,
  weztermCommand,
} from '../src/terminal/commands.js';
import { adapterFor, createAdapters, detectLocalAdapter } from '../src/terminal/adapter.js';
import { jumpSuccessOutput, jumpSummary, performJump, reasonFor } from '../src/commands/jump.js';
import { findSession, findSlot, isSlotQuery } from '../src/core/priority.js';
import { gnomeBinding, keyProblem, MODIFIER_WORDS, runKeysSetup } from '../src/commands/keys-setup.js';
import { keyIntent } from '../src/terminal/keys.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

function session(terminal: TerminalInfo, over: Partial<WireSession> = {}): WireSession {
  return {
    sessionId: 's1',
    slot: 1,
    project: 'authsvc',
    branch: 'oauth',
    cwd: '/repos/authsvc',
    transcriptPath: '',
    sessionSource: 'startup',
    state: 'permission_wait',
    displayState: 'permission_wait',
    stateSince: 1000,
    lastEventTs: 1000,
    sessionStart: 1000,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal,
    ppid: 0,
    ...over,
  };
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

/** performJump writes a jump record, so the few tests that run it get a throwaway dir. */
const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('command construction', () => {
  it('turns a stored tty into a device path', () => {
    assert.equal(ttyPath('ttys003'), '/dev/ttys003');
    assert.equal(ttyPath('/dev/ttys003'), '/dev/ttys003');
    assert.equal(ttyPath('pts/4'), '/dev/pts/4');
  });

  it('builds one osascript argv for Terminal.app that matches on tty', () => {
    const cmd = appleTerminalCommand('ttys003');
    assert.equal(cmd.cmd, 'osascript');
    assert.equal(cmd.args.length, 2);
    assert.equal(cmd.args[0], '-e');
    const script = cmd.args[1] as string;
    assert.match(script, /tell application "Terminal"/);
    assert.match(script, /if tty of t is "\/dev\/ttys003" then/);
    assert.match(script, /set selected of t to true/);
    assert.match(script, /activate/);
    assert.match(script, /return "ok"/);
    assert.match(script, /return "notfound"/);
  });

  it('builds one osascript argv for iTerm2 that walks sessions', () => {
    const script = iterm2Command('ttys009').args[1] as string;
    assert.match(script, /tell application id "com\.googlecode\.iterm2"/);
    assert.match(script, /repeat with s in sessions of t/);
    assert.match(script, /if tty of s is "\/dev\/ttys009" then/);
    assert.match(script, /select s/);
  });

  it('builds the two tmux argvs, with ; as its own argument', () => {
    assert.deepEqual(tmuxSessionNameCommand('%12'), {
      cmd: 'tmux',
      args: ['display', '-p', '-t', '%12', '#{session_name}'],
    });
    assert.deepEqual(tmuxFocusCommand('%12', 'work'), {
      cmd: 'tmux',
      args: ['switch-client', '-t', 'work', ';', 'select-window', '-t', '%12', ';', 'select-pane', '-t', '%12'],
    });
  });

  it('targets a client tty when the jump comes from outside tmux', () => {
    assert.deepEqual(tmuxListClientsCommand(), {
      cmd: 'tmux',
      args: ['list-clients', '-F', '#{client_activity} #{client_tty}'],
    });
    assert.deepEqual(tmuxFocusCommand('%12', 'work', '/dev/ttys004'), {
      cmd: 'tmux',
      args: [
        'switch-client',
        '-c',
        '/dev/ttys004',
        '-t',
        'work',
        ';',
        'select-window',
        '-t',
        '%12',
        ';',
        'select-pane',
        '-t',
        '%12',
      ],
    });
  });

  it('builds the bind argvs, with and without the note', () => {
    const run = '"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump >/dev/null 2>&1';
    assert.deepEqual(tmuxBindCommand('g', 'cctap: note', run, true), {
      cmd: 'tmux',
      args: ['bind-key', '-N', 'cctap: note', 'g', 'run-shell', '-b', run],
    });
    assert.deepEqual(tmuxBindCommand('g', 'cctap: note', run, false), {
      cmd: 'tmux',
      args: ['bind-key', 'g', 'run-shell', '-b', run],
    });
    // The whole table, because asking for one key answers empty on some builds.
    assert.deepEqual(tmuxListKeysCommand(), { cmd: 'tmux', args: ['list-keys', '-T', 'prefix'] });
    assert.equal(tmuxUnbindLine('g'), 'tmux unbind-key g');
  });

  it('quotes the tmux.conf line so the jump line keeps its own quotes', () => {
    const run = '"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump >/dev/null 2>&1';
    assert.equal(tmuxConfLine('g', run), `bind-key g run-shell -b '${run}'`);
    // A path with an apostrophe cannot go inside single quotes in tmux.conf.
    assert.equal(
      tmuxConfLine('g', `"/home/o'x/node" jump`),
      'bind-key g run-shell -b "\\"/home/o\'x/node\\" jump"',
    );
  });

  it('picks the most recently active client, and skips junk lines', () => {
    assert.equal(pickMostRecentClient(''), undefined);
    assert.equal(pickMostRecentClient('\n  \n'), undefined);
    assert.equal(pickMostRecentClient('1712345678'), undefined, 'no tty on the line');
    assert.equal(pickMostRecentClient('nonsense /dev/ttys001'), undefined, 'no epoch on the line');
    assert.equal(pickMostRecentClient('1712345678 /dev/ttys004\n'), '/dev/ttys004');
    assert.equal(
      pickMostRecentClient('1712345678 /dev/ttys001\nrubbish\n1712349999 /dev/ttys002\n1712340000 /dev/ttys003\n'),
      '/dev/ttys002',
    );
    // Epochs in milliseconds run past 32 bits, and a string compare would pick the wrong one.
    assert.equal(pickMostRecentClient('9999999999 /dev/ttys001\n10000000000 /dev/ttys002'), '/dev/ttys002');
    assert.equal(pickMostRecentClient('1712345678 /dev/ttys001\n1712345678 /dev/ttys002'), '/dev/ttys001', 'ties keep the first');
  });

  it('finds the line that binds one key in a prefix table', () => {
    const table = [
      'bind-key    -T prefix c                 new-window',
      'bind-key    -T prefix d                 detach-client',
      'bind-key -r -T prefix Up                select-pane -U',
      'bind-key    -T prefix g                 run-shell -b true',
      'bind-key    -T prefix "\'"               display-message hi',
      'bind-key    -T copy-mode g              history-top',
    ].join('\n');
    assert.equal(findKeyBinding(table, 'g'), 'bind-key    -T prefix g                 run-shell -b true');
    assert.equal(findKeyBinding(table, 'Up'), 'bind-key -r -T prefix Up                select-pane -U');
    assert.equal(findKeyBinding(table, "'"), 'bind-key    -T prefix "\'"               display-message hi');
    assert.equal(findKeyBinding(table, 'j'), undefined);
    assert.equal(findKeyBinding('', 'g'), undefined);
  });

  it('builds the kitty and wezterm argvs', () => {
    assert.deepEqual(kittyCommand('4'), { cmd: 'kitten', args: ['@', 'focus-window', '--match', 'id:4'] });
    assert.deepEqual(weztermCommand('7'), { cmd: 'wezterm', args: ['cli', 'activate-pane', '--pane-id', '7'] });
  });

  it('puts the kitty socket on `kitten @`, before the subcommand', () => {
    assert.deepEqual(kittyCommand('4', 'unix:/tmp/kitty-9'), {
      cmd: 'kitten',
      args: ['@', '--to', 'unix:/tmp/kitty-9', 'focus-window', '--match', 'id:4'],
    });
    assert.deepEqual(kittyCommand('4', ''), kittyCommand('4'), 'an empty socket adds nothing');
  });

  it('recognises a consent denial and a missing app', () => {
    assert.equal(isConsentDenial('execution error: Not authorised to send Apple events to Terminal. (-1743)', 1), true);
    assert.equal(isConsentDenial('something else', 1), false);
    assert.equal(isConsentDenial('-1743', 0), false, 'a zero exit is never a denial');
    assert.equal(isAppMissing("execution error: Application isn't running. (-600)", 1), true);
  });
});

describe('apple-terminal adapter', () => {
  const s = session({ kind: 'apple-terminal', tty: 'ttys003' });

  it('sends exactly one osascript command and reports success', async () => {
    const exec = recordingExec(() => ok('ok\n'));
    const res = await createAdapters({ exec })['apple-terminal'].focus(s);
    assert.equal(res.ok, true);
    assert.equal(res.consent, 'granted');
    assert.equal(exec.calls.length, 1);
    assert.deepEqual(exec.calls[0], appleTerminalCommand('ttys003'));
  });

  it('explains a denied Automation consent', async () => {
    const exec = recordingExec(() => fail('execution error: Not authorized to send Apple events to Terminal. (-1743)'));
    const res = await createAdapters({ exec })['apple-terminal'].focus(s);
    assert.equal(res.ok, false);
    assert.equal(res.consent, 'denied');
    assert.match(res.reason ?? '', /Automation/);
    assert.match(res.reason ?? '', /cctap doctor/);
  });

  it('falls back when the tab is gone', async () => {
    const exec = recordingExec(() => ok('notfound\n'));
    const res = await createAdapters({ exec })['apple-terminal'].focus(s);
    assert.equal(res.ok, false);
    assert.equal(res.consent, 'granted', 'the event went through, the tab just closed');
    assert.match(res.detail, /no tab on that tty/);
  });

  it('says so when Terminal is not running', async () => {
    const exec = recordingExec(() => fail("execution error: Application isn't running. (-600)"));
    const res = await createAdapters({ exec })['apple-terminal'].focus(s);
    assert.equal(res.ok, false);
    assert.match(res.detail, /not running/);
  });

  it('never runs anything without a resolved tty', async () => {
    const exec = recordingExec(() => ok('ok'));
    const res = await createAdapters({ exec })['apple-terminal'].focus(session({ kind: 'apple-terminal' }));
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 0);
  });
});

describe('tmux adapter', () => {
  const s = session({ kind: 'tmux', tmuxPane: '%12' });

  it('resolves the session name, then switches in one call', async () => {
    const answers = (c: Command): ExecResult => (c.args[0] === 'display' ? ok('work\n') : ok());
    const exec = recordingExec(answers);
    const res = await createAdapters({ exec, env: { TMUX: '/tmp/tmux-501/default,1,0' } }).tmux.focus(s);
    assert.equal(res.ok, true);
    assert.equal(exec.calls.length, 2, 'inside a client there is nothing to look up');
    assert.deepEqual(exec.calls[0], tmuxSessionNameCommand('%12'));
    assert.deepEqual(exec.calls[1], tmuxFocusCommand('%12', 'work'));
    assert.equal(exec.calls[1]?.args.includes('-c'), false, 'the current client needs no target');
  });

  it('falls back when the pane is gone', async () => {
    const exec = recordingExec(() => fail("can't find pane %12"));
    const res = await createAdapters({ exec, env: { TMUX: 'x' } }).tmux.focus(s);
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 1, 'no switch attempted without a session name');
  });
});

/** An OS hotkey fires from outside every client, and tmux can still move one. */
describe('tmux adapter from outside a client', () => {
  const s = session({ kind: 'tmux', tmuxPane: '%12' });
  const answers =
    (clients: ExecResult, focus: ExecResult = ok()) =>
    (c: Command): ExecResult => {
      if (c.args[0] === 'list-clients') return clients;
      if (c.args[0] === 'display') return ok('work\n');
      return focus;
    };

  it('refuses when there is no tmux server, and never attaches', async () => {
    const exec = recordingExec(answers(fail('error connecting to /tmp/tmux-501/default (No such file or directory)')));
    const res = await createAdapters({ exec, env: {} }).tmux.focus(s);
    assert.equal(res.ok, false);
    assert.match(res.detail, /no tmux client attached/);
    assert.match(res.reason ?? '', /%12/);
    assert.deepEqual(exec.calls, [tmuxListClientsCommand()], 'it asked once and stopped');
  });

  it('refuses when a server is up but nobody is attached', async () => {
    const exec = recordingExec(answers(ok('\n')));
    const res = await createAdapters({ exec, env: {} }).tmux.focus(s);
    assert.equal(res.ok, false);
    assert.match(res.detail, /no tmux client attached/);
    assert.equal(exec.calls.length, 1, 'never spawn attach');
  });

  it('moves the attached client and names the tty it moved', async () => {
    const exec = recordingExec(answers(ok('1712345678 /dev/ttys004\n')));
    const res = await createAdapters({ exec, env: {} }).tmux.focus(s);
    assert.equal(res.ok, true);
    assert.deepEqual(exec.calls, [
      tmuxListClientsCommand(),
      tmuxSessionNameCommand('%12'),
      tmuxFocusCommand('%12', 'work', '/dev/ttys004'),
    ]);
    assert.deepEqual(exec.calls[2]?.args, [
      'switch-client',
      '-c',
      '/dev/ttys004',
      '-t',
      'work',
      ';',
      'select-window',
      '-t',
      '%12',
      ';',
      'select-pane',
      '-t',
      '%12',
    ]);
    assert.match(res.detail, /\/dev\/ttys004/);
    assert.match(res.detail, /work pane %12/);
  });

  it('picks the most recently active client out of several', async () => {
    const exec = recordingExec(
      answers(ok('1712340000 /dev/ttys001\n1712349999 /dev/ttys002\n1712345678 /dev/ttys003\n')),
    );
    const res = await createAdapters({ exec, env: {} }).tmux.focus(s);
    assert.equal(res.ok, true);
    assert.deepEqual(exec.calls[2], tmuxFocusCommand('%12', 'work', '/dev/ttys002'));
  });

  it('surfaces a switch that tmux refused', async () => {
    const exec = recordingExec(answers(ok('1712345678 /dev/ttys004\n'), fail("can't find client /dev/ttys004")));
    const res = await createAdapters({ exec, env: {} }).tmux.focus(s);
    assert.equal(res.ok, false);
    assert.match(res.detail, /tmux refused the switch/);
    assert.match(res.reason ?? '', /can't find client/);
  });
});

describe('kitty and wezterm adapters', () => {
  it('focus a kitty window', async () => {
    const exec = recordingExec(() => ok());
    const res = await createAdapters({ exec }).kitty.focus(session({ kind: 'kitty', kittyWindowId: '4' }));
    assert.equal(res.ok, true);
    assert.deepEqual(exec.calls[0], kittyCommand('4'));
  });

  it('name the remote-control setting when kitty refuses', async () => {
    const exec = recordingExec(() => fail('allow_remote_control is not enabled'));
    const res = await createAdapters({ exec }).kitty.focus(session({ kind: 'kitty', kittyWindowId: '4' }));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /allow_remote_control yes/);
  });

  it('pass the stored kitty socket to kitten @', async () => {
    const exec = recordingExec(() => ok());
    const res = await createAdapters({ exec }).kitty.focus(
      session({ kind: 'kitty', kittyWindowId: '4', kittyListenOn: 'unix:/tmp/kitty-9' }),
    );
    assert.equal(res.ok, true);
    assert.deepEqual(exec.calls[0], kittyCommand('4', 'unix:/tmp/kitty-9'));
  });

  it('activate a wezterm pane and say the window did not move', async () => {
    const exec = recordingExec(() => ok());
    const res = await createAdapters({ exec }).wezterm.focus(session({ kind: 'wezterm', weztermPane: '7' }));
    assert.equal(res.ok, true);
    assert.deepEqual(exec.calls[0], weztermCommand('7'));
    assert.equal(
      res.detail,
      'activated wezterm pane 7. WezTerm cannot bring its own window forward, so the window stays where it was',
    );
  });
});

/**
 * WezTerm is the one adapter whose success is partial: the pane focus moves and the
 * window does not. Neither headline may read like a finished jump.
 */
describe('the wezterm caveat survives into what the user reads', () => {
  const registry = (exec: ReturnType<typeof recordingExec>) => createAdapters({ exec });
  const WEZ = session({ kind: 'wezterm', weztermPane: '7' });
  const DETAIL =
    'activated wezterm pane 7. WezTerm cannot bring its own window forward, so the window stays where it was';

  it('marks the status-bar summary as a jump that did not raise the window', () => {
    const r = createAdapters({ exec: recordingExec() });
    assert.equal(jumpSummary('authsvc', r.wezterm), 'jumped to authsvc (window not raised)');
    assert.equal(jumpSummary('authsvc', r.tmux), 'jumped to authsvc');
    assert.equal(jumpSummary('authsvc', r.kitty), 'jumped to authsvc');
  });

  it('prints the adapter detail under the headline, for wezterm only', () => {
    const r = createAdapters({ exec: recordingExec() });
    assert.equal(
      jumpSuccessOutput('authsvc', r.wezterm, { ok: true, detail: DETAIL }),
      `jumped to authsvc\n  ${DETAIL}\n`,
    );
    assert.equal(jumpSuccessOutput('authsvc', r.kitty, { ok: true, detail: 'focused kitty window 4' }), 'jumped to authsvc\n');
  });

  it('carries it through performJump itself', async () => {
    const exec = recordingExec(() => ok());
    const p = paths({ CCTAP_DIR: tempDir('cctap-wez-') });
    dirs.push(p.dir);
    const outcome = await performJump(p, WEZ, 'authsvc', registry(exec));
    assert.equal(outcome.ok, true);
    assert.deepEqual(exec.calls, [weztermCommand('7')]);
    assert.equal(outcome.summary, 'jumped to authsvc (window not raised)');
    assert.equal(outcome.result.detail, DETAIL);
  });

  it('leaves every other adapter\'s summary alone', async () => {
    const exec = recordingExec(() => ok());
    const p = paths({ CCTAP_DIR: tempDir('cctap-wez-') });
    dirs.push(p.dir);
    const outcome = await performJump(p, session({ kind: 'kitty', kittyWindowId: '4' }), 'authsvc', registry(exec));
    assert.equal(outcome.summary, 'jumped to authsvc');
  });
});

describe('adapter selection', () => {
  const exec = recordingExec();
  const registry = createAdapters({ exec, env: { TMUX: 'x' } });

  it('picks by terminal kind and degrades without a handle', () => {
    assert.equal(adapterFor(session({ kind: 'tmux', tmuxPane: '%4' }), registry).kind, 'tmux');
    assert.equal(adapterFor(session({ kind: 'tmux' }), registry).kind, 'fallback');
    assert.equal(adapterFor(session({ kind: 'apple-terminal', tty: 'ttys003' }), registry).kind, 'apple-terminal');
    assert.equal(adapterFor(session({ kind: 'apple-terminal' }), registry).kind, 'fallback');
    assert.equal(adapterFor(session({ kind: 'iterm2', tty: 'ttys004' }), registry).kind, 'iterm2');
    assert.equal(adapterFor(session({ kind: 'unknown' }), registry).kind, 'fallback');
  });

  it('the fallback never executes anything', async () => {
    const res = await registry.fallback.focus(session({ kind: 'unknown' }));
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 0);
  });

  it('detects the local adapter from env', () => {
    assert.equal(detectLocalAdapter({ TMUX: '/x', TMUX_PANE: '%1' }).kind, 'tmux');
    assert.equal(detectLocalAdapter({ TERM_PROGRAM: 'Apple_Terminal' }).kind, 'apple-terminal');
    assert.equal(detectLocalAdapter({ TERM_PROGRAM: 'iTerm.app' }).kind, 'iterm2');
    assert.equal(detectLocalAdapter({ TERM_PROGRAM: 'vscode' }).kind, 'fallback');
  });
});

describe('jump reasons', () => {
  it('names why a session is calling', () => {
    assert.equal(reasonFor(session({ kind: 'unknown' }, { attentionKind: 'permission' })), 'needs permission');
    assert.equal(reasonFor(session({ kind: 'unknown' }, { attentionKind: 'elicitation' })), 'question waiting');
    assert.equal(reasonFor(session({ kind: 'unknown' }, { attentionKind: 'agent_needs_input' })), 'agent needs input');
    assert.equal(
      reasonFor(session({ kind: 'unknown' }, { state: 'working', subagents: { active: 2, running: ['a', 'b'], anonymous: 0, blocked: ['a', 'b'] } })),
      'subagent needs permission (2)',
    );
    assert.equal(
      reasonFor(session({ kind: 'unknown' }, { state: 'failed', displayState: 'failed', lastMessage: 'rate limit' })),
      'failed (rate limit)',
    );
    assert.equal(
      reasonFor(session({ kind: 'unknown' }, { state: 'your_turn', displayState: 'your_turn' })),
      'your turn',
    );
  });
});

describe('dry run plans', () => {
  it('every adapter can describe what it would run without running it', () => {
    const exec = recordingExec();
    const r = createAdapters({ exec, env: { TMUX: 'x' } });
    assert.deepEqual(r['apple-terminal'].plan(session({ kind: 'apple-terminal', tty: 'ttys003' })), [
      appleTerminalCommand('ttys003'),
    ]);
    assert.deepEqual(r.iterm2.plan(session({ kind: 'iterm2', tty: 'ttys004' })), [iterm2Command('ttys004')]);
    assert.deepEqual(r.tmux.plan(session({ kind: 'tmux', tmuxPane: '%12' })), [
      tmuxSessionNameCommand('%12'),
      tmuxFocusCommand('%12', '<session-name>'),
    ]);
    assert.deepEqual(r.kitty.plan(session({ kind: 'kitty', kittyWindowId: '4' })), [kittyCommand('4')]);
    assert.deepEqual(
      r.kitty.plan(session({ kind: 'kitty', kittyWindowId: '4', kittyListenOn: 'unix:/tmp/kitty-9' })),
      [kittyCommand('4', 'unix:/tmp/kitty-9')],
      'the plan shows the socket the focus would use',
    );
    assert.deepEqual(r.wezterm.plan(session({ kind: 'wezterm', weztermPane: '7' })), [weztermCommand('7')]);
    assert.deepEqual(r.fallback.plan(session({ kind: 'unknown' })), []);
    assert.deepEqual(r['apple-terminal'].plan(session({ kind: 'apple-terminal' })), [], 'no tty, no plan');
    assert.equal(exec.calls.length, 0, 'planning runs nothing');
  });

  it('shows the client lookup and a placeholder tty when planned from outside tmux', () => {
    const exec = recordingExec();
    const r = createAdapters({ exec, env: {} });
    assert.deepEqual(r.tmux.plan(session({ kind: 'tmux', tmuxPane: '%12' })), [
      tmuxListClientsCommand(),
      tmuxSessionNameCommand('%12'),
      tmuxFocusCommand('%12', '<session-name>', '<client-tty>'),
    ]);
    assert.deepEqual(r.tmux.plan(session({ kind: 'tmux' })), [], 'no pane, no plan');
    assert.equal(exec.calls.length, 0, 'planning runs nothing');
  });
});

describe('adapter verification status', () => {
  it('marks kitty, wezterm and iterm2 as not live verified', () => {
    const r = createAdapters({ exec: recordingExec() });
    assert.equal(r['apple-terminal'].liveVerified, true);
    assert.equal(r.iterm2.liveVerified, false);
    assert.equal(r.tmux.liveVerified, true);
    assert.equal(r.kitty.liveVerified, false);
    assert.equal(r.wezterm.liveVerified, false);
  });
});


/** A number is a slot. Anything else is a prefix. There is no overlap by design. */
describe('slot lookup beats prefix matching', () => {
  const list = [
    session({ kind: 'unknown' }, { sessionId: '2abc', slot: 1, project: 'alpha', branch: 'main' }),
    session({ kind: 'unknown' }, { sessionId: 'zzz', slot: 2, project: 'beta', branch: 'main' }),
  ];
  const labelOf = (x: WireSession): string => `${x.project}:${x.branch}`;

  it('reads a numeric query as a slot even when a session id starts with it', () => {
    assert.equal(isSlotQuery('2'), true);
    assert.equal(isSlotQuery('2abc'), false, 'only a pure number is a slot');
    assert.equal(isSlotQuery('alpha'), false);
    const hit = findSession(list, '2', labelOf);
    assert.equal(hit?.sessionId, 'zzz', 'slot 2, not the id prefix 2abc');
  });

  it('still matches prefixes for anything that is not a number', () => {
    assert.equal(findSession(list, '2abc', labelOf)?.sessionId, '2abc');
    assert.equal(findSession(list, 'beta', labelOf)?.sessionId, 'zzz');
  });

  it('misses cleanly on a slot nobody holds', () => {
    assert.equal(findSession(list, '9', labelOf), undefined);
    assert.equal(findSlot(list, 9), undefined);
    assert.equal(findSlot(list, 1)?.sessionId, '2abc');
  });
});


/** The system key is the keystone of the full-screen workflow, so setup carries it. */
describe('cctap keys setup', () => {
  const base = {
    jumpLine: '"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump',
    slotLines: [1, 2, 3].map((slot) => ({
      slot,
      line: `"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump ${slot}`,
    })),
  };

  it('on macOS puts the line on the clipboard and opens Shortcuts', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec, blocked: false });
    assert.equal(r.code, 0);
    assert.deepEqual(exec.calls, [
      { cmd: 'pbcopy', args: [], input: base.jumpLine },
      { cmd: 'open', args: ['shortcuts://create-shortcut'] },
    ]);
    const text = r.lines.join('\n');
    assert.match(text, /on your clipboard/);
    assert.match(text, /1\. type "shell" in the actions search, top right, and double-click "Run Shell Script"/);
    // Never Alt+digit: Claude Code binds Alt+1 to Alt+9 in its agent view.
    assert.match(text, /press the keys\. Ctrl\+Cmd\+J is free on a stock Mac/);
    const suggestion = r.lines.find((l) => l.includes('is free on a stock Mac')) ?? '';
    assert.equal(/[Aa]lt\+\d/.test(suggestion), false, `no Alt+digit suggested: ${suggestion}`);
    assert.match(text, /7\. done/);
    assert.match(text, /Automation consent/);
    assert.ok(text.includes(`${base.jumpLine} 2`), 'per-slot lines are still offered');
    assert.ok(text.indexOf('advanced:') > text.indexOf('Run Shell Script'), 'but last, as a footnote');
    assert.match(text, /Claude Code binds Alt\+1 to Alt\+9/, 'with the collision named');
  });

  /** W4: nothing is interactive here, so every surprise has to be said before it happens. */
  it('warns that the clipboard is about to be replaced, before pbcopy runs', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec, blocked: false });
    const warned = r.lines.findIndex((l) => /about to replace whatever is on your clipboard/.test(l));
    assert.ok(warned >= 0, `the warning is printed: ${r.lines.join('\n')}`);
    assert.equal(warned, 0, 'and it comes first, before the line saying the copy happened');
    assert.ok(warned < r.lines.findIndex((l) => l.includes('the jump command is on your clipboard')));
  });

  it('names the Allow Running Scripts toggle and the second consent dialog (W4)', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec, blocked: false });
    const text = r.lines.join('\n');
    assert.match(text, /turn on "Allow Running Scripts"/);
    assert.match(text, /Open Preferences/);
    assert.match(text, /small \(i\) at the top right/);
    assert.match(text, /6\. press that key once straight away, while you are still looking at the desktop/);
    // The dialog that catches people out: differently worded, and Shortcuts is the asker.
    assert.match(text, /second consent dialog, worded/);
    assert.match(text, /names Shortcuts as the app asking for Automation consent/);
    assert.match(text, /screen window can hide that dialog/);
    assert.equal(/[—–]/.test(text), false, 'no em or en dashes');
    assert.equal(text.includes(';'), false, 'no semicolons in the steps');
  });

  it('falls back to the recipe when the mac tools are not reachable', async () => {
    const exec = recordingExec(() => ({ code: 127, stdout: '', stderr: 'not found' }));
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec, blocked: false });
    assert.match(r.lines.join('\n'), /here is the manual version/);
    assert.ok(r.lines.join('\n').includes(base.jumpLine));
  });

  const LIST = 'org.gnome.settings-daemon.plugins.media-keys';
  const ITEM =
    'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:' +
    '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cctap/';
  const OURS = "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cctap/']";

  /** gsettings answers the list on the probe and the command on the W3 read-back. */
  const gsettings =
    (o: { list?: string; readBack?: string } = {}) =>
    (c: Command): ExecResult => {
      if (c.args[0] !== 'get') return ok();
      if (c.args[2] === 'custom-keybindings') return ok(`${o.list ?? '@as []'}\n`);
      return ok(`'${o.readBack ?? base.jumpLine}'\n`);
    };

  it('writes the GNOME binding through gsettings, and says how to undo it', async () => {
    const exec = recordingExec(gsettings());
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false, key: 'ctrl+alt+j' });
    assert.equal(r.code, 0);
    // W1: name, command and binding first, the list registration last. GNOME watches the
    // list, so registering first races the settings daemon against a half-written object.
    assert.deepEqual(exec.calls, [
      { cmd: 'gsettings', args: ['get', LIST, 'custom-keybindings'] },
      { cmd: 'gsettings', args: ['set', ITEM, 'name', 'cctap-jump'] },
      { cmd: 'gsettings', args: ['set', ITEM, 'command', base.jumpLine] },
      { cmd: 'gsettings', args: ['set', ITEM, 'binding', '<Control><Alt>j'] },
      { cmd: 'gsettings', args: ['set', LIST, 'custom-keybindings', OURS] },
      { cmd: 'gsettings', args: ['get', ITEM, 'command'] },
    ]);
    const text = r.lines.join('\n');
    assert.match(text, /bound <Control><Alt>j to the jump/);
    assert.match(text, /to undo it:/);
    assert.match(text, /gsettings reset-recursively/);
  });

  it('registers the list only after the object it points at exists (W1)', async () => {
    const exec = recordingExec(gsettings());
    await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    const order = exec.calls.filter((c) => c.args[0] === 'set').map((c) => c.args[2]);
    assert.deepEqual(order, ['name', 'command', 'binding', 'custom-keybindings']);
  });

  it('defaults the GNOME binding to Super+J, never an Alt+digit', async () => {
    const exec = recordingExec(gsettings());
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    const binding = exec.calls.find((c) => c.args[2] === 'binding');
    assert.equal(binding?.args[3], '<Super>j');
    assert.match(r.lines.join('\n'), /bound <Super>j to the jump/);
    assert.equal(r.code, 0, 'the default key passes validation');
  });

  it('keeps an existing keybinding list rather than replacing it', async () => {
    const exec = recordingExec(gsettings({ list: "['/other/']" }));
    await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    const setList = exec.calls.find((c) => c.args[2] === 'custom-keybindings' && c.args[0] === 'set');
    assert.equal(
      setList?.args[3],
      "['/other/', '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cctap/']",
    );
  });

  /**
   * W2: a word gnomeBinding does not know would be dropped, and `hyper+j` would bind a
   * bare j system wide. Nothing may run until every word is understood.
   */
  for (const bad of ['hyper+j', '+j', 'ctrl+', 'ctrl+alt+']) {
    it(`refuses ${JSON.stringify(bad)} without running a single command`, async () => {
      const exec = recordingExec(gsettings());
      const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false, key: bad });
      assert.deepEqual(exec.calls, [], 'not even the probe ran');
      assert.equal(r.journal, undefined, 'nothing written means nothing journaled');
      assert.equal(r.code, 0, 'a clean answer with the recipe, not a crash');
      const text = r.lines.join('\n');
      // The word nobody understood is named, and so is every word that would work.
      const named = bad.endsWith('+')
        ? 'the key itself is missing after the last +'
        : `"${bad.split('+')[0] ?? ''}" is not a modifier cctap knows`;
      assert.ok(text.includes(named), `the problem word is named: ${text}`);
      for (const mod of ['alt', 'option', 'ctrl', 'control', 'shift', 'super', 'cmd', 'meta']) {
        assert.ok(text.includes(mod), `${mod} is listed as accepted`);
      }
      assert.ok(text.includes(base.jumpLine), 'and it falls back to the recipe');
    });
  }

  it('accepts a key whose every word is a modifier it knows', async () => {
    for (const good of ['ctrl+alt+t', 'F9', 'super+space', 'CTRL+Alt+J']) {
      const exec = recordingExec(gsettings());
      const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false, key: good });
      assert.equal(r.code, 0, good);
      assert.equal(exec.calls.length, 6, `${good} was written and read back`);
    }
  });

  it('reports a read-back mismatch as a failure, and keeps the undo reachable (W3)', async () => {
    const exec = recordingExec(gsettings({ list: "['/other/']", readBack: '/usr/bin/somethingelse' }));
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false, now: 7 });
    assert.equal(r.code, 1, 'a silent grab is a failure, never a success');
    const text = r.lines.join('\n');
    assert.match(text, /reading the binding back gave something else, so this failed/);
    assert.ok(text.includes(`  wrote  ${base.jumpLine}`));
    assert.ok(text.includes('  read   /usr/bin/somethingelse'));
    // The two undo commands, verbatim, because the entry is the only way back.
    assert.ok(text.includes(`  gsettings reset-recursively ${ITEM}`));
    assert.ok(text.includes(`  gsettings set ${LIST} custom-keybindings "['/other/']"`));
    assert.equal(text.includes('bound <Super>j to the jump'), false, 'and it never claims success');
    // Still journaled: a write nobody can undo is worse than a write that failed.
    assert.deepEqual(r.journal, [
      {
        at: 7,
        kind: 'gnome-keybinding',
        key: '<Super>j',
        command: base.jumpLine,
        undo: [
          { cmd: 'gsettings', args: ['reset-recursively', ITEM] },
          { cmd: 'gsettings', args: ['set', LIST, 'custom-keybindings', "['/other/']"] },
        ],
        previous: "['/other/']",
      },
    ]);
  });

  it('treats a read-back that answers nothing as a mismatch too', async () => {
    const exec = recordingExec((c) =>
      c.args[0] === 'get' && c.args[2] === 'command' ? fail('No such key') : gsettings()(c),
    );
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    assert.equal(r.code, 1);
    assert.match(r.lines.join('\n'), /read {3}\(nothing came back\)/);
    assert.equal(r.journal?.length, 1, 'journaled anyway, so undo still reaches it');
  });

  it('says the binding was read back when it matches', async () => {
    const exec = recordingExec(gsettings());
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    assert.equal(r.code, 0);
    assert.match(r.lines.join('\n'), /read back from gsettings after the write, and the command matches/);
  });

  it('prints the recipe on a desktop without the GNOME schema', async () => {
    const exec = recordingExec(() => ({ code: 2, stdout: '', stderr: 'No such schema' }));
    const r = await runKeysSetup({ ...base, platform: 'linux', exec, blocked: false });
    assert.match(r.lines.join('\n'), /bind it in your desktop's own keyboard settings/);
    assert.equal(exec.calls.length, 1, 'it probed once and stopped');
  });

  it('runs nothing at all under CCTAP_NO_EXEC', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec, blocked: true });
    assert.deepEqual(exec.calls, []);
    assert.match(r.lines.join('\n'), /CCTAP_NO_EXEC is set, so nothing was run/);
    assert.ok(r.lines.join('\n').includes(base.jumpLine), 'and it still shows the line');
  });

  it('translates key names into GNOME binding syntax', () => {
    assert.equal(gnomeBinding('alt+j'), '<Alt>j');
    assert.equal(gnomeBinding('ctrl+alt+j'), '<Control><Alt>j');
    assert.equal(gnomeBinding('super+space'), '<Super>space');
    assert.equal(gnomeBinding('F9'), 'F9');
  });

  it('knows which keys it understands, before anything is written (W2)', () => {
    for (const good of ['j', 'F9', 'alt+j', 'ctrl+alt+t', 'CTRL+Alt+J', 'super+space', ' ctrl + j ']) {
      assert.equal(keyProblem(good), undefined, good);
    }
    assert.match(keyProblem('hyper+j') ?? '', /^"hyper" is not a modifier/);
    assert.match(keyProblem('+j') ?? '', /^"" is not a modifier/);
    assert.match(keyProblem('ctrl+') ?? '', /key itself is missing/);
    assert.match(keyProblem('') ?? '', /key itself is missing/);
    // An inherited property is not a modifier word, whatever the prototype says.
    assert.match(keyProblem('constructor+j') ?? '', /^"constructor" is not a modifier/);
    assert.equal(gnomeBinding('constructor+j'), 'j', 'and it never lands in the binding');
    assert.deepEqual(MODIFIER_WORDS, ['alt', 'option', 'ctrl', 'control', 'shift', 'super', 'cmd', 'meta']);
  });
});


/** Inside tmux the key is one bind away, and nothing on disk is touched for it. */
describe('cctap keys setup inside tmux', () => {
  const base = {
    platform: 'darwin',
    blocked: false,
    env: { TMUX: '/tmp/tmux-501/default,1,0' },
    jumpLine: '"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump',
    slotLines: [1, 2, 3].map((slot) => ({
      slot,
      line: `"/abs/node" "/home/u/.cctap/bin/cctap.mjs" jump ${slot}`,
    })),
  };
  const RUN_LINE = `${base.jumpLine} >/dev/null 2>&1`;
  const NOTE = 'cctap: jump to the session that needs you';
  const FREE = 'bind-key    -T prefix c                 new-window\nbind-key    -T prefix d                 detach-client\n';
  const TAKEN = `${FREE}bind-key    -T prefix g                 display-message "mine"\n`;
  const table = (out: string) => (c: Command): ExecResult => (c.args[0] === 'list-keys' ? ok(out) : ok());

  it('scans the prefix table, then binds with a note', async () => {
    const exec = recordingExec(table(FREE));
    const r = await runKeysSetup({ ...base, exec });
    assert.equal(r.code, 0);
    assert.deepEqual(exec.calls, [
      { cmd: 'tmux', args: ['list-keys', '-T', 'prefix'] },
      { cmd: 'tmux', args: ['bind-key', '-N', NOTE, 'g', 'run-shell', '-b', RUN_LINE] },
    ]);
    const text = r.lines.join('\n');
    assert.match(text, /prefix \+ g now jumps to the session that needs you, in every tmux session/);
    assert.match(text, /tmux unbind-key g/);
    assert.match(text, /until the tmux server exits/);
    assert.ok(text.includes(`bind-key g run-shell -b '${RUN_LINE}'`), 'the ~/.tmux.conf line is printed');
    assert.match(text, /cctap keys setup --os/);
    assert.ok(text.includes(`${base.jumpLine} 2`), 'per-slot lines are still offered');
  });

  it('retries without the note on a tmux too old for -N', async () => {
    const exec = recordingExec((c) => {
      if (c.args[0] === 'list-keys') return ok(FREE);
      return c.args.includes('-N') ? fail('unknown flag -N') : ok();
    });
    const r = await runKeysSetup({ ...base, exec });
    assert.equal(r.code, 0);
    assert.equal(exec.calls.length, 3);
    assert.deepEqual(exec.calls[2], { cmd: 'tmux', args: ['bind-key', 'g', 'run-shell', '-b', RUN_LINE] });
    assert.match(r.lines.join('\n'), /prefix \+ g now jumps/);
  });

  it('prints the recipe when tmux refuses both binds', async () => {
    const exec = recordingExec((c) => (c.args[0] === 'list-keys' ? ok(FREE) : fail('no server running')));
    const r = await runKeysSetup({ ...base, exec });
    const text = r.lines.join('\n');
    assert.match(text, /tmux refused the bind: no server running/);
    assert.ok(text.includes(base.jumpLine));
  });

  it('never overwrites someone else\'s key, and says how to pick another', async () => {
    const exec = recordingExec(table(TAKEN));
    const r = await runKeysSetup({ ...base, exec });
    assert.equal(r.code, 0, 'a clean answer, not an error');
    assert.equal(exec.calls.length, 1, 'nothing was bound');
    const text = r.lines.join('\n');
    assert.match(text, /prefix \+ g is already bound to something else/);
    assert.ok(text.includes('display-message "mine"'), 'the existing binding, verbatim');
    assert.match(text, /cctap keys setup j/);
    assert.match(text, /cctap keys setup g/);
  });

  it('takes the key over when it was named on purpose, and shows what was there', async () => {
    const exec = recordingExec(table(TAKEN));
    const r = await runKeysSetup({ ...base, exec, key: 'g' });
    assert.equal(exec.calls.length, 2);
    assert.deepEqual(exec.calls[1], { cmd: 'tmux', args: ['bind-key', '-N', NOTE, 'g', 'run-shell', '-b', RUN_LINE] });
    const text = r.lines.join('\n');
    assert.ok(text.includes('display-message "mine"'), 'the previous binding is echoed');
    assert.match(text, /re-sourcing your tmux config brings that back/);
  });

  it('re-binds its own key without asking', async () => {
    // Exactly how tmux echoes the line it was given: inner quotes escaped.
    const echoed = RUN_LINE.replace(/"/g, '\\"');
    const mine = `${FREE}bind-key    -T prefix g                 run-shell -b "${echoed}"\n`;
    const exec = recordingExec(table(mine));
    const r = await runKeysSetup({ ...base, exec });
    assert.equal(exec.calls.length, 2, 'a re-run just binds again');
    assert.match(r.lines.join('\n'), /prefix \+ g now jumps/);
    assert.equal(r.lines.join('\n').includes('what was bound to it before'), false, 'it was ours');
  });

  it('binds another key when one is named', async () => {
    const exec = recordingExec(table(FREE));
    const r = await runKeysSetup({ ...base, exec, key: 'j' });
    assert.deepEqual(exec.calls[1], { cmd: 'tmux', args: ['bind-key', '-N', NOTE, 'j', 'run-shell', '-b', RUN_LINE] });
    assert.match(r.lines.join('\n'), /tmux unbind-key j/);
  });

  it('--os skips the bind and runs the platform setup instead', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, exec, osOnly: true });
    assert.deepEqual(exec.calls, [
      { cmd: 'pbcopy', args: [], input: base.jumpLine },
      { cmd: 'open', args: ['shortcuts://create-shortcut'] },
    ]);
    assert.match(r.lines.join('\n'), /Run Shell Script/);
  });

  it('runs no tmux command at all under CCTAP_NO_EXEC', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, exec, blocked: true });
    assert.deepEqual(exec.calls, []);
    const text = r.lines.join('\n');
    assert.match(text, /CCTAP_NO_EXEC is set, so nothing was run/);
    assert.ok(text.includes(base.jumpLine), 'and it still shows the line');
  });

  it('stays out of the way when the shell is not inside tmux', async () => {
    const exec = recordingExec();
    const r = await runKeysSetup({ ...base, exec, env: {} });
    assert.equal(exec.calls[0]?.cmd, 'pbcopy', 'the platform branch, not a bind');
    assert.equal(r.code, 0);
  });
});


/** The pane key mapping, where a terminal is not needed to know what a key means. */
describe('what a keypress means in a pane', () => {
  it('reads a digit as a slot, from a raw keypress or a piped line', () => {
    assert.deepEqual(keyIntent('1'), { kind: 'slot', slot: 1 });
    assert.deepEqual(keyIntent('9'), { kind: 'slot', slot: 9 });
    assert.deepEqual(keyIntent('2\n'), { kind: 'slot', slot: 2 }, 'a pipe adds a newline');
    assert.deepEqual(keyIntent('3\r\n'), { kind: 'slot', slot: 3 });
  });

  it('has no slot zero, because the numbers start at one', () => {
    assert.equal(keyIntent('0'), undefined);
  });

  it('leaves on q and on Ctrl-C', () => {
    assert.deepEqual(keyIntent('q'), { kind: 'quit' });
    assert.deepEqual(keyIntent('q\n'), { kind: 'quit' });
    assert.deepEqual(keyIntent('\u0003'), { kind: 'quit' });
  });

  it('keeps the top selection keys', () => {
    assert.deepEqual(keyIntent('j'), { kind: 'down' });
    assert.deepEqual(keyIntent('\u001b[B'), { kind: 'down' });
    assert.deepEqual(keyIntent('k'), { kind: 'up' });
    assert.deepEqual(keyIntent('\u001b[A'), { kind: 'up' });
    assert.deepEqual(keyIntent('\r'), { kind: 'enter' });
  });

  it('ignores anything else rather than guessing', () => {
    for (const key of ['x', 'Z', ' ', '\u001b', '!!']) assert.equal(keyIntent(key), undefined, key);
  });
});
