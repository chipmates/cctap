/**
 * The glyph strip. Pure: sessions plus a width in, lines out.
 *
 * Fitting ladder, first level that fits wins. Labels give way before glyphs, and
 * attention states are the last thing to go, which is the whole point of the strip.
 */

import { sgr, visibleWidth } from '../ansi.js';
import { labelSessions, sortSessions, themedLabel, truncateLabel } from '../core/labels.js';
import { pickJumpTarget } from '../core/priority.js';
import type { DisplayState, WireSession } from '../core/types.js';
import { colorScopeFor, glyphFor, sgrFor, type Theme } from './theme.js';

const ATTENTION: DisplayState[] = ['permission_wait', 'failed', 'your_turn'];

/**
 * The glyphs are a vocabulary, and nobody reads a legend. Where there is room, the
 * states that want something from a human say so in words. The calm ones stay quiet:
 * a spinner explains itself, and glossing everything would drown the ones that matter.
 */
const GLOSS: Partial<Record<DisplayState, string>> = {
  permission_wait: 'needs you',
  your_turn: 'your turn',
  failed: 'failed',
};
const ENTRY_GAP = '  ';

export interface StripOptions {
  width: number;
  rows?: number;
  theme: Theme;
  frame?: number;
  color?: boolean;
  /** Reverse video and bold. Kept separate: NO_COLOR kills colour, not attributes. */
  attrs?: boolean;
  /** Opt-in only. Blink is off by default for photosensitive and vestibular readers. */
  blink?: boolean;
  /** Session to reverse-video, the awareness fallback after a failed jump. */
  highlight?: string;
  /** The session the reader is in. Its number is marked, so "which one am I" is free. */
  current?: string;
}

/** The word that marks the session you are reading the strip from. */
const YOU = 'you';

interface Entry {
  sessionId: string;
  project: string;
  /** The session this strip is being rendered inside, if the surface told us. */
  mine: boolean;
  /** The jump handle, rendered ahead of the label. Empty only at the count fallback. */
  slot: string;
  /** Two words at most, and only for the states that want a human. Dropped first. */
  gloss: string;
  label: string;
  glyph: string;
  subagents: string;
  state: DisplayState;
  attention: boolean;
}

interface Group {
  project: string;
  entries: Entry[];
}

/**
 * The highlight needs a carrier that survives with escapes off, so the brackets are
 * part of the text and the fit math counts them.
 */
function entryParts(e: Entry): string[] {
  const parts: string[] = [];
  // Number first, and it outlives the label: it is what you type to get there.
  if (e.slot) parts.push(e.slot);
  if (e.label) parts.push(e.label);
  parts.push(e.glyph);
  if (e.gloss) parts.push(e.gloss);
  if (e.subagents) parts.push(e.subagents);
  return parts;
}

function entryText(e: Entry, opts?: StripOptions): string {
  const text = entryParts(e).join(' ');
  const marked = opts && opts.highlight === e.sessionId && !opts.attrs;
  return marked ? `[${text}]` : text;
}

function paintEntry(e: Entry, opts: StripOptions): string {
  const highlighted = opts.attrs && opts.highlight === e.sessionId;
  const state = opts.color ? sgrFor(e.state, opts.blink) : [];
  // Reverse video is an attribute, not a hue, so the "you are here" mark survives
  // NO_COLOR by the same rule the highlight does.
  const mine = Boolean(opts.attrs && e.mine && e.slot);

  // Glyph-scoped states tint the glyph and its subagent count, never the label. A
  // highlight is the exception: it has to cover the whole entry, and nesting would let
  // the inner reset cut the reverse video short.
  if (state.length > 0 && !highlighted && colorScopeFor(e.state) === 'glyph') {
    const painted: Entry = {
      ...e,
      // The number is a handle, not a state: dim on the calm states so it reads as
      // furniture, and carried by the entry colour on the loud ones.
      slot: e.slot ? sgr(mine ? [2, 7] : [2], e.slot) : '',
      glyph: sgr(state, e.glyph),
      subagents: e.subagents ? sgr(state, e.subagents) : '',
      gloss: e.gloss === YOU ? sgr([2], e.gloss) : e.gloss,
    };
    return entryText(painted, opts);
  }

  const codes = [...state];
  if (highlighted) codes.push(7);

  if (mine && !highlighted) {
    // Sibling spans, never nested ones: an inner reset would end the entry colour early
    // and leave whatever follows it uncoloured. The number carries state plus reverse,
    // the marker word carries dim, and the rest carries state.
    const [slot = '', ...rest] = entryParts(e);
    const at = e.gloss === YOU ? rest.indexOf(YOU) : -1;
    const head = (at >= 0 ? rest.slice(0, at) : rest).join(' ');
    const tail = at >= 0 ? rest.slice(at + 1).join(' ') : '';
    const pieces = [sgr([...codes, 7], slot)];
    if (head) pieces.push(sgr(codes, head, codes.length > 0));
    if (at >= 0) pieces.push(sgr([2], YOU));
    if (tail) pieces.push(sgr(codes, tail, codes.length > 0));
    return pieces.join(' ');
  }

  return sgr(codes, entryText(e, opts), codes.length > 0);
}

