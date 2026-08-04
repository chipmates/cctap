/**
 * Notification transition detection, debounce and exact argv. Never dispatches for
 * real: the exec seam is a recorder, so no osascript or notify-send is ever invoked.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { recordingExec } from '../src/exec.js';
import { labelSessions } from '../src/core/labels.js';
import { reduce } from '../src/core/reducer.js';
import { emptyModel, type Model, type NormalizedEvent } from '../src/core/types.js';
import type { DisplayState, WireSession } from '../src/core/types.js';
import {
  bannersOn,
  DEBOUNCE_MS,
  desktopCommand,
  DETAIL_MAX,
  bellAlways,
  Notifier,
  notifyEnabled,
  notifyText,
  togglesFrom,
  tmuxCommand,
  type TimerHandle,
} from '../src/daemon/notify.js';
import { appleScriptString } from '../src/terminal/commands.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

function s(over: Partial<WireSession> & { sessionId: string; displayState: DisplayState }): WireSession {
  return {
    slot: 1,
    project: 'authsvc',
    branch: 'oauth',
    cwd: '/repos/authsvc',
    transcriptPath: '',
    sessionSource: 'startup',
    state: over.displayState,
    stateSince: 1000,
    lastEventTs: 1000,
    sessionStart: 1000,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal: { kind: 'unknown' },
    ppid: 0,
    ...over,
  };
}

const labels = (list: WireSession[]): Map<string, string> => labelSessions(list);

/**
 * A scheduler the test drives by hand, so a deferred banner arrives when the test says
 * so instead of five real seconds later.
 */
