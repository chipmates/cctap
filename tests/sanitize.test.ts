/**
 * I16: nothing a terminal acts on survives the daemon boundary, and every fit decision
 * counts columns rather than UTF-16 units. Plus the rendering fixes that share the
 * boundary: label collisions, repo resolution, reduced motion, colour precedence.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { attrsEnabled, colorEnabled, visibleWidth } from '../src/ansi.js';
import { motionEnabled } from '../src/config.js';
import { labelSessions, shortId, truncateLabel } from '../src/core/labels.js';
import { reduce } from '../src/core/reducer.js';
import { sanitizeText } from '../src/core/sanitize.js';
import { emptyModel, type DisplayState, type WireSession } from '../src/core/types.js';
import { cutToWidth, stringWidth } from '../src/core/width.js';
import { normalize } from '../src/daemon/normalize.js';
import { normalizeTty, projectLabel, RepoResolver } from '../src/daemon/resolve.js';
import type { Command, Exec, ExecResult } from '../src/exec.js';
import type { WireEvent } from '../src/proto.js';
import { renderStrip, shouldAnimate, statusText } from '../src/render/strip.js';
import { glyphFor, resolveTheme } from '../src/render/theme.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const UNI = resolveTheme({ CCTAP_THEME: 'unicode' } as NodeJS.ProcessEnv);

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const TAB = String.fromCharCode(0x09);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
/** The 8-bit control sequence introducer: C1 opens sequences too, not only ESC. */
const CSI8 = String.fromCharCode(0x9b);

