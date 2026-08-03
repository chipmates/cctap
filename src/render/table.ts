/**
 * Row model for `top`. Pure: takes sessions plus a clock, returns text.
 * Columns: glyph, project:branch, state, time-in-state, current tool, subagent count.
 */

import { padEnd } from '../ansi.js';
import { formatDuration, labelSessions, sortSessions, themedLabel } from '../core/labels.js';
import type { DisplayState, WireSession } from '../core/types.js';
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

export function buildRows(sessions: readonly WireSession[], now: number, theme: Theme, frame = 0): Row[] {
  const ordered = sortSessions(sessions);
  const labels = labelSessions(ordered);
  return ordered.map((s) => {
    const label = themedLabel(labels.get(s.sessionId) ?? s.sessionId, theme.collisionSep);
    return {
      sessionId: s.sessionId,
      slot: s.slot > 0 ? String(s.slot) : '',
      glyph: glyphFor(theme, s.displayState, frame),
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
  width?: number;
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

function widths(rows: readonly Row[]): Record<string, number> {
  return {
    slot: Math.max(1, ...rows.map((r) => r.slot.length)),
    // The permission glyph is two cells wide, so the glyph column has to be padded
    // or every other row shifts left by one.
    glyph: Math.max(1, ...rows.map((r) => r.glyph.length)),
    label: Math.max(7, 'SESSION'.length, ...rows.map((r) => r.label.length)),
    state: Math.max(5, 'STATE'.length, ...rows.map((r) => r.state.length)),
    age: Math.max(4, 'AGE'.length, ...rows.map((r) => r.age.length)),
    tool: Math.max(0, 'TOOL'.length, ...rows.map((r) => r.tool.length)),
    sub: Math.max(0, ...rows.map((r) => r.subagents.length)),
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
  if (rows.length === 0) return ['no sessions'];
  return renderTableLines(rows).map((l) => `${l.head}  ${l.tail}`.trimEnd());
}