function fakeClock(): {
  schedule: (fn: () => void, ms: number) => TimerHandle;
  cancel: (h: TimerHandle) => void;
  waiting: number;
  fire: () => void;
} {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    schedule(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(h) {
      timers.delete(h as number);
    },
    get waiting(): number {
      return timers.size;
    },
    /** Runs every pending callback in the order it was scheduled. */
    fire(): void {
      const due = [...timers.entries()].sort((a, b) => a[0] - b[0]);
      timers.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

describe('notification copy', () => {
  it('speaks in the tap voice', () => {
    assert.equal(
      notifyText('authsvc:oauth', s({ sessionId: 'a', displayState: 'permission_wait', currentTool: 'Bash' })),
      'tap tap: authsvc:oauth needs permission (Bash)',
    );
    assert.equal(
      notifyText('blog:draft', s({ sessionId: 'b', displayState: 'your_turn' })),
      'tap tap: blog:draft is your turn',
    );
    assert.equal(
      notifyText('infra:tf', s({ sessionId: 'c', displayState: 'failed', lastMessage: 'rate limit' })),
      'tap tap: infra:tf failed (rate limit)',
    );
  });

  it('drops the parenthetical when there is nothing to say', () => {
    assert.equal(
      notifyText('x:y', s({ sessionId: 'a', displayState: 'permission_wait' })),
      'tap tap: x:y needs permission',
    );
    assert.equal(notifyText('x:y', s({ sessionId: 'c', displayState: 'failed' })), 'tap tap: x:y failed');
  });

  /** The parenthetical is free text off a hook, and it ends up in an argv. */
  it('clamps a runaway message rather than putting kilobytes in an argv', () => {
    const long = 'x'.repeat(8000);
    const text = notifyText('x:y', s({ sessionId: 'c', displayState: 'failed', lastMessage: long }));
    assert.equal(text, `tap tap: x:y failed (${'x'.repeat(DETAIL_MAX - 1)}…)`);
    assert.equal(text.length < 200, true, `the whole body stays short: ${text.length}`);

    const tool = notifyText(
      'x:y',
      s({ sessionId: 'c', displayState: 'permission_wait', currentTool: 'B'.repeat(DETAIL_MAX + 1) }),
    );
    assert.equal(tool.endsWith(`${'B'.repeat(DETAIL_MAX - 1)}…)`), true, 'the tool name too');

    // Exactly at the cap is not truncated, and no cut can split a surrogate pair.
    const edge = 'y'.repeat(DETAIL_MAX);
    assert.equal(
      notifyText('x:y', s({ sessionId: 'c', displayState: 'failed', lastMessage: edge })),
      `tap tap: x:y failed (${edge})`,
    );
    const emoji = notifyText('x:y', s({ sessionId: 'c', displayState: 'failed', lastMessage: '🐛'.repeat(200) }));
    const lone = [...emoji].some((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp >= 0xd800 && cp <= 0xdfff;
    });
    assert.equal(lone, false, 'no half a character survives the cut');
  });
});

describe('command construction', () => {
  it('builds the macOS osascript argv', () => {
    assert.deepEqual(desktopCommand('darwin', 'tap tap: a:b is your turn'), {
      cmd: 'osascript',
      args: ['-e', 'display notification "tap tap: a:b is your turn" with title "cctap"'],
    });
  });

  it('builds the linux notify-send argv', () => {
    assert.deepEqual(desktopCommand('linux', 'tap tap: a:b is your turn'), {
      cmd: 'notify-send',
      args: ['--app-name=cctap', 'cctap', 'tap tap: a:b is your turn'],
    });
  });

  it('has no notifier on other platforms', () => {
    assert.equal(desktopCommand('freebsd', 'x'), undefined);
    assert.equal(desktopCommand('win32', 'x'), undefined);
  });

  it('escapes quotes and backslashes for AppleScript', () => {
    assert.equal(appleScriptString('a"b\\c'), 'a\\"b\\\\c');
    const cmd = desktopCommand('darwin', 'tap tap: we"ird failed');
    assert.equal(cmd?.args[1], 'display notification "tap tap: we\\"ird failed" with title "cctap"');
  });

  it('builds the tmux display-message argv', () => {
    assert.deepEqual(tmuxCommand('tap tap: a:b is your turn'), {
      cmd: 'tmux',
      args: ['display-message', 'tap tap: a:b is your turn'],
    });
  });

  it('escapes # so tmux cannot expand a branch name as a format', () => {
    // tmux would run #{session_name} and #(command) inside the message text.
    assert.deepEqual(tmuxCommand('tap tap: api:feat#42 is your turn').args, [
      'display-message',
      'tap tap: api:feat##42 is your turn',
    ]);
    assert.deepEqual(tmuxCommand('#{session_name} #(whoami)').args, [
      'display-message',
      '##{session_name} ##(whoami)',
    ]);
  });
});

describe('transition detection', () => {
  it('fires once on the way into an attention state and not while it stays', () => {
    const exec = recordingExec();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now });

    const working = [s({ sessionId: 'a', displayState: 'working' })];
    assert.deepEqual(n.onState(working, labels(working)), []);

    const waiting = [s({ sessionId: 'a', displayState: 'permission_wait', currentTool: 'Bash' })];
    now = 1000;
    const first = n.onState(waiting, labels(waiting));
    assert.equal(first.length, 1);
    assert.equal(first[0]?.text, 'tap tap: authsvc:oauth needs permission (Bash)');
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0]?.cmd, 'osascript');

    now = 60_000;
    assert.deepEqual(n.onState(waiting, labels(waiting)), [], 'no repeat while the state holds');
    assert.equal(exec.calls.length, 1);
  });

  it('never fires for working, compacting or ended', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0 });
    for (const state of ['working', 'compacting', 'ended'] as DisplayState[]) {
      const list = [s({ sessionId: state, displayState: state })];
      assert.deepEqual(n.onState(list, labels(list)), [], state);
    }
    assert.equal(exec.calls.length, 0);
  });

  it('debounces to one per session per five seconds', () => {
    const exec = recordingExec();
    const clock = fakeClock();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now, schedule: clock.schedule, cancel: clock.cancel });
    const turn = [s({ sessionId: 'a', displayState: 'your_turn' })];
    const wait = [s({ sessionId: 'a', displayState: 'permission_wait' })];

    assert.equal(n.onState(turn, labels(turn)).length, 1);
    now = DEBOUNCE_MS - 1;
    assert.equal(n.onState(wait, labels(wait)).length, 0, 'inside the debounce window');
    now = DEBOUNCE_MS - 1;
    assert.equal(n.onState(turn, labels(turn)).length, 0);
    now = DEBOUNCE_MS * 2;
    assert.equal(n.onState(wait, labels(wait)).length, 1, 'past the window');
    assert.equal(exec.calls.length, 2);
    // The window closed with a banner of its own, so the one held back has nothing left
    // to say: it named a state two transitions ago.
    assert.equal(clock.waiting, 0, 'and the held banner was dropped with it');
  });

  /**
   * A question answered inside five seconds is the ordinary shape of working fast, and
   * the session that now wants you back used to show nothing at all for it.
   */
  it('holds a banner that lands inside the window instead of dropping it', () => {
    const exec = recordingExec();
    const clock = fakeClock();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now, schedule: clock.schedule, cancel: clock.cancel });
    const wait = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    const turn = [s({ sessionId: 'a', displayState: 'your_turn' })];

    assert.equal(n.onState(wait, labels(wait)).length, 1, 'the permission banner goes out');
    now = 1200;
    assert.equal(n.onState(turn, labels(turn)).length, 0, 'the answer lands inside the window');
    assert.equal(exec.calls.length, 1, 'nothing extra yet');
    assert.equal(clock.waiting, 1, 'it is waiting out the rest of the window');

    now = DEBOUNCE_MS;
    clock.fire();
    assert.equal(exec.calls.length, 2, 'exactly one deferred banner');
    assert.equal(
      (exec.calls[1]?.args[1] as string).includes('is your turn'),
      true,
      'and it is the turn, not a repeat of the question',
    );
    assert.equal(clock.waiting, 0, 'nothing left pending');
  });

  it('drops a held banner when the session moved on again', () => {
    const exec = recordingExec();
    const clock = fakeClock();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now, schedule: clock.schedule, cancel: clock.cancel });
    const wait = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    const turn = [s({ sessionId: 'a', displayState: 'your_turn' })];
    const working = [s({ sessionId: 'a', displayState: 'working' })];

    n.onState(wait, labels(wait));
    now = 1000;
    n.onState(turn, labels(turn));
    now = 2000;
    n.onState(working, labels(working));
    now = DEBOUNCE_MS;
    clock.fire();
    assert.equal(exec.calls.length, 1, 'the held your_turn never fired, the session is working again');
  });

  it('forgets a held banner along with the session that earned it', () => {
    const exec = recordingExec();
    const clock = fakeClock();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now, schedule: clock.schedule, cancel: clock.cancel });
    const wait = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    const turn = [s({ sessionId: 'a', displayState: 'your_turn' })];

    n.onState(wait, labels(wait));
    now = 1000;
    n.onState(turn, labels(turn));
    assert.equal(clock.waiting, 1);
    n.onState([], new Map());
    assert.equal(clock.waiting, 0, 'a session that ended has no banner owed to it');
    clock.fire();
    assert.equal(exec.calls.length, 1);
  });

  it('debounces per session, not globally', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0 });
    const both = [
      s({ sessionId: 'a', displayState: 'permission_wait' }),
      s({ sessionId: 'b', project: 'blog', branch: 'draft', displayState: 'your_turn' }),
    ];
    assert.equal(n.onState(both, labels(both)).length, 2);
  });

  it('stays quiet for states adopted at startup', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0 });
    const restored = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.seed(restored);
    assert.deepEqual(n.onState(restored, labels(restored)), []);
    assert.equal(exec.calls.length, 0);
  });

  it('honours the per-state toggles', () => {
    const exec = recordingExec();
    const n = new Notifier({
      exec,
      platform: 'darwin',
      now: () => 0,
      toggles: { permission_wait: true, failed: true, your_turn: false },
    });
    const turn = [s({ sessionId: 'a', displayState: 'your_turn' })];
    assert.deepEqual(n.onState(turn, labels(turn)), [], 'your_turn is off');
    const failed = [s({ sessionId: 'b', displayState: 'failed' })];
    assert.equal(n.onState(failed, labels(failed)).length, 1, 'failed is on');
  });

  it('adds a tmux message for sessions living in tmux', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0 });
    const list = [
      s({ sessionId: 'a', displayState: 'permission_wait', terminal: { kind: 'tmux', tmuxPane: '%3' } }),
    ];
    const [dispatch] = n.onState(list, labels(list));
    assert.equal(dispatch?.commands.length, 2);
    assert.deepEqual(exec.calls.map((c) => c.cmd), ['osascript', 'tmux']);
  });

  it('rings the bell instead when the platform has no notifier', () => {
    const exec = recordingExec();
    const rung: string[] = [];
    const n = new Notifier({ exec, platform: 'freebsd', now: () => 0, onBell: (id) => rung.push(id) });
    const list = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    const [dispatch] = n.onState(list, labels(list));
    assert.equal(dispatch?.bell, true);
    assert.deepEqual(rung, ['a']);
    assert.equal(exec.calls.length, 0, 'nothing to exec');
  });

  it('forgets sessions that disappear, so a returning id notifies again', () => {
    const exec = recordingExec();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now });
    const list = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    assert.equal(n.onState(list, labels(list)).length, 1);
    assert.deepEqual(n.onState([], new Map()), []);
    now = 100;
    assert.equal(n.onState(list, labels(list)).length, 1, 'a fresh session is a fresh transition');
  });
});

