/** The strip fitting ladder and the status line. Pure, so all of it is table driven. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { visibleWidth } from '../src/ansi.js';
import type { DisplayState, WireSession } from '../src/core/types.js';
import {
  onboardingHint,
  padRows,
  renderStrip,
  renderStripLayout,
  shouldAnimate,
  SPIN_STEP_MS,
  spinnerFrameAt,
  statusText,
} from '../src/render/strip.js';
import { colorScopeFor, resolveTheme, sgrFor, SPINNER_ASCII, SPINNER_UNICODE } from '../src/render/theme.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const UNI = resolveTheme({ CCTAP_THEME: 'unicode' } as NodeJS.ProcessEnv);
const ASCII = resolveTheme({ CCTAP_THEME: 'ascii' } as NodeJS.ProcessEnv);

let seq = 0;
/** Slot defaults to 1 and is passed explicitly wherever more than one session coexists. */
function s(over: Partial<WireSession> & { project: string; branch: string; displayState: DisplayState }): WireSession {
  seq += 1;
  return {
    sessionId: `id${seq}`,
    slot: 1,
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

/** The canonical strip line, the shape everything else is judged against. */
const EXAMPLE = [
  s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'working' }),
  s({
    slot: 2,
    project: 'authsvc',
    branch: 'oauth',
    displayState: 'permission_wait',
    subagents: { active: 2, running: ['a'], anonymous: 1, blocked: ['a'] },
  }),
  s({ slot: 3, project: 'blog', branch: 'draft', displayState: 'your_turn' }),
  s({ slot: 4, project: 'infra', branch: 'tf', displayState: 'working' }),
];

/** Spinner phase is per session, so pin the shape and not the braille frame. */
function shape(line: string): string {
  return line.replace(/[\u2800-\u28ff]/g, '*');
}

describe('strip layout', () => {
  it('renders the canonical strip line', () => {
    const [line] = renderStrip(EXAMPLE, { width: 120, theme: UNI, frame: 1 });
    assert.equal(
      shape(line as string),
      '1 authsvc:main *  2 authsvc:oauth !! needs you ×2 │ 3 blog:draft ▲ your turn │ 4 infra:tf *',
    );
  });

  it('groups by project and never reorders by recency', () => {
    const shuffled = [EXAMPLE[3], EXAMPLE[1], EXAMPLE[2], EXAMPLE[0]] as WireSession[];
    const [line] = renderStrip(shuffled, { width: 120, theme: UNI, frame: 1 });
    assert.equal(
      shape(line as string),
      '1 authsvc:main *  2 authsvc:oauth !! needs you ×2 │ 3 blog:draft ▲ your turn │ 4 infra:tf *',
    );
  });

  it('spins with the frame counter', () => {
    const one = renderStrip(EXAMPLE, { width: 120, theme: UNI, frame: 0 })[0] as string;
    const two = renderStrip(EXAMPLE, { width: 120, theme: UNI, frame: 1 })[0] as string;
    assert.notEqual(one, two);
  });

  it('keeps adjacent spinners out of phase so they stay tellable apart', () => {
    const pair = [
      s({ sessionId: 'aaa', project: 'p1', branch: 'm', displayState: 'working' }),
      s({ sessionId: 'bbb', project: 'p2', branch: 'm', displayState: 'working' }),
    ];
    const [line] = renderStrip(pair, { width: 120, theme: UNI, frame: 0 });
    const braille = (line as string).match(/[\u2800-\u28ff]/g) ?? [];
    assert.equal(braille.length, 2);
    assert.notEqual(braille[0], braille[1]);
  });

  /** The ascii spinner is a standalone token, so the label separator `/` is safe here. */
  function asciiShape(line: string): string {
    return line.replace(/(?<= )[/\-\\](?= |$)/g, '*');
  }

  it('falls back to ascii glyphs and separator', () => {
    const [line] = renderStrip(EXAMPLE, { width: 120, theme: ASCII, frame: 0 });
    assert.equal(
      asciiShape(line as string),
      '1 authsvc:main *  2 authsvc:oauth ! needs you x2 | 3 blog:draft ^ your turn | 4 infra:tf *',
    );
    assert.equal(/[^\x00-\x7f]/.test(line as string), false, 'ascii theme stays 7-bit');
  });

  it('animates in ascii too, and keeps failed apart from the subagent multiplier', () => {
    const frames = [0, 1, 2].map(
      (frame) => (renderStrip([EXAMPLE[0] as WireSession], { width: 40, theme: ASCII, frame })[0] as string).trim(),
    );
    assert.equal(new Set(frames).size, 3, 'the bar rotates in ascii too');
    assert.equal(ASCII.spinner.includes(ASCII.separator), false, 'and never wears the separator');

    const failedWithAgents = s({
      sessionId: 'f1',
      project: 'p',
      branch: 'm',
      displayState: 'failed',
      subagents: { active: 2, running: [], anonymous: 2, blocked: [] },
    });
    const [line] = renderStrip([failedWithAgents], { width: 40, theme: ASCII, frame: 0 });
    assert.match(line as string, /X failed x2/, 'the failed glyph never reads as the multiplier');
    for (const g of Object.values(ASCII.glyph)) assert.equal(g.length, 1, `${g} is one cell`);
    for (const f of ASCII.spinner) assert.equal(f.length, 1, `${f} is one cell`);
  });

  it('says nothing when there are no sessions', () => {
    assert.deepEqual(renderStrip([], { width: 80, theme: UNI }), ['']);
  });
});