function groupsFrom(entries: Entry[]): Group[] {
  const groups: Group[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.project === e.project) last.entries.push(e);
    else groups.push({ project: e.project, entries: [e] });
  }
  return groups;
}

function joinGroups(groups: Group[], theme: Theme, opts: StripOptions, painted: boolean): string {
  return groups
    .map((g) => g.entries.map((e) => (painted ? paintEntry(e, opts) : entryText(e, opts))).join(ENTRY_GAP))
    .join(` ${theme.separator} `);
}

/**
 * Splits groups across the row budget, exhaustively and in order. Groups stay whole,
 * which is what keeps the spatial memory D4 exists for. Earlier rows fill first, so a
 * two row strip degrades to a one row strip rather than spreading thin.
 */
function splitGroups(groups: Group[], rows: number, fits: (g: Group[]) => boolean): Group[][] | undefined {
  if (groups.length === 0) return [[]];
  if (rows <= 1) return fits(groups) ? [groups] : undefined;
  for (let k = groups.length; k >= 1; k--) {
    const head = groups.slice(0, k);
    if (!fits(head)) continue;
    const tail = groups.slice(k);
    if (tail.length === 0) return [head];
    const rest = splitGroups(tail, rows - 1, fits);
    if (rest) return [head, ...rest];
  }
  return undefined;
}

/**
 * Vertical stability rule: a project keeps the row it was on. Rows are only
 * recomputed when the remembered assignment no longer works, which means a project
 * appeared, or the width changed enough that a row no longer fits. A project that
 * disappears never moves the others.
 */
function packRemembered(
  groups: Group[],
  rows: number,
  fits: (g: Group[]) => boolean,
  remembered: Record<string, number> | undefined,
): Group[][] | undefined {
  if (!remembered) return undefined;
  const lines: Group[][] = Array.from({ length: rows }, () => []);
  for (const g of groups) {
    const row = remembered[g.project];
    if (row === undefined || row < 0 || row >= rows) return undefined;
    (lines[row] as Group[]).push(g);
  }
  return lines.every((l) => fits(l)) ? lines : undefined;
}

/**
 * Stable per-session spinner offset. Adjacent sessions must not spin in lockstep:
 * the glyph is the only thing telling them apart once labels are truncated away,
 * and a strip of identical spinners reads as one blinking mass.
 */
/**
 * One-shot renders have no ticker, so the wall clock supplies the frame. 500 ms means a
 * 2 s status line refresh advances 4 frames, which is a different glyph for the 10-frame
 * braille spinner and exactly one step for the 3-frame ascii one.
 */
/**
 * The one teaching line, for the status line only: it names the real slot of the
 * session that needs a human. Callers show it until the first jump lands, never after.
 */
export function onboardingHint(sessions: readonly WireSession[], invocation = 'cctap'): string | undefined {
  const target = pickJumpTarget(sortSessions(sessions));
  if (!target || target.slot <= 0) return undefined;
  return `${invocation} ${target.slot} jumps there`;
}

/**
 * What every read-only surface says when the socket does not answer. An empty board and
 * an unreachable daemon are different facts: the second one may be hiding blocked
 * sessions in persisted state, and nothing will revive it until a hook event or a human.
 */
export const DAEMON_UNREACHABLE = 'cctap: daemon not running, state unknown. It starts on the next hook event.';

export const SPIN_STEP_MS = 500;

export function spinnerFrameAt(now: number): number {
  return Math.floor(now / SPIN_STEP_MS);
}

function phase(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h;
}