describe('no storm on startup (QUALITY C5)', () => {
  it('a whole spool replay ending in three attention states fires nothing', () => {
    const exec = recordingExec();
    let now = 0;
    const n = new Notifier({ exec, platform: 'darwin', now: () => now });

    // The daemon applies replayed history while `starting` is true: no onState call.
    // Once it settles it seeds, and only later transitions may speak.
    const replayed = [
      s({ sessionId: 'a', displayState: 'permission_wait' }),
      s({ sessionId: 'b', displayState: 'failed' }),
      s({ sessionId: 'c', displayState: 'your_turn' }),
    ];
    n.seed(replayed);
    now = 10_000;
    assert.deepEqual(n.onState(replayed, labels(replayed)), [], 'restored states are history');
    assert.equal(exec.calls.length, 0);

    // A real transition after startup still speaks.
    const moved = [
      s({ sessionId: 'a', displayState: 'permission_wait' }),
      s({ sessionId: 'b', displayState: 'failed' }),
      s({ sessionId: 'c', displayState: 'permission_wait' }),
    ];
    assert.equal(n.onState(moved, labels(moved)).length, 1, 'only the session that actually moved');
  });

  it('a session that was already waiting before the restart never re-fires', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0 });
    const waiting = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.seed(waiting);
    for (let i = 0; i < 5; i++) assert.deepEqual(n.onState(waiting, labels(waiting)), []);
    assert.equal(exec.calls.length, 0);
  });
});

