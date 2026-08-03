/**
 * The eight scenarios required beyond the fixtures (end of spec/transitions.md),
 * table driven. Scenario 7 (label collision) lives in the renderer layer below.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { labelSessions } from '../src/core/labels.js';
import { ENDED_TTL_MS, LIVENESS_GRACE_MS, lowestFreeSlot, markDead, reduce, sweep } from '../src/core/reducer.js';
import { emptyModel, type Model, type NormalizedEvent, type WireSession } from '../src/core/types.js';
import { buildRows, renderTable } from '../src/render/table.js';
import { resolveTheme } from '../src/render/theme.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

let clock = 1000;
function ev(partial: Omit<NormalizedEvent, 'ts'> & { ts?: number }): NormalizedEvent {
  clock += 1000;
  return { ts: partial.ts ?? clock, ...partial } as NormalizedEvent;
}

function run(events: NormalizedEvent[], start: Model = emptyModel()): Model {
  return events.reduce((m, e) => reduce(m, e), start);
}

function display(m: Model, id: string): string | undefined {
  return m.sessions[id]?.displayState;
}

describe('scenario 1: daemon-restart inference (R6)', () => {
  it('creates an inferred session from a mid-stream PreToolUse, then blocks on permission', () => {
    let m = reduce(emptyModel(), { ts: 1000, sessionId: 'x', event: 'PreToolUse', toolName: 'Bash' });
    const s = m.sessions.x;
    assert.ok(s, 'session created');
    assert.equal(s.inferred, true);
    assert.equal(s.displayState, 'working');
    assert.equal(s.currentTool, 'Bash');

    m = reduce(m, { ts: 2000, sessionId: 'x', event: 'Notification', notif: 'permission_prompt', message: 'need it' });
    assert.equal(display(m, 'x'), 'permission_wait');
    assert.equal(m.sessions.x?.attentionKind, 'permission');
    assert.equal(m.sessions.x?.stateSince, 2000);
  });

  it('a real SessionStart clears the inferred flag', () => {
    let m = reduce(emptyModel(), { ts: 1000, sessionId: 'x', event: 'Stop' });
    assert.equal(m.sessions.x?.inferred, true);
    m = reduce(m, { ts: 2000, sessionId: 'x', event: 'SessionStart', source: 'resume', cwd: '/tmp' });
    assert.equal(m.sessions.x?.inferred, undefined);
    assert.equal(m.sessions.x?.sessionSource, 'resume');
  });
});

describe('scenario 2: PermissionDenied clears permission_wait', () => {
  it('main variant returns to working', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'permission_prompt', message: 'm' }),
    ]);
    assert.equal(display(m, 's'), 'permission_wait');
    const after = reduce(m, ev({ sessionId: 's', event: 'PermissionDenied' }));
    assert.equal(display(after, 's'), 'working');
  });

  it('agentId variant unblocks only that subagent and never touches main (R1)', () => {
    let m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'permission_prompt', message: 'main is blocked' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'permission_prompt', agentId: 'a1', message: 'sub blocked' }),
    ]);
    assert.deepEqual(m.sessions.s?.subagents.blocked, ['a1']);
    m = reduce(m, ev({ sessionId: 's', event: 'PermissionDenied', agentId: 'a1' }));
    assert.deepEqual(m.sessions.s?.subagents.blocked, []);
    // main was permission_wait before and must stay it.
    assert.equal(m.sessions.s?.state, 'permission_wait');
    assert.equal(display(m, 's'), 'permission_wait');
  });
});

describe('scenario 3: compact cycle', () => {
  it('PreCompact then PostCompact returns to working', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'PreCompact' }),
    ]);
    assert.equal(display(m, 's'), 'compacting');
    const after = reduce(m, ev({ sessionId: 's', event: 'PostCompact' }));
    assert.equal(display(after, 's'), 'working');
  });

  it('PreCompact then SessionStart(source=compact) returns to working', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'PreCompact' }),
      ev({ sessionId: 's', event: 'SessionStart', source: 'compact', cwd: '/r' }),
    ]);
    assert.equal(display(m, 's'), 'working');
    assert.equal(m.sessions.s?.sessionSource, 'compact');
  });
});

describe('scenario 4: SubagentStop clears a blocked agent', () => {
  it('drops the agent from blocked and decrements the count', () => {
    let m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'SubagentStart', agentId: 'a1' }),
      ev({ sessionId: 's', event: 'SubagentStart', agentId: 'a2' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'permission_prompt', agentId: 'a1', message: 'x' }),
    ]);
    assert.equal(m.sessions.s?.subagents.active, 2);
    assert.equal(display(m, 's'), 'permission_wait');

    m = reduce(m, ev({ sessionId: 's', event: 'SubagentStop', agentId: 'a1' }));
    assert.deepEqual(m.sessions.s?.subagents.blocked, []);
    assert.equal(m.sessions.s?.subagents.active, 1);
    assert.equal(display(m, 's'), 'working');
  });

  it('the subagent count never goes below zero', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'SubagentStop', agentId: 'a9' }),
      ev({ sessionId: 's', event: 'SubagentStop', agentId: 'a8' }),
    ]);
    assert.equal(m.sessions.s?.subagents.active, 0);
  });
});

describe('scenario 5: SessionEnd and the ended sweep', () => {
  it('ends, survives earlier sweeps, disappears after five minutes', () => {
    const m = run([
      { ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' },
      { ts: 2000, sessionId: 's', event: 'SessionEnd', reason: 'logout' },
    ]);
    assert.equal(display(m, 's'), 'ended');
    assert.equal(m.sessions.s?.endedReason, 'logout');

    const early = sweep(m, 2000 + ENDED_TTL_MS - 1);
    assert.ok(early.sessions.s, 'still listed one millisecond early');
    assert.equal(early, m, 'an unchanged sweep returns the same model reference');

    const late = sweep(m, 2000 + ENDED_TTL_MS);
    assert.equal(late.sessions.s, undefined, 'removed at the five minute mark');
  });

  it('a dead parent pid removes the session after the grace period', () => {
    let m = run([{ ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }]);
    m = markDead(m, 's', 5000);
    assert.ok(sweep(m, 5000 + LIVENESS_GRACE_MS - 1).sessions.s, 'inside the grace period');
    assert.equal(sweep(m, 5000 + LIVENESS_GRACE_MS).sessions.s, undefined, 'gone after the grace period');
  });
});

describe('scenario 6: unknown and idempotent input (R7)', () => {
  const base = run([
    { ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' },
    { ts: 2000, sessionId: 's', event: 'PreToolUse', toolName: 'Bash' },
  ]);

  it('an unknown event name changes nothing but lastEventTs', () => {
    const after = reduce(base, { ts: 3000, sessionId: 's', event: 'TeammateIdle' });
    assert.equal(display(after, 's'), 'working');
    assert.equal(after.sessions.s?.currentTool, 'Bash');
    assert.equal(after.sessions.s?.lastEventTs, 3000);
    assert.equal(after.sessions.s?.stateSince, base.sessions.s?.stateSince);
  });

  it('an unknown event for an unknown session creates nothing', () => {
    const after = reduce(base, { ts: 3000, sessionId: 'ghost', event: 'WorktreeCreate' });
    assert.equal(after, base, 'model reference is untouched');
    assert.equal(after.sessions.ghost, undefined);
  });

  it('an unknown notif value is a no-op', () => {
    const after = reduce(base, { ts: 3000, sessionId: 's', event: 'Notification', notif: 'made_up' });
    assert.equal(display(after, 's'), 'working');
  });

  it('a double Stop is harmless and keeps the first stateSince', () => {
    const first = reduce(base, { ts: 3000, sessionId: 's', event: 'Stop' });
    const second = reduce(first, { ts: 4000, sessionId: 's', event: 'Stop' });
    assert.equal(display(second, 's'), 'your_turn');
    assert.equal(second.sessions.s?.stateSince, 3000);
    assert.equal(second.sessions.s?.currentTool, undefined);
  });

  it('PostCompact while working is a no-op', () => {
    const after = reduce(base, { ts: 3000, sessionId: 's', event: 'PostCompact' });
    assert.equal(display(after, 's'), 'working');
  });
});

describe('elicitation rows (ruling 2026-08-02)', () => {
  it('elicitation_response with an agentId unblocks that subagent', () => {
    let m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'SubagentStart', agentId: 'a1' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_dialog', agentId: 'a1', message: 'q?' }),
    ]);
    assert.equal(display(m, 's'), 'permission_wait');
    m = reduce(m, ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_response', agentId: 'a1' }));
    assert.deepEqual(m.sessions.s?.subagents.blocked, []);
    assert.equal(display(m, 's'), 'working');
    assert.equal(m.sessions.s?.state, 'working', 'main was never touched by the agent event');
    assert.equal(m.sessions.s?.subagents.active, 1, 'the subagent is still running');
  });

  it('elicitation_complete behaves exactly like elicitation_response on main', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_dialog', message: 'q?' }),
    ]);
    assert.equal(display(m, 's'), 'permission_wait');
    const done = reduce(m, ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_complete' }));
    assert.equal(display(done, 's'), 'working');
  });

  it('elicitation_complete with an agentId unblocks that subagent', () => {
    let m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_dialog', agentId: 'a2', message: 'q?' }),
    ]);
    assert.equal(display(m, 's'), 'permission_wait');
    m = reduce(m, ev({ sessionId: 's', event: 'Notification', notif: 'elicitation_complete', agentId: 'a2' }));
    assert.deepEqual(m.sessions.s?.subagents.blocked, []);
    assert.equal(display(m, 's'), 'working');
  });

  it('neither clears a main permission_wait that came from a real permission prompt', () => {
    const m = run([
      ev({ sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }),
      ev({ sessionId: 's', event: 'Notification', notif: 'permission_prompt', message: 'need bash' }),
    ]);
    for (const notif of ['elicitation_response', 'elicitation_complete']) {
      const after = reduce(m, ev({ sessionId: 's', event: 'Notification', notif }));
      assert.equal(display(after, 's'), 'permission_wait', `${notif} must not clear a permission prompt`);
    }
  });
});

describe('scenario 7: label collision (renderer layer)', () => {
  const mk = (id: string, start: number): WireSession => ({
    sessionId: id,
    slot: start / 1000,
    project: 'authsvc',
    branch: 'main',
    cwd: '/repos/authsvc',
    transcriptPath: '',
    sessionSource: 'startup',
    state: 'working',
    displayState: 'working',
    stateSince: start,
    lastEventTs: start,
    sessionStart: start,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal: { kind: 'unknown' },
    ppid: 0,
  });

  it('gives two sessions on the same project:branch distinct labels', () => {
    const sessions = [mk('a3f9c1', 1000), mk('b7e220', 2000)];
    const labels = labelSessions(sessions);
    assert.equal(labels.get('a3f9c1'), 'authsvc:main·a3f');
    assert.equal(labels.get('b7e220'), 'authsvc:main·b7e');
    assert.notEqual(labels.get('a3f9c1'), labels.get('b7e220'));
  });

  it('leaves a unique label alone', () => {
    const labels = labelSessions([mk('a3f9c1', 1000)]);
    assert.equal(labels.get('a3f9c1'), 'authsvc:main');
  });

  it('renders both rows distinctly (golden)', () => {
    const sessions = [mk('a3f9c1', 1000), mk('b7e220', 2000)];
    const rows = buildRows(sessions, 1000, resolveTheme({ CCTAP_THEME: 'ascii' } as NodeJS.ProcessEnv));
    // The spinner phase is per session, so pin the shape and not the frame.
    const shape = renderTable(rows).map((l) => l.replace(/[/\\-]/, '*'));
    assert.deepEqual(shape, ['1  *  authsvc:main/a3f  working  0s', '2  *  authsvc:main/b7e  working  0s']);
  });
});

describe('scenario 8: auth_success is a no-op', () => {
  it('does not appear in the table, so it cannot change state', () => {
    const before = run([
      { ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' },
      { ts: 2000, sessionId: 's', event: 'Notification', notif: 'permission_prompt', message: 'blocked' },
    ]);
    const after = reduce(before, { ts: 3000, sessionId: 's', event: 'Notification', notif: 'auth_success' });
    assert.equal(display(after, 's'), 'permission_wait');
    assert.equal(after.sessions.s?.attentionKind, 'permission');
    assert.equal(after.sessions.s?.stateSince, 2000);
  });
});

describe('reducer purity (I10)', () => {
  it('never mutates the input model', () => {
    const before = run([{ ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' }]);
    const frozen = JSON.stringify(before);
    reduce(before, { ts: 2000, sessionId: 's', event: 'Notification', notif: 'permission_prompt', message: 'x' });
    reduce(before, { ts: 3000, sessionId: 's', event: 'SubagentStart', agentId: 'a1' });
    sweep(before, 10_000_000);
    assert.equal(JSON.stringify(before), frozen);
  });

  it('produces the same result for the same input', () => {
    const events: NormalizedEvent[] = [
      { ts: 1000, sessionId: 's', event: 'SessionStart', source: 'startup', cwd: '/r' },
      { ts: 2000, sessionId: 's', event: 'SubagentStart', agentId: 'a1' },
      { ts: 3000, sessionId: 's', event: 'Notification', notif: 'permission_prompt', agentId: 'a1', message: 'x' },
      { ts: 4000, sessionId: 's', event: 'Stop' },
    ];
    assert.deepEqual(run(events), run(events));
  });
});


/** The number is the jump handle, so it has to be stable and dense. */
describe('slots', () => {
  const ev = (sessionId: string, ts: number): NormalizedEvent =>
    ({ ts, sessionId, event: 'SessionStart', source: 'startup', cwd: '/r' }) as NormalizedEvent;

  it('hands out the lowest free positive integer', () => {
    let m = emptyModel();
    for (const [i, id] of ['a', 'b', 'c'].entries()) m = reduce(m, ev(id, 1000 * (i + 1)));
    assert.deepEqual(
      Object.values(m.sessions).map((s) => [s.sessionId, s.slot]),
      [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ],
    );
    assert.equal(lowestFreeSlot(m), 4);
  });

  it('holds a slot for the life of the session, through every kind of churn', () => {
    let m = reduce(emptyModel(), ev('a', 1000));
    m = reduce(m, ev('b', 2000));
    const before = m.sessions.b?.slot;
    for (const e of [
      { ts: 3000, sessionId: 'b', event: 'CwdChanged', cwd: '/elsewhere' },
      { ts: 4000, sessionId: 'b', event: 'Notification', notif: 'permission_prompt', message: 'x' },
      { ts: 5000, sessionId: 'b', event: 'UserPromptSubmit' },
      { ts: 6000, sessionId: 'b', event: 'Stop' },
      { ts: 7000, sessionId: 'b', event: 'PreCompact' },
      { ts: 8000, sessionId: 'b', event: 'PostCompact' },
    ] as NormalizedEvent[]) {
      m = reduce(m, e);
      assert.equal(m.sessions.b?.slot, before, `${e.event} moved the slot`);
    }
    // A re-seen session id keeps its record, and therefore its number.
    m = reduce(m, ev('b', 9000));
    assert.equal(m.sessions.b?.slot, before);
  });

  it('frees a slot only when the record drops, and hands it to the next session', () => {
    let m = emptyModel();
    for (const [i, id] of ['a', 'b', 'c'].entries()) m = reduce(m, ev(id, 1000 * (i + 1)));
    m = reduce(m, { ts: 4000, sessionId: 'b', event: 'SessionEnd', reason: 'other' } as NormalizedEvent);
    assert.equal(m.sessions.b?.slot, 2, 'an ended session still holds its number');

    m = sweep(m, 4000 + ENDED_TTL_MS + 1);
    assert.equal(m.sessions.b, undefined, 'the record is gone');
    m = reduce(m, ev('d', 9000));
    assert.equal(m.sessions.d?.slot, 2, 'the freed number is the lowest one available');
    assert.equal(m.sessions.a?.slot, 1, 'the survivors keep theirs');
    assert.equal(m.sessions.c?.slot, 3);
  });
});