describe('strip fitting ladder', () => {
  const widths = [120, 80, 60, 46, 34, 26, 18, 12, 8, 5, 3];

  it('never exceeds the width at any size', () => {
    for (const width of widths) {
      for (const rows of [1, 2]) {
        const lines = renderStrip(EXAMPLE, { width, rows, theme: UNI, frame: 0 });
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `width ${width} rows ${rows}: "${line}" is ${visibleWidth(line)} wide`,
          );
        }
        assert.ok(lines.length <= rows, `width ${width} produced ${lines.length} lines for ${rows} rows`);
      }
    }
  });

  it('keeps every attention glyph visible at every size', () => {
    for (const width of widths) {
      const line = renderStrip(EXAMPLE, { width, theme: UNI, frame: 0 }).join(' ');
      assert.ok(line.includes('!!'), `width ${width} dropped the permission glyph: "${line}"`);
      assert.ok(line.includes('▲'), `width ${width} dropped the your_turn glyph: "${line}"`);
    }
  });

  it('drops labels before glyphs, and calm labels before loud ones', () => {
    const wide = renderStrip(EXAMPLE, { width: 120, theme: UNI, frame: 0 })[0] as string;
    assert.ok(wide.includes('authsvc:main'));

    const medium = renderStrip(EXAMPLE, { width: 40, theme: UNI, frame: 0 })[0] as string;
    assert.ok(medium.includes('!!'), 'attention glyph survives');
    assert.ok(medium.length < wide.length);

    const narrow = renderStrip(EXAMPLE, { width: 26, theme: UNI, frame: 0 })[0] as string;
    assert.equal(narrow.includes('blog:draft'), false, 'calm labels are gone by 26 columns');
  });

  it('collapses to counts when even glyphs will not fit', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      s({ project: `p${i}`, branch: 'main', displayState: i % 3 === 0 ? 'permission_wait' : 'working' }),
    );
    const [line] = renderStrip(many, { width: 12, theme: UNI, frame: 0 });
    assert.ok(visibleWidth(line as string) <= 12);
    assert.ok((line as string).includes('!!'), `counts still name the loud state: "${line}"`);
    // Glyph first, so a count can never be read as a slot: "!!4" is four blocked
    // sessions, while "4 !!" everywhere else on the strip is the session in slot 4.
    assert.match(line as string, /!!\d/, `counts are glyph-first: "${line}"`);
    assert.equal(/(^|\s)\d+!!/.test(line as string), false, 'never number-first');
  });

  it('uses two rows when asked and one fits more per row', () => {
    const many = Array.from({ length: 6 }, (_, i) => s({ project: `proj${i}`, branch: 'main', displayState: 'working' }));
    const one = renderStrip(many, { width: 40, rows: 1, theme: UNI, frame: 0 });
    const two = renderStrip(many, { width: 40, rows: 2, theme: UNI, frame: 0 });
    assert.equal(one.length, 1);
    assert.equal(two.length, 2);
    assert.ok(two.join('').length > one.join('').length, 'two rows carry more label text');
    for (const line of two) assert.ok(visibleWidth(line) <= 40);
  });

  it('spends the second row on labels the first row would have dropped', () => {
    // At 16 columns one row shows numbers and glyphs only, and two rows must buy the
    // labels back instead of printing the same thing twice. The jump handle costs two
    // columns per entry, which is what moved this width up from 12.
    const busyDayEnd = [
      s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'permission_wait' }),
      s({ slot: 2, project: 'blog', branch: 'draft', displayState: 'working' }),
      s({ slot: 3, project: 'infra', branch: 'tf', displayState: 'your_turn' }),
    ];
    const one = renderStrip(busyDayEnd, { width: 16, rows: 1, theme: UNI, frame: 0 });
    const two = renderStrip(busyDayEnd, { width: 16, rows: 2, theme: UNI, frame: 0 });
    assert.equal(one.join('\n').includes('auth'), false, 'one row has no room for labels');
    assert.ok(two.join('\n').includes('auth'), `two rows keep a label: ${JSON.stringify(two)}`);
    assert.notDeepEqual(two, one, 'two rows must not be byte-identical to one');
    assert.equal(two.length, 2);
    for (const line of two) assert.ok(visibleWidth(line) <= 16, line);
  });

  it('keeps a multi-session project whole rather than splitting it across rows', () => {
    // EXAMPLE has two authsvc sessions, so that group cannot carry labels at 12
    // columns however many rows there are. Groups are never split (D4).
    const two = renderStrip(EXAMPLE, { width: 12, rows: 2, theme: UNI, frame: 0 });
    assert.ok(two.join(' ').includes('!!'), 'the loud glyph still survives');
    for (const line of two) assert.ok(visibleWidth(line) <= 12, line);
  });

  it('always writes exactly the requested number of rows', () => {
    // Wide enough for one line: the second row is still owned and still written.
    assert.deepEqual(padRows(renderStrip(EXAMPLE, { width: 120, rows: 2, theme: UNI, frame: 0 }), 2).length, 2);
    assert.deepEqual(padRows([''], 2), ['', '']);
    assert.deepEqual(padRows(['a', 'b'], 1), ['a'], 'never more rows than asked for');
  });
});