describe('bell fallback', () => {
  it('rings when the notifier command fails', async () => {
    const rung: string[] = [];
    const exec = recordingExec(() => ({ code: 127, stdout: '', stderr: 'osascript: not found' }));
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0, onBell: (id) => rung.push(id) });
    const list = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.onState(list, labels(list));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rung, ['a'], 'a failed banner falls back to the bell');
  });

  it('does not ring when the notifier succeeds', async () => {
    const rung: string[] = [];
    const exec = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0, onBell: (id) => rung.push(id) });
    const list = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.onState(list, labels(list));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rung, []);
  });

  it('always rings with CCTAP_BELL, banner or not', () => {
    const rung: string[] = [];
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', now: () => 0, alwaysBell: true, onBell: (id) => rung.push(id) });
    const list = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    const [dispatch] = n.onState(list, labels(list));
    assert.equal(dispatch?.bell, true);
    assert.deepEqual(rung, ['a']);
    assert.equal(exec.calls.length, 1, 'the banner still goes out too');
  });

  it('reads the switch from the environment', () => {
    assert.equal(bellAlways({ CCTAP_BELL: '1' }), true);
    assert.equal(bellAlways({}), false);
  });
});

describe('toggle config parsing', () => {
  it('defaults every state on', () => {
    assert.deepEqual(togglesFrom(undefined), { permission_wait: true, failed: true, your_turn: true });
  });

  it('overrides only what config names', () => {
    assert.deepEqual(togglesFrom({ your_turn: false, nonsense: true }), {
      permission_wait: true,
      failed: true,
      your_turn: false,
    });
  });
});