/** Built from code points rather than escapes, so the test file itself stays 7-bit. */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/** A surrogate with no partner is what a naive `.slice` leaves behind. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

describe('sanitizeText', () => {
  it('strips the escapes that would repaint the terminal', () => {
    assert.equal(sanitizeText(`ma${ESC}[31min`), 'ma[31min');
    assert.equal(sanitizeText(`done${BEL}`), 'done');
    assert.equal(sanitizeText(`x${CSI8}2Ky`), 'x2Ky');
    assert.equal(sanitizeText(`a${NUL}b${DEL}c`), 'abc');
  });

  it('turns carriage return, newline and tab into a space each', () => {
    assert.equal(sanitizeText(`over${CR}written`), 'over written');
    assert.equal(sanitizeText(`two${CR}${LF}lines`), 'two  lines');
    assert.equal(sanitizeText(`a${TAB}b`), 'a b');
  });

  it('is idempotent', () => {
    const dirty = [
      `${ESC}[2J${ESC}[H`,
      `branch${CR}${LF}name`,
      `${NUL}${BEL}${DEL}${CSI8}`,
      `tab${TAB}tab`,
      'already clean',
      '',
    ];
    for (const s of dirty) {
      const once = sanitizeText(s);
      assert.equal(sanitizeText(once), once, JSON.stringify(s));
      assert.equal(hasControl(once), false, JSON.stringify(s));
    }
  });

  it('leaves everything a terminal actually draws alone', () => {
    for (const s of ['authsvc:main', '日本語:main', 'café', 'a b  c', '~!@#$%^&*()']) {
      assert.equal(sanitizeText(s), s);
    }
  });
});

describe('column width', () => {
  it('measures CJK in columns, not UTF-16 units', () => {
    // Nine wide characters draw eighteen cells, and `:main` adds five.
    assert.equal('日本語プロジェクト:main'.length, 14);
    assert.equal(stringWidth('日本語プロジェクト:main'), 23);
    assert.equal(visibleWidth('日本語プロジェクト:main'), 23);
    assert.equal(stringWidth('日本語プロジェクト:feature'), 26);
  });

  it('counts a decomposed accent as one column', () => {
    const nfd = `e${String.fromCharCode(0x301)}`;
    assert.equal(nfd.length, 2);
    assert.equal(stringWidth(nfd), 1);
    assert.equal(stringWidth('café'), 4);
  });

  it('counts emoji, joined sequences and flags as two columns', () => {
    assert.equal(stringWidth(String.fromCodePoint(0x1f600)), 2);
    const family = `${String.fromCodePoint(0x1f469)}${String.fromCharCode(0x200d)}${String.fromCodePoint(0x1f4bb)}`;
    assert.equal(stringWidth(family), 2);
    assert.equal(stringWidth(String.fromCodePoint(0x1f1e9, 0x1f1ea)), 2);
    // A text-presentation glyph asking for emoji form with VS16.
    assert.equal(stringWidth(`${String.fromCharCode(0x2764)}${String.fromCharCode(0xfe0f)}`), 2);
  });

  it('leaves East Asian Ambiguous at one column, which every theme glyph relies on', () => {
    // Widening these would mis-measure the strip everywhere outside a CJK locale, and
    // inside one the ascii theme has already taken over.
    for (const g of ['▲', '✗', '◌', '·', '×', '…', '│', '⠋']) {
      assert.equal(stringWidth(g), 1, g);
    }
  });

  it('cuts on grapheme boundaries and never straddles a wide glyph', () => {
    assert.equal(cutToWidth('abcdef', 3), 'abc');
    assert.equal(cutToWidth('日本語プロジェクト', 7), '日本語');
    assert.equal(cutToWidth('anything', 0), '');
    const cut = cutToWidth(String.fromCodePoint(0x1f600).repeat(3), 3);
    assert.equal(cut, String.fromCodePoint(0x1f600));
    assert.equal(hasLoneSurrogate(cut), false);
  });

  it('truncates a label without leaving half a character behind', () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(4);
    for (let max = 0; max <= 10; max++) {
      const out = truncateLabel(emoji, max, '…');
      assert.equal(hasLoneSurrogate(out), false, `max=${max}`);
      assert.ok(stringWidth(out) <= Math.max(0, max), `max=${max} produced ${stringWidth(out)}`);
    }
    assert.equal(truncateLabel('日本語プロジェクト:main', 8, '…'), '日本語…');
  });

  it('returns a prefix rather than the whole label at one column or less', () => {
    assert.equal(truncateLabel('authsvc', 1, '…'), 'a');
    assert.equal(truncateLabel('authsvc', 0, '…'), '');
    assert.equal(truncateLabel('authsvc', -3, '…'), '');
    // One column cannot hold a two-column glyph, so the honest answer is nothing.
    assert.equal(truncateLabel('日本語', 1, '…'), '');
  });
});

describe('normalize sanitation', () => {
  const wire = (hook: Record<string, unknown>, ts = 1000): WireEvent => ({
    v: 1,
    kind: 'event',
    ts,
    tag: { event: 'Notification', notif: `permission${BEL}_prompt` },
    hook,
    env: {},
    ppid: 0,
  });

  it('cleans every rendered field', () => {
    const ev = normalize(
      wire({
        session_id: `abc${BEL}123`,
        tool_name: `Bash${ESC}[31m`,
        agent_id: `agent${CR}one`,
        source: `startup${NUL}`,
        message: `needs you${ESC}[2J`,
        reason: `denied${CSI8}K`,
      }),
      1000,
    );
    assert.ok(ev);
    assert.equal(ev.sessionId, 'abc123');
    assert.equal(ev.notif, 'permission_prompt');
    assert.equal(ev.toolName, 'Bash[31m');
    assert.equal(ev.agentId, 'agent one');
    assert.equal(ev.source, 'startup');
    assert.equal(ev.message, 'needs you[2J');
    assert.equal(ev.reason, 'deniedK');
    for (const v of Object.values(ev)) {
      if (typeof v === 'string') assert.equal(hasControl(v), false, v);
    }
  });

  it('drops a field that was nothing but control bytes', () => {
    const ev = normalize(wire({ session_id: 's1', hook_event_name: 'Stop', message: `${BEL}${NUL}` }), 1000);
    assert.ok(ev);
    assert.equal(ev.message, undefined);
  });

  it('drops an event whose session id sanitizes away', () => {
    assert.equal(normalize(wire({ session_id: `${BEL}${NUL}`, hook_event_name: 'Stop' }), 1000), undefined);
  });

  it('leaves cwd and transcript_path alone: they are paths, never drawn', () => {
    const ev = normalize(
      wire({ session_id: 's1', hook_event_name: 'Stop', cwd: '/repos/x', transcript_path: '/repos/x/.t.jsonl' }),
      1000,
    );
    assert.equal(ev?.cwd, '/repos/x');
    assert.equal(ev?.meta?.transcriptPath, '/repos/x/.t.jsonl');
  });
});

describe('future timestamps', () => {
  const wire = (ts: number): WireEvent => ({
    v: 1,
    kind: 'event',
    ts,
    tag: { event: 'Stop' },
    hook: { session_id: 's1' },
    env: {},
    ppid: 0,
  });

  it('clamps a stamp from a clock excursion into the future', () => {
    const received = 1_000_000;
    assert.equal(normalize(wire(received + 24 * 3600_000), received)?.ts, received + 60_000);
    assert.equal(normalize(wire(received + 30_000), received)?.ts, received + 30_000);
  });

  it('never clamps the past: spool replay carries genuinely old stamps', () => {
    const received = 1_000_000;
    assert.equal(normalize(wire(received - 86_400_000), received)?.ts, received - 86_400_000);
  });
});

describe('resolve sanitation', () => {
  it('cleans the project label, the branch and the tty', async () => {
    assert.equal(projectLabel(`/repos/my${BEL}proj`, '', ''), 'myproj');
    assert.equal(projectLabel(undefined, `/repos/ro${ESC}ot`, ''), 'root');
    assert.equal(normalizeTty(`ttys0${BEL}03`), 'ttys003');
    const exec = scriptedExec(() => `main${ESC}[31m`);
    const info = await new RepoResolver(exec).resolve('/repos/x', 1000);
    assert.equal(info.branch, 'main[31m');
    assert.equal(hasControl(info.branch), false);
  });
});

/** An exec that answers on command, so a test can order two overlapping resolves. */
function gatedExec(answer: () => string): Exec & { calls: Command[]; pending: Array<() => void> } {
  const calls: Command[] = [];
  const pending: Array<() => void> = [];
  const fn = (command: Command): Promise<ExecResult> => {
    calls.push({ cmd: command.cmd, args: [...command.args] });
    const out = answer();
    return new Promise<ExecResult>((resolve) => {
      pending.push(() => resolve({ code: 0, stdout: out, stderr: '' }));
    });
  };
  return Object.assign(fn, { calls, pending });
}

