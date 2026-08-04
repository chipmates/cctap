/**
 * The two live surfaces: what they show when the daemon link drops, what they do with a
 * terminal too small for the board, and what "reduced motion" costs a frame. Pure render
 * seams throughout, so none of it needs a pty.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sgr, stripAnsi, visibleWidth } from '../src/ansi.js';
import {
  linkChanged,
  livePaneFrame,
  resumeAfterStop,
  snapshotNotice,
  STALE_MARK,
  type PaneBoard,
} from '../src/commands/strip.js';
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

describe('the ascii theme stays 7-bit', () => {
  /** The theme is picked exactly when the terminal cannot draw anything else. */
  const ASCII_ONLY = /^[\x20-\x7E]*$/;

  it('separates the stale marker without leaving the character set', () => {
    const unicode = paneText({ sessions: blockedBoard(), stale: true }, 120, UNI);
    assert.ok(unicode.includes(' · '), unicode);

    const ascii = stripAnsi(paneText({ sessions: blockedBoard(), stale: true }, 120, ASCII));
    assert.ok(ascii.includes(STALE_MARK), ascii);
    assert.match(ascii, ASCII_ONLY, `a non-ascii character reached the ascii theme: ${JSON.stringify(ascii)}`);
    assert.ok(ascii.includes(' - '), `the marker lost its separator: ${ascii}`);
  });

  it('holds through the whole fitting ladder, marker and notice both', () => {
    for (let width = 10; width <= 120; width += 1) {
      const frame = livePaneFrame(
        { sessions: blockedBoard(), stale: true },
        { width, rows: 1, theme: ASCII, frame: 0, notice: 'jumping to blog:draft...' },
      );
      for (const line of frame.lines) {
        const plain = stripAnsi(line);
        assert.match(plain, ASCII_ONLY, `width ${width} drew ${JSON.stringify(plain)}`);
        assert.ok(visibleWidth(line) <= width, `width ${width} overflowed: ${JSON.stringify(plain)}`);
      }
    }
  });

  it('keeps every snapshot line 7-bit as well', () => {
    for (const kind of ['daemon-down', 'no-sessions'] as const) {
      for (const width of [8, 20, 40, 80, 120]) {
        for (const line of snapshotNotice(kind, 2, width)) assert.match(line, ASCII_ONLY, line);
      }
    }
  });
});

describe('the snapshot strip fits the slot it is embedded in', () => {
  it('writes exactly the rows it was asked for, none wider than the width', () => {
    for (const kind of ['daemon-down', 'no-sessions'] as const) {
      for (const rows of [1, 2]) {
        for (let width = 4; width <= 120; width += 1) {
          const lines = snapshotNotice(kind, rows, width);
          assert.equal(lines.length, rows, `${kind} at ${width} wrote ${lines.length} lines`);
          for (const line of lines) {
            assert.ok(visibleWidth(line) <= width, `${kind} at ${width}: ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });

  it('steps the empty-board sentence down instead of cutting it', () => {
    assert.match(snapshotNotice('no-sessions', 1, 120)[0] ?? '', /^no sessions yet\. hooks are picked up live/);
    // 80 columns is what a piped strip gets, and the long form does not fit there.
    const eighty = snapshotNotice('no-sessions', 1, 80)[0] ?? '';
    assert.ok(visibleWidth(eighty) <= 80, eighty);
    assert.match(eighty, /^no sessions yet\. cctap doctor checks/, 'the pointer to doctor survives the step');
    assert.equal(snapshotNotice('no-sessions', 1, 30)[0], 'no sessions yet');
  });

  it('gives a second row the whole hint or none of it', () => {
    assert.deepEqual(snapshotNotice('no-sessions', 2, 100), [
      'no sessions yet',
      'hooks are picked up live, and cctap doctor checks hooks, daemon and socket',
    ]);
    assert.deepEqual(snapshotNotice('no-sessions', 2, 50), [
      'no sessions yet',
      'cctap doctor checks hooks, daemon and socket',
    ]);
    assert.deepEqual(snapshotNotice('no-sessions', 2, 20), ['no sessions yet', '']);
  });

  it('still says the daemon is down in whatever room is left', () => {
    assert.match(snapshotNotice('daemon-down', 1, 120)[0] ?? '', /daemon not running/);
    assert.equal(snapshotNotice('daemon-down', 1, 40)[0], `cctap: ${STALE_MARK}`);
    assert.equal(snapshotNotice('daemon-down', 1, 20)[0], 'cctap: daemon down');
    assert.match(snapshotNotice('daemon-down', 1, 10)[0] ?? '', /^cctap: d/, 'a cut is the last resort, not the first');
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

  it('keeps the daemon marker on a terminal too short for the rows', () => {
    for (const rows of [3, 4, 5, 6, 8, 12]) {
      for (const status of [undefined, 'jumping to proj17...']) {
        const lines = topFrame(many, { now: NOW, rows, cols: 40, theme: ASCII, stale: true, status });
        assert.ok(lines.length <= rows, `${rows} rows produced ${lines.length} lines`);
        assert.ok(
          lines.some((l) => stripAnsi(l).includes(STALE_MARK)),
          `a ${rows} row terminal lost the marker:\n${lines.join('\n')}`,
        );
      }
    }
  });

  it('never puts rows on screen without saying how many are hidden', () => {
    for (const rows of [3, 4, 5, 6, 8, 12, 24]) {
      for (const stale of [false, true]) {
        const lines = topFrame(many, { now: NOW, rows, cols: 40, theme: ASCII, stale });
        const shown = lines.filter((l) => /^[>* ] \d/.test(stripAnsi(l))).length;
        if (shown === 0) continue;
        const more = /\+(\d+) more/.exec(stripAnsi(lines.join('\n')));
        assert.ok(more, `${rows} rows showed ${shown} of 30 and said nothing:\n${lines.join('\n')}`);
        assert.equal(Number(more[1]) + shown, 30, lines.join('\n'));
      }
    }
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

describe('a SIGCONT with no stop before it', () => {
  it('re-enters only the surface that actually gave the terminal back', () => {
    assert.deepEqual(resumeAfterStop({ restored: true, armed: false }), { enter: true, arm: true });
    // Anything can send SIGCONT. A surface still holding the terminal must sit still.
    assert.deepEqual(resumeAfterStop({ restored: false, armed: false }), { enter: false, arm: false });
    assert.deepEqual(resumeAfterStop({ restored: false, armed: true }), { enter: false, arm: false });
  });

  it('arms one stop listener rather than stacking a second', () => {
    assert.deepEqual(resumeAfterStop({ restored: true, armed: true }), { enter: true, arm: false });
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