describe('master kill switch', () => {
  it('is on by default and off for every documented spelling', () => {
    assert.equal(notifyEnabled({}), true);
    assert.equal(notifyEnabled({ CCTAP_NOTIFY: 'on' }), true);
    for (const v of ['off', 'OFF', '0', 'false', 'no']) {
      assert.equal(notifyEnabled({ CCTAP_NOTIFY: v }), false, v);
    }
  });
});

/** Out of the box cctap speaks through terminal surfaces only. */
describe('desktop banners are opt in', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('are off until the config says otherwise, and the env still wins', () => {
    assert.equal(bannersOn(undefined, env), false, 'no config at all');
    assert.equal(bannersOn({}, env), false, 'a notify block that never mentions them');
    assert.equal(bannersOn({ enabled: false }, env), false);
    assert.equal(bannersOn({ enabled: true }, env), true);
    assert.equal(bannersOn({ enabled: true }, { CCTAP_NOTIFY: 'off' } as NodeJS.ProcessEnv), false);
  });

  it('build no banner command, and ring nothing, while off', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', desktop: false, now: () => 0 });
    const rung: string[] = [];
    const quiet = new Notifier({
      exec,
      platform: 'darwin',
      desktop: false,
      now: () => 0,
      onBell: (id) => rung.push(id),
    });

    const before = [s({ sessionId: 'a', displayState: 'working' })];
    const after = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.onState(before, labels(before));
    quiet.onState(before, labels(before));
    const out = n.onState(after, labels(after));
    quiet.onState(after, labels(after));

    assert.equal(out.length, 1, 'the transition still happened');
    assert.deepEqual(out[0]?.commands, [], 'nothing to run outside the terminal');
    assert.deepEqual(exec.calls, [], 'osascript was never even constructed');
    assert.equal(out[0]?.bell, false, 'and no bell stands in for the missing banner');
    assert.deepEqual(rung, []);
  });

  it('keep the tmux message, which is a terminal surface', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', desktop: false, now: () => 0 });
    const before = [s({ sessionId: 'a', displayState: 'working', terminal: { kind: 'tmux', tmuxPane: '%1' } })];
    const after = [s({ sessionId: 'a', displayState: 'permission_wait', terminal: { kind: 'tmux', tmuxPane: '%1' } })];
    n.onState(before, labels(before));
    const out = n.onState(after, labels(after));
    assert.deepEqual(out[0]?.commands.map((c) => c.cmd), ['tmux']);
    assert.deepEqual(exec.calls.map((c) => c.cmd), ['tmux']);
  });

  it('dispatch the banner again once enabled', () => {
    const exec = recordingExec();
    const n = new Notifier({ exec, platform: 'darwin', desktop: true, now: () => 0 });
    const before = [s({ sessionId: 'a', displayState: 'working' })];
    const after = [s({ sessionId: 'a', displayState: 'permission_wait' })];
    n.onState(before, labels(before));
    const out = n.onState(after, labels(after));
    assert.deepEqual(out[0]?.commands.map((c) => c.cmd), ['osascript']);
    assert.deepEqual(exec.calls.map((c) => c.cmd), ['osascript']);
  });
});

/**
 * R8 end to end: the reducer decides when a delegated turn is finished, and the
 * notifier must tap exactly once, at that moment, never at the main Stop.
 */