function scriptedExec(answer: (c: Command) => string): Exec {
  return (command) => Promise.resolve({ code: 0, stdout: answer(command), stderr: '' });
}

describe('RepoResolver', () => {
  it('joins concurrent resolves instead of spawning git twice', async () => {
    const exec = gatedExec(() => 'main');
    const r = new RepoResolver(exec);
    const both = Promise.all([r.resolve('/repos/x', 1000), r.resolve('/repos/x', 1000)]);
    // One rev-parse pair, not one per caller.
    assert.equal(exec.calls.length, 2);
    exec.pending.splice(0).forEach((f) => f());
    const [a, b] = await both;
    assert.deepEqual(a, b);
  });

  it('lets the newest resolve own the cache when a slow one lands late', async () => {
    let branch = 'stale';
    const exec = gatedExec(() => branch);
    const r = new RepoResolver(exec);
    const slow = r.resolve('/repos/x', 1000);
    // A CwdChanged arrives while the first pair is still running.
    r.invalidate('/repos/x');
    branch = 'fresh';
    const forced = r.resolve('/repos/x', 1000, true);
    // The forced pair answers first, the stale one lands after it.
    exec.pending.splice(2).forEach((f) => f());
    assert.equal((await forced).branch, 'fresh');
    exec.pending.splice(0).forEach((f) => f());
    await slow;
    assert.equal(r.cached('/repos/x', 1000)?.branch, 'fresh');
  });

  it('does not let a later caller join a resolve that was invalidated', async () => {
    const exec = gatedExec(() => 'main');
    const r = new RepoResolver(exec);
    const first = r.resolve('/repos/x', 1000);
    r.invalidate('/repos/x');
    const second = r.resolve('/repos/x', 1000);
    assert.equal(exec.calls.length, 4, 'the second caller asked git itself');
    exec.pending.splice(0).forEach((f) => f());
    await Promise.all([first, second]);
  });

  it('names a detached checkout instead of showing a branch called HEAD', async () => {
    const r = new RepoResolver(scriptedExec((c) => (c.args.includes('--abbrev-ref') ? 'HEAD' : '/repos/x')));
    assert.equal((await r.resolve('/repos/x', 1000)).branch, 'detached');
  });
});