function baseEntries(sessions: readonly WireSession[], opts: StripOptions): Entry[] {
  const ordered = sortSessions(sessions);
  const labels = labelSessions(ordered);
  const frame = opts.frame ?? 0;
  return ordered.map((s) => {
    const raw = labels.get(s.sessionId) ?? s.sessionId;
    return {
      sessionId: s.sessionId,
      project: s.project || '?',
      slot: s.slot > 0 ? String(s.slot) : '',
      mine: opts.current !== undefined && s.sessionId === opts.current,
      // The marker only needs a word when the state has not already said something.
      gloss: GLOSS[s.displayState] ?? (opts.current !== undefined && s.sessionId === opts.current ? YOU : ''),
      label: themedLabel(raw, opts.theme.collisionSep),
      glyph: glyphFor(opts.theme, s.displayState, frame + phase(s.sessionId)),
      subagents: s.subagents.active > 0 ? `${opts.theme.times}${s.subagents.active}` : '',
      state: s.displayState,
      attention: ATTENTION.includes(s.displayState),
    };
  });
}

/** Words cost the most and teach the least once you know the glyphs, so they go first. */
function withoutGloss(entries: Entry[]): Entry[] {
  return entries.map((e) => (e.gloss ? { ...e, gloss: '' } : e));
}

function withLabels(entries: Entry[], max: number | undefined, theme: Theme, attentionOnly = false): Entry[] {
  return entries.map((e) => {
    if (attentionOnly && !e.attention) return { ...e, label: '' };
    if (max === undefined) return { ...e };
    if (max === 0) return { ...e, label: '' };
    return { ...e, label: truncateLabel(e.label, max, theme.ellipsis) };
  });
}

/**
 * Last resort: counts per state. Its own small ladder, because the attention glyphs
 * are the last thing on screen and must survive as long as a single column allows.
 */
function summaries(entries: Entry[], theme: Theme, opts: StripOptions): string[] {
  const order: DisplayState[] = ['permission_wait', 'failed', 'your_turn', 'compacting', 'working', 'ended'];
  const build = (states: DisplayState[], withCounts: boolean, sep = ' '): string => {
    const parts: string[] = [];
    for (const state of states) {
      const of = entries.filter((e) => e.state === state);
      if (of.length === 0) continue;
      const glyph = glyphFor(theme, state, opts.frame ?? 0);
      // Glyph first: a leading number is a slot everywhere else on this strip, so "3!!"
      // would read as "session 3 is blocked" instead of "three sessions are blocked".
      const text = withCounts ? `${glyph}${of.length}` : glyph;
      parts.push(opts.color ? sgr(sgrFor(state, opts.blink), text) : text);
    }
    return parts.join(sep);
  };
  const loud = order.filter((st) => ATTENTION.includes(st));
  // The last one drops even the spaces: two attention glyphs still fit in three columns.
  return [build(order, true), build(loud, true), build(loud, false), build(loud, false, '')];
}

/**
 * The remembered row assignment. Pass the previous one back in on every repaint to
 * hold the layout still; a fresh call without it lays out from scratch.
 */
export interface StripLayout {
  rowOf: Record<string, number>;
}

export interface StripRender {
  lines: string[];
  layout: StripLayout;
}