describe('two row stability', () => {
  const three = [
    s({ sessionId: 'p1', project: 'alpha', branch: 'main', displayState: 'permission_wait' }),
    s({ sessionId: 'p2', project: 'beta', branch: 'main', displayState: 'working' }),
    s({ sessionId: 'p3', project: 'gamma', branch: 'main', displayState: 'your_turn' }),
  ];

  it('keeps every project on its row across repaints at a fixed width', () => {
    let render = renderStripLayout(three, { width: 26, rows: 2, theme: UNI, frame: 0 });
    const first = render.layout.rowOf;
    for (let frame = 1; frame < 12; frame++) {
      render = renderStripLayout(three, { width: 26, rows: 2, theme: UNI, frame }, render.layout);
      assert.deepEqual(render.layout.rowOf, first, `frame ${frame} moved a project`);
    }
  });

  it('holds the assignment when a session only changes state', () => {
    const before = renderStripLayout(three, { width: 26, rows: 2, theme: UNI });
    const moved = three.map((x, i) => (i === 1 ? { ...x, displayState: 'permission_wait' as const } : x));
    const after = renderStripLayout(moved, { width: 26, rows: 2, theme: UNI }, before.layout);
    assert.deepEqual(after.layout.rowOf, before.layout.rowOf);
  });

  it('holds the assignment when a project disappears', () => {
    // Wide enough that both renders sit in the same ladder tier. Row memory is a
    // within-tier promise: a set that shrinks enough to afford glosses, or longer
    // labels, has always been allowed to re-lay out.
    const before = renderStripLayout(three, { width: 44, rows: 2, theme: UNI });
    const fewer = three.slice(0, 2);
    const after = renderStripLayout(fewer, { width: 44, rows: 2, theme: UNI }, before.layout);
    for (const g of ['alpha', 'beta']) {
      assert.equal(after.layout.rowOf[g], before.layout.rowOf[g], `${g} moved`);
    }
  });

  it('re-lays out when a project appears, because it has no row yet', () => {
    const before = renderStripLayout(three, { width: 26, rows: 2, theme: UNI });
    const more = [...three, s({ sessionId: 'p4', project: 'delta', branch: 'main', displayState: 'working' })];
    const after = renderStripLayout(more, { width: 26, rows: 2, theme: UNI }, before.layout);
    assert.equal(typeof after.layout.rowOf.delta, 'number', 'the newcomer got a row');
    for (const line of after.lines) assert.ok(visibleWidth(line) <= 26);
  });

  it('re-lays out when the width no longer fits the remembered rows', () => {
    const wide = renderStripLayout(three, { width: 60, rows: 2, theme: UNI });
    const narrow = renderStripLayout(three, { width: 18, rows: 2, theme: UNI }, wide.layout);
    for (const line of narrow.lines) assert.ok(visibleWidth(line) <= 18, line);
  });

  it('marks colliding labels apart', () => {
    const twins = [
      s({ slot: 1, sessionId: 'a3f9', project: 'authsvc', branch: 'main', displayState: 'working' }),
      s({ slot: 2, sessionId: 'b7e2', project: 'authsvc', branch: 'main', displayState: 'working' }),
    ];
    const [line] = renderStrip(twins, { width: 120, theme: UNI, frame: 0 });
    assert.equal(shape(line as string), '1 authsvc:main/a3f *  2 authsvc:main/b7e *');
  });
});

