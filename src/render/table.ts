/**
 * Row model for `top`. Pure: takes sessions plus a clock, returns text.
 * Columns: glyph, project:branch, state, time-in-state, current tool, subagent count.
 */

import { ansi, padEnd, visibleWidth } from '../ansi.js';
import { formatDuration, labelSessions, sortSessions, themedLabel } from '../core/labels.js';
import type { DisplayState, WireSession } from '../core/types.js';
import { cutToWidth, stringWidth } from '../core/width.js';
import { glyphFor, type Theme } from './theme.js';

export interface Row {
  sessionId: string;
  /** The jump handle, first column: what you type to get there. */
  slot: string;
  glyph: string;
  label: string;
  state: DisplayState;
  age: string;
  tool: string;
  subagents: string;
  session: WireSession;
}

export function buildRows(
  sessions: readonly WireSession[],
  now: number,
  theme: Theme,
  frame = 0,
  motion = true,
): Row[] {
  const ordered = sortSessions(sessions);
  const labels = labelSessions(ordered);
  return ordered.map((s) => {
    const label = themedLabel(labels.get(s.sessionId) ?? s.sessionId, theme.collisionSep);
    return {
      sessionId: s.sessionId,
      slot: s.slot > 0 ? String(s.slot) : '',
      glyph: glyphFor(theme, s.displayState, frame, motion),
      label,
      state: s.displayState,
      age: formatDuration(now - s.stateSince),
      tool: s.currentTool ?? '',
      subagents: s.subagents.active > 0 ? `${theme.times}${s.subagents.active}` : '',
      session: s,
    };
  });
}

export interface TableOptions {
  header?: string;
  selected?: number;
  /** Terminal columns. A line longer than this wraps, and a wrapped line scrolls. */
  width?: number;
}

/**
 * Longest prefix that fits `width` terminal columns, escape sequences kept whole.
 * Cutting a line by units splits an escape and prints its tail as text; cutting by
 * units also under-counts a wide glyph, which is the wrap this is here to prevent.
 */
export function clampVisible(line: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(line) <= width) return line;
  const seq = /\u001b\[[0-9;?]*[a-zA-Z]/g;
  let out = '';
  let left = width;
  let pos = 0;
  let escaped = false;
  for (let m = seq.exec(line); m !== null; m = seq.exec(line)) {
    const kept = cutToWidth(line.slice(pos, m.index), left);
    out += kept + m[0];
    left -= stringWidth(kept);
    escaped = true;
    pos = m.index + m[0].length;
  }
  out += cutToWidth(line.slice(pos), left);
  // An attribute opened before the cut would otherwise bleed into the rest of the screen.
  return escaped && !out.endsWith(ansi.reset) ? out + ansi.reset : out;
}

/** Glyph and label, then everything else. Split so `top` can colour only the first part. */
export interface TableLine {
  head: string;
  tail: string;
  /** head split at its column boundaries, so a caller can tint one piece at a time. */
  slot: string;
  glyph: string;
  label: string;
}

/**
 * Columns, not units: the cells are padded by terminal width, so sizing by `.length`
 * lets a CJK label that is the widest in its column overrun the column beside it.
 */
function widths(rows: readonly Row[]): Record<string, number> {
  return {
    slot: Math.max(1, ...rows.map((r) => visibleWidth(r.slot))),
    // The permission glyph is two cells wide, so the glyph column has to be padded
    // or every other row shifts left by one.
    glyph: Math.max(1, ...rows.map((r) => visibleWidth(r.glyph))),
    label: Math.max(7, 'SESSION'.length, ...rows.map((r) => visibleWidth(r.label))),
    state: Math.max(5, 'STATE'.length, ...rows.map((r) => visibleWidth(r.state))),
    age: Math.max(4, 'AGE'.length, ...rows.map((r) => visibleWidth(r.age))),
    tool: Math.max(0, 'TOOL'.length, ...rows.map((r) => visibleWidth(r.tool))),
    sub: Math.max(0, ...rows.map((r) => visibleWidth(r.subagents))),
  };
}

/** Column names, aligned with the rows below them. */
export function tableHeader(rows: readonly Row[]): string {
  const w = widths(rows);
  return [
    padEnd('#', w.slot ?? 1),
    padEnd('', w.glyph ?? 1),
    padEnd('SESSION', w.label ?? 7),
    padEnd('STATE', w.state ?? 5),
    padEnd('AGE', w.age ?? 4),
    'TOOL',
  ]
    .join('  ')
    .trimEnd();
}

export function renderTableLines(rows: readonly Row[]): TableLine[] {
  const w = widths(rows);
  return rows.map((r) => ({
    slot: padEnd(r.slot, w.slot ?? 1),
    glyph: padEnd(r.glyph, w.glyph ?? 1),
    label: padEnd(r.label, w.label ?? 7),
    head: [padEnd(r.slot, w.slot ?? 1), padEnd(r.glyph, w.glyph ?? 1), padEnd(r.label, w.label ?? 7)].join('  '),
    tail: [padEnd(r.state, w.state ?? 5), padEnd(r.age, w.age ?? 4), padEnd(r.tool, w.tool ?? 0), r.subagents]
      .join('  ')
      .trimEnd(),
  }));
}

/** Plain text table, no colour. `top` layers colour and selection on top. */
export function renderTable(rows: readonly Row[], opts: TableOptions = {}): string[] {
  const fit = (line: string): string => (opts.width === undefined ? line : clampVisible(line, opts.width));
  if (rows.length === 0) return [fit('no sessions')];
  return renderTableLines(rows).map((l) => fit(`${l.head}  ${l.tail}`.trimEnd()));
}
