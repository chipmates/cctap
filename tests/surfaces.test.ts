/**
 * The two live surfaces: what they show when the daemon link drops, what they do with a
 * terminal too small for the board, and what "reduced motion" costs a frame. Pure render
 * seams throughout, so none of it needs a pty.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sgr, stripAnsi, visibleWidth } from '../src/ansi.js';
import { linkChanged, livePaneFrame, STALE_MARK, type PaneBoard } from '../src/commands/strip.js';
import { terminalSize, topFrame } from '../src/commands/top.js';
import type { DisplayState, WireSession } from '../src/core/types.js';
import { buildRows, clampVisible, renderTable } from '../src/render/table.js';
import { resolveTheme } from '../src/render/theme.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const UNI = resolveTheme({ CCTAP_THEME: 'unicode' } as NodeJS.ProcessEnv);
const ASCII = resolveTheme({ TERM: 'vt100' } as NodeJS.ProcessEnv);
const NOW = 65_000;

let seq = 0;
function s(over: Partial<WireSession> & { project: string; branch: string; displayState: DisplayState }): WireSession {
  seq += 1;
  return {
    sessionId: `id${seq}`,
    slot: seq,
    cwd: '',
    transcriptPath: '',
    sessionSource: 'startup',
    state: over.displayState,
    stateSince: 1000,
    lastEventTs: 1000,
    sessionStart: seq,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal: { kind: 'unknown' },
    ppid: 0,
    ...over,
  };
}

/** One session is blocked on a permission prompt: the case that must never look calm. */
function blockedBoard(): WireSession[] {
  return [
    s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'working' }),
    s({ slot: 2, project: 'authsvc', branch: 'oauth', displayState: 'permission_wait' }),
    s({ slot: 3, project: 'blog', branch: 'draft', displayState: 'your_turn' }),
  ];
}

function paneText(board: PaneBoard, width = 80, theme = UNI): string {
  return livePaneFrame(board, { width, rows: 1, theme, frame: 0 }).lines.join('\n');
}

describe('a live pane that loses its daemon', () => {
  it('keeps the blocked board on screen and marks it unknown', () => {
    const up: PaneBoard = { sessions: blockedBoard(), stale: false };
    assert.match(paneText(up), /authsvc:oauth/);

    const down = linkChanged(up, false);
    // The board itself is untouched: nothing was discarded on the way down.
    assert.deepEqual(down.sessions, up.sessions);
    assert.equal(down.stale, true);

    const text = paneText(down);
    // The marker costs the labels their tails at this width; the entry itself stays.
    assert.match(text, /2 authsvc/, 'the session waiting on a human is still drawn');
    assert.match(text, /!!/, 'and it still carries its permission glyph');
    assert.ok(text.includes(STALE_MARK), `expected the staleness marker in: ${text}`);
    assert.equal(text.includes('waiting for sessions'), false, 'a dropped link is not an idle board');
  });

  it('says the state is unknown rather than idle when it knows of nothing', () => {
    assert.match(paneText({ sessions: [], stale: false }), /waiting for sessions/);
    const text = paneText({ sessions: [], stale: true });
    assert.ok(text.includes(STALE_MARK), text);
    assert.equal(text.includes('waiting for sessions'), false);
  });

  it('drops the mark when the link returns, and a fresh state replaces the board', () => {
    const down: PaneBoard = { sessions: blockedBoard(), stale: true };
    const back = linkChanged(down, true);
    assert.equal(back.stale, false);
    assert.equal(paneText(back).includes(STALE_MARK), false);
  });

  it('marks the board without ever pushing it past the pane width', () => {
    for (let width = 20; width <= 120; width += 1) {
      const frame = livePaneFrame({ sessions: blockedBoard(), stale: true }, { width, rows: 1, theme: UNI, frame: 0 });
      for (const line of frame.lines) {
        assert.ok(visibleWidth(line) <= width, `width ${width} overflowed: ${JSON.stringify(line)}`);
      }
      // The board is the load-bearing half: whatever else the ladder drops, the pane
      // still says a session is blocked.
      assert.match(stripAnsi(frame.lines[0] ?? ''), /!!/, `the blocked session vanished at width ${width}`);
    }
  });

  it('keeps the notice beside the mark', () => {
    const frame = livePaneFrame(
      { sessions: blockedBoard(), stale: true },
      { width: 140, rows: 1, theme: UNI, frame: 0, notice: 'jumping to blog:draft...' },
    );
    const text = frame.lines.join('\n');
    assert.ok(text.includes(STALE_MARK), text);
    assert.match(text, /jumping to blog:draft/);
    assert.match(text, /blog:draft ▲ your turn/, 'and a pane this wide keeps its whole board');
    assert.ok(visibleWidth(frame.lines[0] ?? '') <= 140);
  });
});