/**
 * A status line re-runs the command instead of ticking, so the clock has to carry the
 * spin. A step that divides evenly into the refresh cadence would freeze the glyph.
 */
describe('one-shot spinner stepping', () => {
  const REFRESH_MS = 2000;

  it('advances a different frame on every refresh, in both themes', () => {
    const busy = s({ project: 'authsvc', branch: 'main', displayState: 'working' });
    for (const theme of [UNI, ASCII]) {
      const at = (now: number): string =>
        (renderStrip([busy], { width: 80, theme, frame: spinnerFrameAt(now) })[0] as string).trim();
      const t0 = 1_735_000_000_000;
      const seen = [at(t0), at(t0 + REFRESH_MS), at(t0 + 2 * REFRESH_MS), at(t0 + 3 * REFRESH_MS)];
      for (let i = 1; i < seen.length; i++) {
        assert.notEqual(seen[i], seen[i - 1], `${theme.name} froze between refresh ${i - 1} and ${i}`);
      }
    }
  });

  it('picks a step that cannot land back on the same frame for either spinner', () => {
    const advance = REFRESH_MS / SPIN_STEP_MS;
    assert.ok(Number.isInteger(advance), 'a whole number of steps per refresh');
    assert.notEqual(advance % SPINNER_UNICODE.length, 0, 'the braille spinner would freeze');
    assert.notEqual(advance % SPINNER_ASCII.length, 0, 'the ascii spinner would freeze');
  });

  it('keeps different sessions on different phases at the same instant', () => {
    const now = 1_735_000_000_000;
    const two = [
      s({ sessionId: 'aaa', project: 'p', branch: 'one', displayState: 'working' }),
      s({ sessionId: 'zzz', project: 'p', branch: 'two', displayState: 'working' }),
    ];
    const [line] = renderStrip(two, { width: 120, theme: UNI, frame: spinnerFrameAt(now) });
    const braille = (line as string).match(/[\u2800-\u28ff]/g) ?? [];
    assert.equal(braille.length, 2);
    assert.notEqual(braille[0], braille[1], 'adjacent sessions must not spin in lockstep');
  });
});