export function renderStripLayout(
  sessions: readonly WireSession[],
  opts: StripOptions,
  previous?: StripLayout,
): StripRender {
  const rows = Math.max(1, Math.min(2, opts.rows ?? 1));
  const theme = opts.theme;
  const entries = baseEntries(sessions, opts);
  const empty: StripRender = { lines: [''], layout: { rowOf: {} } };
  if (entries.length === 0) return empty;

  // Ordered by how much they keep: full labels, shorter labels, then labels only
  // where they matter, then none. Attention glyphs survive every level.
  // The glossed level is tried first and dropped whole: every level below it is exactly
  // what this strip rendered before glosses existed, so narrow output cannot change.
  const bare = withoutGloss(entries);
  const ladder: Entry[][] = [
    withLabels(entries, undefined, theme),
    withLabels(bare, undefined, theme),
    withLabels(bare, 12, theme),
    withLabels(bare, 8, theme),
    withLabels(bare, 5, theme),
    withLabels(bare, 12, theme, true),
    withLabels(bare, 8, theme, true),
    withLabels(bare, 5, theme, true),
    withLabels(bare, 0, theme),
  ];

  const finish = (packed: Group[][]): StripRender => {
    const rowOf: Record<string, number> = {};
    packed.forEach((line, i) => line.forEach((g) => (rowOf[g.project] = i)));
    return { lines: packed.map((l) => joinGroups(l, theme, opts, true)), layout: { rowOf } };
  };

  for (const level of ladder) {
    const groups = groupsFrom(level);
    const fits = (gs: Group[]): boolean => visibleWidth(joinGroups(gs, theme, opts, false)) <= opts.width;
    const packed = packRemembered(groups, rows, fits, previous?.rowOf) ?? splitGroups(groups, rows, fits);
    if (packed) return finish(packed);
  }

  // Drop the calm sessions, keep every attention glyph plus a count of the hidden.
  const loud = withLabels(bare, 0, theme).filter((e) => e.attention);
  const hidden = entries.length - loud.length;
  if (loud.length > 0) {
    const tail: Entry[] =
      hidden > 0
        ? [
            {
              sessionId: '',
              project: (loud[loud.length - 1] as Entry).project,
              mine: false,
              slot: '',
              gloss: '',
              label: '',
              glyph: `+${hidden}`,
              subagents: '',
              state: 'working',
              attention: false,
            },
          ]
        : [];
    const groups = groupsFrom([...loud, ...tail]);
    const fits = (gs: Group[]): boolean => visibleWidth(joinGroups(gs, theme, opts, false)) <= opts.width;
    const packed = splitGroups(groups, rows, fits);
    if (packed) return finish(packed);
  }

  const options = summaries(entries, theme, opts);
  for (const counts of options) {
    if (visibleWidth(counts) <= opts.width) return { lines: [counts], layout: { rowOf: {} } };
  }
  // Below every option: slice the UNPAINTED text. Cutting a painted string mid escape
  // leaves an unterminated CSI on the terminal.
  const plain = summaries(entries, theme, { ...opts, color: false, attrs: false });
  const last = plain[plain.length - 1] ?? '';
  return { lines: [last.slice(0, Math.max(0, opts.width))], layout: { rowOf: {} } };
}

export function renderStrip(sessions: readonly WireSession[], opts: StripOptions): string[] {
  return renderStripLayout(sessions, opts).lines;
}

/** `--rows n` owns n lines of pane, so the renderer always writes exactly n. */
export function padRows(lines: string[], rows: number): string[] {
  const out = lines.slice(0, Math.max(1, rows));
  while (out.length < rows) out.push('');
  return out;
}

/**
 * The spinner is the only thing that needs repainting without a state change, so
 * when nothing is working the renderer stops ticking entirely (M2 CPU budget).
 */
export function shouldAnimate(sessions: readonly WireSession[]): boolean {
  return sessions.some((s) => s.displayState === 'working');
}

/** One-shot plain line for tmux status-right or a Claude Code status line. */
export function statusText(sessions: readonly WireSession[]): string {
  if (sessions.length === 0) return 'no sessions';
  const live = sessions.filter((s) => s.displayState !== 'ended');
  if (live.length === 0) return 'no sessions';

  // One word per state, so every count is grammatical: "1 blocked", "3 blocked".
  const count = (state: DisplayState): number => live.filter((s) => s.displayState === state).length;
  const parts: string[] = [];
  const working = count('working') + count('compacting');
  if (working > 0) parts.push(`${working} working`);
  const perm = count('permission_wait');
  if (perm > 0) parts.push(`${perm} blocked`);
  const failed = count('failed');
  if (failed > 0) parts.push(`${failed} failed`);
  const turn = count('your_turn');
  if (turn > 0) parts.push(`${turn} finished`);

  const ordered = sortSessions(live);
  const labels = labelSessions(ordered);
  let loudest: WireSession | undefined;
  for (const want of ATTENTION) {
    for (const s of ordered) {
      if (s.displayState !== want) continue;
      if (!loudest || s.stateSince < loudest.stateSince) loudest = s;
    }
    if (loudest) break;
  }

  const head = parts.length > 0 ? parts.join(', ') : `${live.length} sessions`;
  if (!loudest) return head;
  // Plain ascii: this line lands in a tmux bar that may not be drawing unicode.
  const label = themedLabel(labels.get(loudest.sessionId) ?? loudest.sessionId, '/');
  return `${head}: ${label}`;
}