describe('a delegated turn taps once, at tree rest', () => {
  const wire = (m: Model): WireSession[] =>
    Object.values(m.sessions).map((s) => {
      const { deadSince: _d, staleCandidate: _s, ...rest } = s;
      return rest as WireSession;
    });

  /** Feeds events through the real reducer into a real notifier, collecting taps. */
  function run(events: Omit<NormalizedEvent, 'sessionId'>[]): { texts: string[]; states: string[] } {
    const exec = recordingExec();
    // The clock follows the events, the way it does in a daemon: a frozen clock would
    // debounce the second tap away and hide what this test is about.
    let clock = 0;
    const n = new Notifier({ exec, platform: 'darwin', desktop: true, now: () => clock });
    let model = emptyModel();
    const texts: string[] = [];
    const states: string[] = [];
    // Seeded from the first event, so the session's arrival is not itself a transition.
    let seeded = false;
    for (const ev of events) {
      clock = ev.ts;
      model = reduce(model, { ...ev, sessionId: 's1' } as NormalizedEvent);
      const sessions = wire(model);
      if (!seeded) {
        n.seed(sessions);
        seeded = true;
      }
      states.push(sessions[0]?.displayState ?? '?');
      for (const d of n.onState(sessions, labelSessions(sessions))) texts.push(d.text);
    }
    return { texts, states };
  }

  it('says nothing at the main Stop while subagents run, then taps at the last one', () => {
    const { texts, states } = run([
      { ts: 1000, event: 'SessionStart', source: 'startup', cwd: '/repos/authsvc' },
      { ts: 2000, event: 'PreToolUse', toolName: 'Task' },
      { ts: 3000, event: 'SubagentStart', agentId: 'a1' },
      { ts: 4000, event: 'SubagentStart', agentId: 'a2' },
      { ts: 5000, event: 'Stop' },
      { ts: 6000, event: 'SubagentStop', agentId: 'a1' },
      { ts: 7000, event: 'SubagentStop', agentId: 'a2' },
    ]);
    assert.deepEqual(states.slice(4), ['working', 'working', 'your_turn'], 'the tree holds the spinner');
    assert.equal(texts.length, 1, `exactly one tap, got ${JSON.stringify(texts)}`);
    assert.match(texts[0] as string, /is your turn/);
  });

  it('taps once even when a subagent blocked and unblocked along the way', () => {
    const { texts } = run([
      { ts: 1000, event: 'SessionStart', source: 'startup', cwd: '/repos/authsvc' },
      { ts: 2000, event: 'SubagentStart', agentId: 'a1' },
      { ts: 3000, event: 'Stop' },
      { ts: 4000, event: 'Notification', notif: 'permission_prompt', agentId: 'a1', message: 'needs Bash' },
      { ts: 20000, event: 'PermissionDenied', agentId: 'a1' },
      { ts: 40000, event: 'SubagentStop', agentId: 'a1' },
    ]);
    assert.deepEqual(
      texts.map((t) => (t.includes('needs permission') ? 'blocked' : 'your turn')),
      ['blocked', 'your turn'],
      'one tap for the block, one for tree rest, nothing for the main Stop',
    );
  });

  it('taps at true tree rest under a duplicate-stop storm, and not before', () => {
    // The corruption this guards: a repeated SubagentStop used to zero the counter while
    // a2 was still running, firing the tap early and staying silent at the real end.
    const { texts, states } = run([
      { ts: 1000, event: 'SessionStart', source: 'startup', cwd: '/repos/authsvc' },
      { ts: 2000, event: 'SubagentStart', agentId: 'a1' },
      { ts: 3000, event: 'SubagentStart', agentId: 'a2' },
      { ts: 4000, event: 'Stop' },
      { ts: 5000, event: 'SubagentStop', agentId: 'a1' },
      { ts: 6000, event: 'SubagentStop', agentId: 'a1' },
      { ts: 7000, event: 'SubagentStop', agentId: 'a1' },
      { ts: 8000, event: 'SubagentStop', agentId: 'ghost' },
      { ts: 9000, event: 'SubagentStop', agentId: 'a2' },
    ]);
    assert.deepEqual(
      states.slice(3),
      ['working', 'working', 'working', 'working', 'working', 'your_turn'],
      'only the last real stop ends the tree',
    );
    assert.equal(texts.length, 1, `exactly one tap, got ${JSON.stringify(texts)}`);
    assert.match(texts[0] as string, /is your turn/);
  });

  it('says nothing at all when the user interjected while subagents ran', () => {
    const { texts, states } = run([
      { ts: 1000, event: 'SessionStart', source: 'startup', cwd: '/repos/authsvc' },
      { ts: 2000, event: 'SubagentStart', agentId: 'a1' },
      { ts: 3000, event: 'Stop' },
      { ts: 4000, event: 'UserPromptSubmit' },
      { ts: 5000, event: 'SubagentStop', agentId: 'a1' },
    ]);
    assert.equal(states[states.length - 1], 'working');
    assert.deepEqual(texts, [], 'the turn belongs to the new prompt, not to the human');
  });
});
