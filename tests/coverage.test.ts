/**
 * QUALITY A2: every row of the spec/transitions.md event table gets an explicit case.
 * The table below is the spec table transcribed; the test walks it, so a new row in the
 * spec that nobody implements shows up here as a missing case rather than as silence.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { reduce } from '../src/core/reducer.js';
import { emptyModel, type DisplayState, type Model, type NormalizedEvent } from '../src/core/types.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

interface Row {
  /** The spec table row, verbatim enough to grep for. */
  row: string;
  /** Events applied before the row's own event. */
  setup?: Omit<NormalizedEvent, 'ts' | 'sessionId'>[];
  event: Omit<NormalizedEvent, 'ts' | 'sessionId'>;
  expect: DisplayState;
  /** Extra assertions on the resulting session. */
  check?: (m: Model) => void;
}

const START: Omit<NormalizedEvent, 'ts' | 'sessionId'> = {
  event: 'SessionStart',
  source: 'startup',
  cwd: '/repos/x',
};
const WAIT: Omit<NormalizedEvent, 'ts' | 'sessionId'> = {
  event: 'Notification',
  notif: 'permission_prompt',
  message: 'need it',
};

const ROWS: Row[] = [
  {
    row: 'SessionStart (any source)',
    event: START,
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.sessionSource, 'startup'),
  },
  {
    row: 'SessionStart source=compact ends compacting',
    setup: [START, { event: 'PreCompact' }],
    event: { event: 'SessionStart', source: 'compact', cwd: '/repos/x' },
    expect: 'working',
  },
  {
    row: 'UserPromptSubmit (R3)',
    setup: [START, WAIT],
    event: { event: 'UserPromptSubmit' },
    expect: 'working',
    check: (m) => {
      assert.deepEqual(m.sessions.s?.subagents.blocked, []);
      assert.equal(m.sessions.s?.attentionKind, undefined);
    },
  },
  {
    row: 'PreToolUse (R4)',
    setup: [START, WAIT],
    event: { event: 'PreToolUse', toolName: 'Bash' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.currentTool, 'Bash'),
  },
  {
    row: 'PreToolUse + agentId (R1 unblock)',
    setup: [START, { ...WAIT, agentId: 'a1' }],
    event: { event: 'PreToolUse', agentId: 'a1', toolName: 'Read' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.currentTool, undefined, 'an agent tool is not the main tool'),
  },
  {
    row: 'PermissionDenied',
    setup: [START, WAIT],
    event: { event: 'PermissionDenied' },
    expect: 'working',
  },
  {
    row: 'PermissionDenied + agentId (R1 unblock)',
    setup: [START, { ...WAIT, agentId: 'a1' }],
    event: { event: 'PermissionDenied', agentId: 'a1' },
    expect: 'working',
  },
  {
    row: 'Notification permission_prompt',
    setup: [START],
    event: WAIT,
    expect: 'permission_wait',
    check: (m) => {
      assert.equal(m.sessions.s?.attentionKind, 'permission');
      assert.equal(m.sessions.s?.lastMessage, 'need it');
    },
  },
  {
    row: 'Notification permission_prompt + agentId (R1 block)',
    setup: [START],
    event: { ...WAIT, agentId: 'a1' },
    expect: 'permission_wait',
    check: (m) => {
      assert.deepEqual(m.sessions.s?.subagents.blocked, ['a1']);
      assert.equal(m.sessions.s?.state, 'working', 'main untouched');
    },
  },
  {
    row: 'Notification agent_needs_input',
    setup: [START],
    event: { event: 'Notification', notif: 'agent_needs_input', message: 'input?' },
    expect: 'permission_wait',
    check: (m) => assert.equal(m.sessions.s?.attentionKind, 'agent_needs_input'),
  },
  {
    row: 'Notification agent_needs_input + agentId',
    setup: [START],
    event: { event: 'Notification', notif: 'agent_needs_input', agentId: 'a1' },
    expect: 'permission_wait',
    check: (m) => assert.deepEqual(m.sessions.s?.subagents.blocked, ['a1']),
  },
  {
    row: 'Notification elicitation_dialog',
    setup: [START],
    event: { event: 'Notification', notif: 'elicitation_dialog', message: 'q?' },
    expect: 'permission_wait',
    check: (m) => assert.equal(m.sessions.s?.attentionKind, 'elicitation'),
  },
  {
    row: 'Notification elicitation_dialog + agentId',
    setup: [START],
    event: { event: 'Notification', notif: 'elicitation_dialog', agentId: 'a1' },
    expect: 'permission_wait',
    check: (m) => assert.deepEqual(m.sessions.s?.subagents.blocked, ['a1']),
  },
  {
    row: 'Notification elicitation_response',
    setup: [START, { event: 'Notification', notif: 'elicitation_dialog', message: 'q?' }],
    event: { event: 'Notification', notif: 'elicitation_response' },
    expect: 'working',
  },
  {
    row: 'Notification elicitation_response + agentId (ruling)',
    setup: [START, { event: 'Notification', notif: 'elicitation_dialog', agentId: 'a1' }],
    event: { event: 'Notification', notif: 'elicitation_response', agentId: 'a1' },
    expect: 'working',
  },
  {
    row: 'Notification elicitation_complete (ruling)',
    setup: [START, { event: 'Notification', notif: 'elicitation_dialog', message: 'q?' }],
    event: { event: 'Notification', notif: 'elicitation_complete' },
    expect: 'working',
  },
  {
    row: 'Notification elicitation_complete + agentId (ruling)',
    setup: [START, { event: 'Notification', notif: 'elicitation_dialog', agentId: 'a1' }],
    event: { event: 'Notification', notif: 'elicitation_complete', agentId: 'a1' },
    expect: 'working',
  },
  {
    row: 'Notification idle_prompt (R2 upgrade)',
    setup: [START],
    event: { event: 'Notification', notif: 'idle_prompt' },
    expect: 'your_turn',
    check: (m) => assert.equal(m.sessions.s?.attentionKind, 'idle'),
  },
  {
    row: 'Notification idle_prompt never downgrades (R2)',
    setup: [START, WAIT],
    event: { event: 'Notification', notif: 'idle_prompt' },
    expect: 'permission_wait',
  },
  {
    row: 'Notification agent_completed (R2 upgrade)',
    setup: [START],
    event: { event: 'Notification', notif: 'agent_completed' },
    expect: 'your_turn',
    check: (m) => assert.equal(m.sessions.s?.attentionKind, 'agent_completed'),
  },
  {
    row: 'Stop (R5)',
    setup: [START, { event: 'PreToolUse', toolName: 'Bash' }],
    event: { event: 'Stop' },
    expect: 'your_turn',
    check: (m) => {
      assert.deepEqual(m.sessions.s?.subagents, { active: 0, running: [], anonymous: 0, blocked: [] });
      assert.equal(m.sessions.s?.currentTool, undefined);
    },
  },
  {
    row: 'R8 Stop with a blocked subagent keeps permission_wait',
    setup: [START, { event: 'PreToolUse', toolName: 'Bash' }, { ...WAIT, agentId: 'a1' }],
    event: { event: 'Stop' },
    expect: 'permission_wait',
    check: (m) => {
      // R5 no longer wipes the tree: that subagent is still waiting on a human.
      assert.deepEqual(m.sessions.s?.subagents.blocked, ['a1']);
      assert.equal(m.sessions.s?.state, 'your_turn', 'main did end');
    },
  },
  {
    row: 'R8 Stop with a running subagent shows working',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }],
    event: { event: 'Stop' },
    expect: 'working',
    check: (m) => {
      assert.equal(m.sessions.s?.subagents.active, 1, 'the count survives the turn boundary');
      assert.equal(m.sessions.s?.state, 'your_turn', 'main state is untouched by the derivation');
    },
  },
  {
    row: 'R8 the last SubagentStop after a main Stop reveals your_turn',
    setup: [
      START,
      { event: 'SubagentStart', agentId: 'a1' },
      { event: 'SubagentStart', agentId: 'a2' },
      { event: 'Stop' },
      { event: 'SubagentStop', agentId: 'a1' },
    ],
    event: { event: 'SubagentStop', agentId: 'a2' },
    expect: 'your_turn',
    check: (m) => assert.equal(m.sessions.s?.subagents.active, 0),
  },
  {
    row: 'R8 an interjection means the last SubagentStop is not your turn',
    setup: [
      START,
      { event: 'SubagentStart', agentId: 'a1' },
      { event: 'Stop' },
      { event: 'UserPromptSubmit' },
    ],
    event: { event: 'SubagentStop', agentId: 'a1' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.state, 'working'),
  },
  {
    row: 'R8 failed outranks running subagents, blocked outranks failed',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }],
    event: { event: 'StopFailure', message: 'rate_limit' },
    expect: 'failed',
    check: (m) => {
      const after = reduce(m, {
        ts: 9000,
        sessionId: 's',
        event: 'Notification',
        notif: 'permission_prompt',
        agentId: 'a1',
      } as NormalizedEvent);
      assert.equal(after.sessions.s?.displayState, 'permission_wait', 'a blocked subagent wins');
    },
  },
  {
    row: 'R1 a duplicate SubagentStop is a no-op, not a second decrement',
    setup: [
      START,
      { event: 'SubagentStart', agentId: 'a1' },
      { event: 'SubagentStart', agentId: 'a2' },
      { event: 'Stop' },
      { event: 'SubagentStop', agentId: 'a1' },
    ],
    event: { event: 'SubagentStop', agentId: 'a1' },
    expect: 'working',
    check: (m) => {
      assert.deepEqual(m.sessions.s?.subagents.running, ['a2'], 'a2 is still running');
      assert.equal(m.sessions.s?.subagents.active, 1);
    },
  },
  {
    row: 'R1 a SubagentStop for an id that never started is a no-op',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }, { event: 'Stop' }],
    event: { event: 'SubagentStop', agentId: 'ghost' },
    expect: 'working',
    check: (m) => assert.deepEqual(m.sessions.s?.subagents.running, ['a1']),
  },
  {
    row: 'R1 a duplicate SubagentStart is a no-op, so the tree still reaches rest',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }, { event: 'SubagentStart', agentId: 'a1' }],
    event: { event: 'Stop' },
    expect: 'working',
    check: (m) => {
      assert.equal(m.sessions.s?.subagents.active, 1, 'counted once');
      const rest = reduce(m, { ts: 9000, sessionId: 's', event: 'SubagentStop', agentId: 'a1' } as NormalizedEvent);
      assert.equal(rest.sessions.s?.displayState, 'your_turn', 'and one stop ends it');
    },
  },
  {
    row: 'R1 events with no agentId keep their own counter',
    setup: [START, { event: 'SubagentStart' }, { event: 'SubagentStart' }],
    event: { event: 'SubagentStop' },
    expect: 'working',
    check: (m) => {
      assert.equal(m.sessions.s?.subagents.anonymous, 1);
      assert.deepEqual(m.sessions.s?.subagents.running, [], 'nothing to identify, nothing in the set');
      assert.equal(m.sessions.s?.subagents.active, 1);
    },
  },
  {
    row: 'R8 SessionEnd is ended whatever the counts say',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }, { event: 'Stop' }],
    event: { event: 'SessionEnd', reason: 'other' },
    expect: 'ended',
    check: (m) => assert.equal(m.sessions.s?.subagents.active, 1, 'counts are irrelevant once ended'),
  },
  {
    row: 'StopFailure (R5)',
    setup: [START],
    event: { event: 'StopFailure', message: 'rate_limit' },
    expect: 'failed',
    check: (m) => assert.equal(m.sessions.s?.lastMessage, 'rate_limit'),
  },
  {
    row: 'SubagentStart',
    setup: [START],
    event: { event: 'SubagentStart', agentId: 'a1' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.subagents.active, 1),
  },
  {
    row: 'SubagentStop (+ agentId)',
    setup: [START, { event: 'SubagentStart', agentId: 'a1' }, { ...WAIT, agentId: 'a1' }],
    event: { event: 'SubagentStop', agentId: 'a1' },
    expect: 'working',
    check: (m) => {
      assert.equal(m.sessions.s?.subagents.active, 0);
      assert.deepEqual(m.sessions.s?.subagents.blocked, []);
    },
  },
  {
    row: 'PreCompact',
    setup: [START],
    event: { event: 'PreCompact' },
    expect: 'compacting',
  },
  {
    row: 'PostCompact',
    setup: [START, { event: 'PreCompact' }],
    event: { event: 'PostCompact' },
    expect: 'working',
  },
  {
    row: 'CwdChanged',
    setup: [START],
    event: { event: 'CwdChanged', cwd: '/repos/other' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.cwd, '/repos/other'),
  },
  {
    row: 'SessionEnd',
    setup: [START],
    event: { event: 'SessionEnd', reason: 'other' },
    expect: 'ended',
    check: (m) => assert.equal(m.sessions.s?.endedReason, 'other'),
  },
  {
    row: 'R9 a late Stop cannot resurrect an ended session',
    setup: [START, { event: 'SessionEnd', reason: 'other' }],
    event: { event: 'Stop' },
    expect: 'ended',
    check: (m) => {
      assert.equal(m.sessions.s?.state, 'ended');
      assert.equal(m.sessions.s?.endedReason, 'other', 'and it is still the same ended session');
    },
  },
  {
    row: 'R9 no main event revives an ended session',
    setup: [START, { event: 'SessionEnd', reason: 'other' }, { event: 'UserPromptSubmit' }],
    event: { event: 'PreToolUse', toolName: 'Bash' },
    expect: 'ended',
    check: (m) => assert.equal(m.sessions.s?.currentTool, undefined, 'nothing was applied'),
  },
  {
    row: 'R9 SessionStart revives it, and clears the ended reason',
    setup: [START, { event: 'SessionEnd', reason: 'other' }],
    event: { event: 'SessionStart', source: 'resume', cwd: '/repos/x' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.endedReason, undefined),
  },
  {
    row: 'R5 a failure with no information borrows no old message',
    setup: [
      START,
      { event: 'Notification', notif: 'permission_prompt', message: 'may I run rm' },
      { event: 'UserPromptSubmit' },
    ],
    event: { event: 'StopFailure' },
    expect: 'failed',
    check: (m) => assert.equal(m.sessions.s?.lastMessage, undefined, 'no stale permission text'),
  },
  {
    row: 'R3 a new prompt drops the message the old turn left behind',
    setup: [START, { event: 'Notification', notif: 'permission_prompt', message: 'may I run rm' }],
    event: { event: 'UserPromptSubmit' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.lastMessage, undefined),
  },
  {
    row: 'R6 unknown session creates it inferred',
    event: { event: 'PreToolUse', toolName: 'Bash' },
    expect: 'working',
    check: (m) => assert.equal(m.sessions.s?.inferred, true),
  },
  {
    row: 'R7 unknown notif is a no-op',
    setup: [START, WAIT],
    event: { event: 'Notification', notif: 'auth_success' },
    expect: 'permission_wait',
  },
  {
    row: 'R7 unknown event name is a no-op',
    setup: [START, WAIT],
    event: { event: 'InstructionsLoaded' },
    expect: 'permission_wait',
  },
];

describe('event table coverage (QUALITY A2)', () => {
  it('covers every row of the spec/transitions.md table', () => {
    // Bumping this number means the spec table grew and a row above is missing.
    assert.equal(ROWS.length, 46);
  });

  for (const row of ROWS) {
    it(row.row, () => {
      let m = emptyModel();
      let ts = 1000;
      for (const e of row.setup ?? []) {
        m = reduce(m, { ...e, ts, sessionId: 's' } as NormalizedEvent);
        ts += 1000;
      }
      m = reduce(m, { ...row.event, ts, sessionId: 's' } as NormalizedEvent);
      assert.equal(m.sessions.s?.displayState, row.expect, row.row);
      row.check?.(m);
    });
  }
});