describe('the colour system', () => {
  const ESC = '\u001b[';

  it('is a traffic light, 16-colour safe, loudest at the top', () => {
    assert.deepEqual(sgrFor('permission_wait'), [91, 1], 'bright red bold, the loudest');
    assert.deepEqual(sgrFor('permission_wait', true), [91, 1, 5]);
    assert.deepEqual(sgrFor('failed'), [31], 'plain red, one step quieter than blocked');
    assert.deepEqual(sgrFor('your_turn'), [33]);
    assert.deepEqual(sgrFor('working'), [32]);
    assert.deepEqual(sgrFor('compacting'), [36]);
    assert.deepEqual(sgrFor('ended'), [2]);
    for (const state of ['permission_wait', 'failed', 'your_turn', 'working', 'compacting', 'ended'] as const) {
      for (const code of sgrFor(state)) {
        assert.ok(code < 40 || (code >= 90 && code <= 97), `${state} uses a 16-colour code, got ${code}`);
      }
    }
  });

  it('paints whole entries, and keeps only the system chore to its glyph', () => {
    // The traffic light is on the names. Compacting is the one state that is about the
    // tool rather than the work, so it stays a tinted glyph beside a neutral label.
    assert.equal(colorScopeFor('compacting'), 'glyph');
    for (const state of ['working', 'permission_wait', 'failed', 'your_turn', 'ended'] as const) {
      assert.equal(colorScopeFor(state), 'entry', state);
    }
  });

  it('paints a working entry green from its number to its subagent count', () => {
    const busy = s({
      project: 'authsvc',
      branch: 'main',
      displayState: 'working',
      subagents: { active: 2, running: [], anonymous: 2, blocked: [] },
    });
    const [line] = renderStrip([busy], { width: 80, theme: UNI, color: true, frame: 0 });
    const text = line as string;
    // One sequence for the whole entry, number and label included: a board of working
    // sessions should read as green names, not as green punctuation.
    assert.ok(text.startsWith(`${ESC}32m1 authsvc:main `), JSON.stringify(text));
    assert.ok(text.endsWith(`\u00d72${ESC}0m`), 'the count is inside the same span');
    assert.equal((text.split(`${ESC}32m`).length - 1), 1, 'one sequence, not one per piece');
  });

  it('paints a compacting glyph cyan and leaves its label alone', () => {
    const c = s({ project: 'blog', branch: 'draft', displayState: 'compacting' });
    const [line] = renderStrip([c], { width: 80, theme: UNI, color: true });
    assert.equal(line, `${ESC}2m1${ESC}0m blog:draft ${ESC}36m◌${ESC}0m`, 'dim handle, cyan glyph, plain label');
  });

  it('paints failed plain red across the entry, one step under blocked', () => {
    const f = s({ project: 'infra', branch: 'tf', displayState: 'failed' });
    const [line] = renderStrip([f], { width: 80, theme: UNI, color: true });
    assert.equal(line, `${ESC}31m1 infra:tf ✗ failed${ESC}0m`, 'the gloss takes the entry colour too');
  });

  it('emits one combined sgr per entry, bright red and bold on permission_wait', () => {
    const [line] = renderStrip([EXAMPLE[1] as WireSession], { width: 80, theme: UNI, color: true });
    assert.equal(line, '\u001b[91;1m2 authsvc:oauth !! needs you \u00d72\u001b[0m');
  });

  it('blinks only when asked', () => {
    const opts = { width: 80, theme: UNI, color: true };
    assert.equal((renderStrip([EXAMPLE[1] as WireSession], opts)[0] as string).includes(';5m'), false);
    const blinking = renderStrip([EXAMPLE[1] as WireSession], { ...opts, blink: true })[0] as string;
    assert.ok(blinking.startsWith('\u001b[91;1;5m'), blinking);
  });

  it('adds reverse video to the highlighted session only', () => {
    const target = EXAMPLE[2] as WireSession;
    const [line] = renderStrip(EXAMPLE, {
      width: 120,
      theme: UNI,
      color: true,
      attrs: true,
      highlight: target.sessionId,
    });
    assert.ok(line?.includes('\u001b[33;7m3 blog:draft \u25b2 your turn\u001b[0m'), line);
    assert.equal(line?.includes('\u001b[33;7mauthsvc'), false);
  });

  it('keeps the highlight under NO_COLOR by using reverse video alone', () => {
    const target = EXAMPLE[2] as WireSession;
    const [line] = renderStrip(EXAMPLE, {
      width: 120,
      theme: UNI,
      color: false,
      attrs: true,
      highlight: target.sessionId,
    });
    assert.ok(line?.includes('\u001b[7m3 blog:draft \u25b2 your turn\u001b[0m'), line);
    assert.equal(/\u001b\[[39][0-9]/.test(line as string), false, 'no colour codes at all');
  });

  it('carries the highlight in text when escapes are off entirely', () => {
    const target = EXAMPLE[2] as WireSession;
    const [line] = renderStrip(EXAMPLE, {
      width: 120,
      theme: UNI,
      color: false,
      attrs: false,
      highlight: target.sessionId,
    });
    // The bracket carries the handle too.
    assert.ok(line?.includes('[3 blog:draft \u25b2 your turn]'), line);
    assert.equal(line?.includes('\u001b['), false);
  });

  it('emits no colour codes when colour is off', () => {
    const [line] = renderStrip(EXAMPLE, { width: 120, theme: UNI });
    assert.equal(/\u001b\[[0-9;]*m/.test(line as string), false, 'no colour codes');
  });

  it('never emits a truncated escape sequence at any width', () => {
    for (const width of [1, 2, 3, 4, 5, 6]) {
      for (const on of [false, true]) {
        const lines = renderStrip(EXAMPLE, { width, theme: UNI, color: on, attrs: on });
        for (const line of lines) {
          for (const e of line.match(/\u001b\[[0-9;]*[a-zA-Z]?/g) ?? []) {
            assert.ok(/[a-zA-Z]$/.test(e), `width ${width}: truncated escape ${JSON.stringify(e)}`);
          }
          assert.equal(line.includes('\u001b') && !/\u001b\[[0-9;]*[a-zA-Z]/.test(line), false, `width ${width}: bare ESC`);
        }
      }
    }
  });
});

describe('status line', () => {
  it('uses one word per state so every count is grammatical', () => {
    const one = [s({ project: 'a', branch: 'm', displayState: 'permission_wait' })];
    assert.equal(statusText(one), '1 blocked: a:m');
    const many = [
      s({ project: 'a', branch: 'm', displayState: 'permission_wait' }),
      s({ project: 'b', branch: 'm', displayState: 'permission_wait' }),
    ];
    assert.match(statusText(many), /^2 blocked: /);
  });

  it('counts states and names the loudest session', () => {
    assert.equal(statusText(EXAMPLE), '2 working, 1 blocked, 1 finished: authsvc:oauth');
  });

  it('names the oldest attention session, not the first listed', () => {
    const list = [
      s({ project: 'a', branch: 'm', displayState: 'your_turn', stateSince: 9000 }),
      s({ project: 'b', branch: 'm', displayState: 'your_turn', stateSince: 1000 }),
    ];
    assert.equal(statusText(list), '2 finished: b:m');
  });

  it('reports a calm board without a label', () => {
    const list = [s({ project: 'a', branch: 'm', displayState: 'working' })];
    assert.equal(statusText(list), '1 working');
  });

  it('handles the empty and all-ended cases', () => {
    assert.equal(statusText([]), 'no sessions');
    assert.equal(statusText([s({ project: 'a', branch: 'm', displayState: 'ended' })]), 'no sessions');
  });

  it('emits no ansi ever', () => {
    assert.equal(statusText(EXAMPLE).includes(''), false);
  });
});

describe('the one teaching line', () => {
  const blocked = [
    s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'permission_wait' }),
    s({ slot: 2, project: 'blog', branch: 'draft', displayState: 'working' }),
  ];

  it('names the real slot and the working invocation', () => {
    assert.equal(onboardingHint(blocked, 'cctap'), 'cctap 1 jumps there');
    assert.equal(onboardingHint(blocked, 'npx @chipmates/cctap'), 'npx @chipmates/cctap 1 jumps there');
  });

  it('says nothing at all when nothing wants a human', () => {
    const calm = [s({ slot: 1, project: 'a', branch: 'm', displayState: 'working' })];
    assert.equal(onboardingHint(calm, 'cctap'), undefined);
    assert.equal(onboardingHint([], 'cctap'), undefined);
  });
});

describe('attention states say what they want, when there is room', () => {
  const board = [
    s({ slot: 1, project: 'authsvc', branch: 'main', displayState: 'permission_wait' }),
    s({ slot: 2, project: 'blog', branch: 'draft', displayState: 'working' }),
    s({ slot: 3, project: 'infra', branch: 'tf', displayState: 'your_turn' }),
  ];

  it('glosses only the three states that want a human', () => {
    const [line] = renderStrip(board, { width: 120, theme: UNI, frame: 0 });
    assert.match(line as string, /!! needs you/);
    assert.match(line as string, /▲ your turn/);
    const failed = s({ slot: 1, project: 'infra', branch: 'tf', displayState: 'failed' });
    assert.match(renderStrip([failed], { width: 60, theme: UNI })[0] as string, /✗ failed/);
    // The calm ones stay wordless: a spinner explains itself.
    assert.equal(/⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠋/.test(line as string), true);
    assert.equal(/(working|compacting|ended)/.test(line as string), false);
    const compacting = s({ slot: 1, project: 'blog', branch: 'draft', displayState: 'compacting' });
    assert.equal(renderStrip([compacting], { width: 60, theme: UNI })[0], '1 blog:draft ◌');
  });

  it('gives the gloss the entry colour', () => {
    const [line] = renderStrip([board[0] as WireSession], { width: 60, theme: UNI, color: true, frame: 0 });
    assert.equal(line, '\u001b[91;1m1 authsvc:main !! needs you\u001b[0m');
  });

  it('drops every gloss before it shortens a single label', () => {
    // The first tier that does not fit costs the words, not the names.
    const wide = renderStrip(board, { width: 80, theme: UNI, frame: 0 })[0] as string;
    assert.match(wide, /needs you/);
    // There is a band where the words are gone and every label is still whole. That
    // band existing IS the ordering promise: glosses are cheaper to lose than names.
    const band: number[] = [];
    for (let w = 80; w >= 20; w--) {
      const line = renderStrip(board, { width: w, theme: UNI, frame: 0 })[0] as string;
      if (!line.includes('needs you') && line.includes('authsvc:main')) band.push(w);
      assert.ok(visibleWidth(line) <= w, `width ${w} respected`);
    }
    assert.ok(band.length > 0, 'no width drops the words while keeping the labels');
  });

  it('renders identically to the wordless strip once the glosses are gone', () => {
    for (const width of [44, 34, 26, 18, 12, 8]) {
      const withGloss = renderStrip(board, { width, theme: UNI, frame: 0 });
      const wordless = renderStrip(
        board.map((x) => ({ ...x, displayState: x.displayState })),
        { width, theme: UNI, frame: 0 },
      );
      assert.deepEqual(withGloss, wordless, `width ${width} is byte-identical`);
      for (const l of withGloss) assert.equal(/needs you|your turn|failed/.test(l), false, `no gloss at ${width}`);
    }
  });

  it('glosses in ascii too, because the words were always ascii', () => {
    const [line] = renderStrip(board, { width: 120, theme: ASCII, frame: 0 });
    assert.match(line as string, /! needs you/);
    assert.match(line as string, /\^ your turn/);
    assert.equal(/[^\x00-\x7f]/.test(line as string), false);
  });
});

describe('the strip marks the session you are reading it from', () => {
  const board = [
    s({ slot: 1, sessionId: 'a', project: 'authsvc', branch: 'main', displayState: 'permission_wait' }),
    s({ slot: 2, sessionId: 'b', project: 'blog', branch: 'draft', displayState: 'working' }),
    s({ slot: 3, sessionId: 'c', project: 'infra', branch: 'tf', displayState: 'your_turn' }),
  ];

  it('reverse-videos exactly one number, and says the word once', () => {
    const [line] = renderStrip(board, { width: 120, theme: UNI, color: true, attrs: true, current: 'b', frame: 0 });
    const text = line as string;
    assert.match(text, /\u001b\[32;7m2\u001b\[0m/, 'slot 2 carries state colour plus reverse');
    assert.equal((text.match(/;7m|\[7m/g) ?? []).length, 1, 'and nothing else is reversed');
    assert.match(text, /\u001b\[2myou\u001b\[0m/, 'a dim word at gloss width');
    // Exactly one marker span: "needs you" and "your turn" contain the word too, so
    // count the dim span rather than the letters.
    assert.equal((text.match(/\u001b\[2myou\u001b\[0m/g) ?? []).length, 1);
  });

  it('adds no word to a session that already says something', () => {
    const [line] = renderStrip(board, { width: 120, theme: UNI, color: true, attrs: true, current: 'a', frame: 0 });
    const text = line as string;
    assert.match(text, /\u001b\[91;1;7m1\u001b\[0m/, 'the number still carries the mark');
    assert.equal(text.includes('needs you you'), false, 'and the gloss is not doubled');
  });

  it('never colours past the marker word', () => {
    const busy = s({
      slot: 2,
      sessionId: 'b',
      project: 'blog',
      branch: 'draft',
      displayState: 'working',
      subagents: { active: 2, running: ['x', 'y'], anonymous: 0, blocked: [] },
    });
    const [line] = renderStrip([busy], { width: 120, theme: UNI, color: true, attrs: true, current: 'b', frame: 0 });
    // The count comes after the word, so a nested reset would have left it bare.
    assert.match(line as string, /\u001b\[2myou\u001b\[0m \u001b\[32m×2\u001b\[0m/);
  });

  it('marks nobody when the surface said nothing, byte for byte', () => {
    const opts = { width: 120, theme: UNI, color: true, attrs: true, frame: 0 };
    const plain = renderStrip(board, opts);
    assert.deepEqual(renderStrip(board, { ...opts, current: undefined }), plain, 'no id, no change');
    assert.deepEqual(renderStrip(board, { ...opts, current: 'nobody' }), plain, 'unknown id, no change');
    for (const l of plain) assert.equal(/;7m|\[7m/.test(l), false, 'nothing reversed');
  });

  it('keeps the mark under NO_COLOR, because reverse is an attribute', () => {
    const [line] = renderStrip(board, { width: 120, theme: UNI, color: false, attrs: true, current: 'b', frame: 0 });
    const text = line as string;
    assert.match(text, /\u001b\[7m2\u001b\[0m/, 'reverse with no hue');
    assert.equal(/\u001b\[3[0-9]m|\u001b\[9[0-9]m/.test(text), false, 'and no colour codes at all');
  });

  it('survives every width down to the numbers tier', () => {
    for (const width of [120, 80, 60, 44, 34, 26, 18]) {
      const [line] = renderStrip(board, { width, theme: UNI, color: true, attrs: true, current: 'b', frame: 0 });
      assert.match(line as string, /;7m2\u001b\[0m/, `the mark holds at ${width}`);
      assert.ok(visibleWidth(line as string) <= width, `and fits ${width}`);
    }
    // Below that there are no numbers to mark, so there is nothing to carry it.
    const [counts] = renderStrip(board, { width: 10, theme: UNI, color: true, attrs: true, current: 'b', frame: 0 });
    assert.equal(/;7m/.test(counts as string), false, 'the count tier has no handles');
  });

  it('does nothing when escapes are off entirely', () => {
    const [line] = renderStrip(board, { width: 120, theme: UNI, color: false, attrs: false, current: 'b', frame: 0 });
    assert.equal(/\u001b/.test(line as string), false, 'no escapes');
    assert.match(line as string, /2 blog:draft . you/, 'the word still says which one');
  });
});

describe('label collisions stay inside the theme', () => {
  const twins = [
    s({ slot: 1, sessionId: 'a3f9', project: 'authsvc', branch: 'main', displayState: 'working' }),
    s({ slot: 2, sessionId: 'b7e2', project: 'authsvc', branch: 'main', displayState: 'permission_wait' }),
  ];

  it('draws the ascii separator in the ascii theme, and stays 7-bit', () => {
    const [line] = renderStrip(twins, { width: 120, theme: ASCII, frame: 0 });
    assert.match(line as string, /authsvc:main\/a3f/);
    assert.equal(/[^\x00-\x7f]/.test(line as string), false, 'no stray middle dot');
  });

  it('keeps the status sentence ascii wherever it is embedded', () => {
    const text = statusText(twins);
    assert.match(text, /authsvc:main\/b7e/, 'the collision mark is mapped, not raw');
    assert.equal(/[^\x00-\x7f]/.test(text), false, 'a tmux bar may not be drawing unicode');
  });
});

describe('theme resolution', () => {
  it('drops to ascii on a non-utf8 locale', () => {
    assert.equal(resolveTheme({ TERM: 'xterm-256color', LANG: 'C' } as NodeJS.ProcessEnv).name, 'ascii');
    assert.equal(resolveTheme({ TERM: 'xterm-256color', LANG: 'de_DE.ISO8859-1' } as NodeJS.ProcessEnv).name, 'ascii');
    assert.equal(resolveTheme({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv).name, 'unicode');
    assert.equal(resolveTheme({ TERM: 'xterm-256color' } as NodeJS.ProcessEnv).name, 'unicode');
  });

  it('lets the explicit setting win over everything', () => {
    assert.equal(resolveTheme({ TERM: 'dumb', CCTAP_THEME: 'unicode' } as NodeJS.ProcessEnv).name, 'unicode');
    assert.equal(resolveTheme({ TERM: 'xterm', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv, 'ascii').name, 'ascii');
  });
});

describe('animation budget', () => {
  it('ticks only while something is working', () => {
    assert.equal(shouldAnimate(EXAMPLE), true);
    assert.equal(shouldAnimate([s({ project: 'a', branch: 'm', displayState: 'your_turn' })]), false);
    assert.equal(shouldAnimate([s({ project: 'a', branch: 'm', displayState: 'permission_wait' })]), false);
    assert.equal(shouldAnimate([s({ project: 'a', branch: 'm', displayState: 'ended' })]), false);
    assert.equal(shouldAnimate([]), false);
  });
});