describe('top clamped to the viewport', () => {
  const many: WireSession[] = [];
  for (let i = 0; i < 30; i++) {
    many.push(
      s({
        slot: i + 1,
        project: `proj${String(i).padStart(2, '0')}`,
        branch: 'feature-branch',
        displayState: i === 17 ? 'permission_wait' : 'working',
      }),
    );
  }

  it('draws 30 sessions on a 20 by 40 terminal as exactly one screen', () => {
    const lines = topFrame(many, { now: NOW, rows: 20, cols: 40, theme: ASCII });
    assert.equal(lines.length, 20, 'one screen, and it fills it');
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 40, `line wider than the terminal: ${JSON.stringify(line)}`);
    }
    const more = lines.filter((l) => /\+\d+ more/.test(stripAnsi(l)));
    assert.equal(more.length, 1, 'one line accounts for everything cut');
    const hidden = Number(/\+(\d+) more/.exec(stripAnsi(more[0] ?? ''))?.[1]);
    const shown = lines.filter((l) => /^[>* ] \d/.test(stripAnsi(l))).length;
    assert.equal(hidden + shown, 30);
  });

  it('never exceeds the terminal at any size a terminal can be', () => {
    for (const rows of [3, 5, 6, 8, 12, 24, 60]) {
      for (const cols of [20, 40, 80, 200]) {
        const lines = topFrame(many, { now: NOW, rows, cols, theme: ASCII, selected: 17 });
        assert.ok(lines.length <= rows, `${cols}x${rows} produced ${lines.length} lines`);
        for (const line of lines) assert.ok(visibleWidth(line) <= cols, `${cols}x${rows}: ${JSON.stringify(line)}`);
      }
    }
  });

  it('slides the window so the selection stays on screen', () => {
    const rows = buildRows(many, NOW, ASCII);
    for (const selected of [0, 7, 17, 29]) {
      const lines = topFrame(many, { now: NOW, rows: 20, cols: 60, theme: ASCII, selected });
      const cursor = lines.filter((l) => stripAnsi(l).startsWith('> '));
      assert.equal(cursor.length, 1, `selection ${selected} lost its row`);
      assert.match(stripAnsi(cursor[0] ?? ''), new RegExp(rows[selected]?.label ?? 'never'));
    }
  });

  it('keeps the daemon marker on a terminal too short for the key legend', () => {
    const lines = topFrame(many, { now: NOW, rows: 6, cols: 40, theme: ASCII, stale: true });
    assert.equal(lines.length, 6);
    assert.ok(lines.some((l) => stripAnsi(l).includes(STALE_MARK)), lines.join('\n'));
    assert.equal(
      lines.some((l) => stripAnsi(l).includes('q quit')),
      false,
      'the legend yields before the news does',
    );
  });

  it('marks a stale board in the same words the strip uses', () => {
    const lines = topFrame(blockedBoard(), { now: NOW, rows: 24, cols: 80, theme: ASCII, stale: true });
    assert.ok(lines.some((l) => stripAnsi(l).includes(STALE_MARK)));
    assert.match(lines.join('\n'), /authsvc:oauth/, 'the rows stay while the link is gone');
  });
});

