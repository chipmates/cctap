/**
 * Display labels and ordering. Pure, shared by every renderer.
 * D4: project, then branch, then session start time. Never by recency.
 */

import type { WireSession } from './types.js';
import { cutToWidth, stringWidth } from './width.js';

export function baseLabel(s: Pick<WireSession, 'project' | 'branch'>): string {
  const project = s.project || '?';
  return s.branch ? `${project}:${s.branch}` : project;
}

// Disambiguating suffix: three characters is where it starts, not where it has to end.
const SHORT_ID_MIN = 3;
const SHORT_ID_MAX = 32;

export function shortId(sessionId: string, length = SHORT_ID_MIN): string {
  const compact = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  return (compact || sessionId).slice(0, length);
}

/**
 * Codepoint order, not locale order. This decides where a session sits on the strip, and
 * that position is spatial memory: it must not move because the host changed LANG.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** D4 ordering. Stable and independent of when events arrived. */
export function sortSessions<T extends WireSession>(sessions: readonly T[]): T[] {
  return sessions.slice().sort((a, b) => {
    const p = compare(a.project || '', b.project || '');
    if (p !== 0) return p;
    const br = compare(a.branch || '', b.branch || '');
    if (br !== 0) return br;
    if (a.sessionStart !== b.sessionStart) return a.sessionStart - b.sessionStart;
    return compare(a.sessionId, b.sessionId);
  });
}

/**
 * Labels for a whole set: duplicates of `project:branch` get a short session-id
 * suffix so two panes on the same branch stay tellable apart.
 */
/** Internal marker for a disambiguated label. Renderers map it onto the active theme. */
export const COLLISION_MARK = '\u00b7';

/** Swaps the marker for whatever the theme can draw, so ascii output stays 7-bit. */
export function themedLabel(label: string, sep: string): string {
  return label.includes(COLLISION_MARK) ? label.split(COLLISION_MARK).join(sep) : label;
}

/**
 * Shortest suffix length that tells this group of session ids apart. Three characters
 * of a uuid collide about once in four thousand pairs, which is often enough to have
 * happened, and two panes wearing the same label is the one thing the suffix exists to
 * prevent. The whole group lengthens together, so the labels stay symmetrical.
 */
function suffixLength(ids: readonly string[]): number {
  for (let n = SHORT_ID_MIN; n < SHORT_ID_MAX; n++) {
    const seen = new Set(ids.map((id) => shortId(id, n)));
    if (seen.size === ids.length) return n;
  }
  return SHORT_ID_MAX;
}

export function labelSessions<T extends WireSession>(sessions: readonly T[]): Map<string, string> {
  const byBase = new Map<string, string[]>();
  for (const s of sessions) {
    const base = baseLabel(s);
    const group = byBase.get(base);
    if (group) group.push(s.sessionId);
    else byBase.set(base, [s.sessionId]);
  }
  const lengths = new Map<string, number>();
  for (const [base, ids] of byBase) {
    if (ids.length > 1) lengths.set(base, suffixLength(ids));
  }
  const out = new Map<string, string>();
  for (const s of sessions) {
    const base = baseLabel(s);
    const n = lengths.get(base);
    out.set(s.sessionId, n === undefined ? base : `${base}${COLLISION_MARK}${shortId(s.sessionId, n)}`);
  }
  return out;
}

/**
 * Truncate labels before glyphs. Attention glyphs never truncate away.
 * `max` is terminal columns, and the cut lands on a grapheme boundary: half a surrogate
 * pair or an orphaned combining mark draws as a replacement character.
 * The marker is the caller's to pass, never defaulted: the themes disagree about it,
 * and a default here would be a character the ascii theme cannot draw.
 */
export function truncateLabel(label: string, max: number, ellipsis: string): string {
  if (max <= 1) return cutToWidth(label, max);
  if (stringWidth(label) <= max) return label;
  const room = max - stringWidth(ellipsis);
  if (room < 1) return cutToWidth(label, max);
  return `${cutToWidth(label, room)}${ellipsis}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