let seq = 0;
function session(over: Partial<WireSession> & { project: string; branch: string; displayState: DisplayState }): WireSession {
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

describe('label collisions', () => {
  const pair = (a: string, b: string): Map<string, string> =>
    labelSessions([
      session({ sessionId: a, project: 'proj', branch: 'main', displayState: 'working' }),
      session({ sessionId: b, project: 'proj', branch: 'main', displayState: 'working' }),
    ]);

  it('lengthens the suffix until two panes on one branch are tellable apart', () => {
    const labels = pair('4b1c0000-aaaa', '4b1d0000-bbbb');
    const a = labels.get('4b1c0000-aaaa');
    const b = labels.get('4b1d0000-bbbb');
    assert.notEqual(a, b);
    assert.equal(a, `proj:main${String.fromCharCode(0xb7)}4b1c`);
    assert.equal(b, `proj:main${String.fromCharCode(0xb7)}4b1d`);
  });

  it('lengthens the whole group together, so the labels stay symmetrical', () => {
    const labels = labelSessions([
      session({ sessionId: 'aaa1', project: 'p', branch: 'm', displayState: 'working' }),
      session({ sessionId: 'aaa2', project: 'p', branch: 'm', displayState: 'working' }),
      session({ sessionId: 'bbb1', project: 'p', branch: 'm', displayState: 'working' }),
    ]);
    const all = [...labels.values()];
    assert.equal(new Set(all).size, 3);
    for (const l of all) assert.equal(l.split(String.fromCharCode(0xb7))[1]?.length, 4);
  });

  it('stops at three characters when three is enough', () => {
    const labels = pair('a3f9c1', 'b7e220');
    assert.equal(labels.get('a3f9c1'), `proj:main${String.fromCharCode(0xb7)}a3f`);
    assert.equal(labels.get('b7e220'), `proj:main${String.fromCharCode(0xb7)}b7e`);
  });

  it('leaves a lone session unsuffixed', () => {
    const labels = labelSessions([session({ sessionId: 'a3f9c1', project: 'p', branch: 'm', displayState: 'working' })]);
    assert.equal(labels.get('a3f9c1'), 'p:m');
  });

  it('shortId defaults to three and takes a length', () => {
    assert.equal(shortId('4b1c-0000'), '4b1');
    assert.equal(shortId('4b1c-0000', 5), '4b1c0');
  });
});

describe('reduced motion', () => {
  const working = [session({ project: 'p', branch: 'm', displayState: 'working' })];

  it('reads one boolean from the config and the environment', () => {
    assert.equal(motionEnabled({} as NodeJS.ProcessEnv), true);
    assert.equal(motionEnabled({} as NodeJS.ProcessEnv, false), false);
    assert.equal(motionEnabled({ CCTAP_MOTION: '0' } as NodeJS.ProcessEnv), false);
    // The environment wins, so one terminal can differ from the config file.
    assert.equal(motionEnabled({ CCTAP_MOTION: '1' } as NodeJS.ProcessEnv, false), true);
  });

  it('freezes the spinner on one frame instead of hiding it', () => {
    const first = UNI.spinner[0];
    for (const frame of [0, 1, 7, 41]) {
      assert.equal(glyphFor(UNI, 'working', frame, false), first);
    }
    assert.notEqual(glyphFor(UNI, 'working', 1, true), glyphFor(UNI, 'working', 2, true));
  });

  it('stops the renderer asking for a ticker', () => {
    assert.equal(shouldAnimate(working), true);
    assert.equal(shouldAnimate(working, false), false);
  });

  it('renders the same line on every frame with motion off', () => {
    const opts = { width: 60, theme: UNI, motion: false, color: false };
    const a = renderStrip(working, { ...opts, frame: 0 });
    const b = renderStrip(working, { ...opts, frame: 5 });
    assert.deepEqual(a, b);
  });
});

describe('colour precedence', () => {
  const pipe = { isTTY: false } as NodeJS.WriteStream;

  it('lets a reader NO_COLOR beat the status line forced colour', () => {
    assert.equal(colorEnabled(pipe, { CCTAP_COLOR: '1' } as NodeJS.ProcessEnv), true);
    assert.equal(colorEnabled(pipe, { CCTAP_COLOR: '1', NO_COLOR: '1' } as NodeJS.ProcessEnv), false);
  });

  it('keeps attributes, so reverse video still reaches readers who cannot see hue', () => {
    assert.equal(attrsEnabled(pipe, { CCTAP_COLOR: '1', NO_COLOR: '1' } as NodeJS.ProcessEnv), true);
  });
});

describe('the boundary end to end', () => {
  it('renders a hostile hook payload and a hostile branch without one control byte', async () => {
    const hook = {
      session_id: `4b1c${BEL}0000`,
      hook_event_name: 'Notification',
      cwd: '/repos/x',
      message: `${ESC}[2J${ESC}[H wiped your screen${CR}`,
      tool_name: `Bash${CSI8}2K`,
    };
    const ev = normalize(
      { v: 1, kind: 'event', ts: 1000, tag: { event: 'Notification', notif: 'permission_prompt' }, hook, env: {}, ppid: 0 },
      1000,
    );
    assert.ok(ev);

    const exec = scriptedExec((c) => (c.args.includes('--abbrev-ref') ? `ma${ESC}[31min` : `/repos/${BEL}x`));
    const info = await new RepoResolver(exec).resolve('/repos/x', 1000);

    const model = reduce(emptyModel(), ev);
    const reduced = model.sessions[ev.sessionId];
    assert.ok(reduced);
    const wire: WireSession = {
      ...reduced,
      project: projectLabel(undefined, info.root, '/repos/x'),
      branch: info.branch,
    };

    const lines = renderStrip([wire], { width: 100, theme: UNI, color: false, attrs: false });
    assert.equal(lines.length, 1);
    const line = lines[0] ?? '';
    assert.equal(hasControl(line), false, JSON.stringify(line));
    assert.ok(line.includes('ma[31min'), line);
    assert.equal(hasControl(statusText([wire])), false);
  });

  it('fits a CJK label by columns, so the strip cannot overflow its width', () => {
    const wide = [
      session({ sessionId: 'w1', slot: 1, project: '日本語プロジェクト', branch: 'main', displayState: 'working' }),
      session({ sessionId: 'w2', slot: 2, project: '日本語プロジェクト', branch: 'feature', displayState: 'your_turn' }),
    ];
    for (const width of [8, 12, 20, 30, 45, 80]) {
      for (const line of renderStrip(wide, { width, theme: UNI, color: false, attrs: false })) {
        assert.ok(visibleWidth(line) <= width, `width=${width} produced ${visibleWidth(line)}: ${line}`);
        assert.equal(hasLoneSurrogate(line), false);
      }
    }
  });
});