describe('table columns measured in terminal columns', () => {
  const wide = [
    s({ slot: 1, project: '日本語プロジェクト', branch: 'main', displayState: 'working' }),
    s({ slot: 2, project: 'blog', branch: 'draft', displayState: 'your_turn' }),
  ];

  /** Where a word starts, counted in cells rather than UTF-16 units. */
  const columnOf = (line: string, word: string): number => visibleWidth(line.slice(0, line.indexOf(word)));

  it('lines a wide label up with the columns beside it', () => {
    const lines = renderTable(buildRows(wide, NOW, ASCII));
    const a = lines.find((l) => l.includes('working')) ?? '';
    const b = lines.find((l) => l.includes('your_turn')) ?? '';
    assert.equal(
      columnOf(a, 'working'),
      columnOf(b, 'your_turn'),
      `state column split by a wide label:\n${lines.join('\n')}`,
    );
  });

  it('honours the width it is given', () => {
    const rows = buildRows(wide, NOW, ASCII);
    for (const line of renderTable(rows, { width: 18 })) assert.ok(visibleWidth(line) <= 18, line);
    assert.deepEqual(renderTable([], { width: 4 }), ['no s']);
  });

  it('cuts a painted line without splitting an escape', () => {
    const painted = `${sgr([31], 'redredred')} tail`;
    const cut = clampVisible(painted, 5);
    assert.equal(visibleWidth(cut), 5);
    assert.equal(stripAnsi(cut), 'redre');
    assert.match(cut, /\[0m$/, 'the colour is closed, so it cannot bleed down the screen');
    assert.equal(clampVisible(painted, 100), painted, 'a line that fits is returned untouched');
  });
});

describe('reduced motion', () => {
  const working = [s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'working' })];

  it('freezes the strip: consecutive frames are byte identical', () => {
    const board: PaneBoard = { sessions: working, stale: false };
    const frameAt = (frame: number, motion: boolean): string =>
      livePaneFrame(board, { width: 80, rows: 1, theme: UNI, frame, motion }).lines.join('\n');
    assert.equal(frameAt(0, false), frameAt(1, false));
    assert.equal(frameAt(0, false), frameAt(7, false));
    assert.notEqual(frameAt(0, true), frameAt(1, true), 'motion on still spins');
  });

  it('freezes top: consecutive frames are byte identical', () => {
    const frameAt = (frame: number, motion: boolean): string =>
      topFrame(working, { now: NOW, rows: 24, cols: 80, theme: UNI, frame, motion }).join('\n');
    assert.equal(frameAt(0, false), frameAt(1, false));
    assert.equal(frameAt(0, false), frameAt(7, false));
    assert.notEqual(frameAt(0, true), frameAt(1, true), 'motion on still spins');
  });
});

describe('terminal geometry resolution', () => {
  it('takes a real reported size as it stands', () => {
    assert.deepEqual(terminalSize({ rows: 50, columns: 132 }, {}), { rows: 50, cols: 132 });
  });

  it('treats a zero-size pty as unknown and asks the env', () => {
    // `script` without a controlling terminal hands the inner process a 0x0 winsize.
    // Clamping to that turns the whole surface into one letter per repaint.
    const env = { LINES: '20', COLUMNS: '100' } as NodeJS.ProcessEnv;
    assert.deepEqual(terminalSize({ rows: 0, columns: 0 }, env), { rows: 20, cols: 100 });
  });

  it('falls back to 80 by 24 with nothing to go on', () => {
    assert.deepEqual(terminalSize({}, {}), { rows: 24, cols: 80 });
    assert.deepEqual(terminalSize({ rows: 0, columns: 0 }, { COLUMNS: 'nope' } as NodeJS.ProcessEnv), {
      rows: 24,
      cols: 80,
    });
  });
});
