/**
 * Display labels and ordering. Pure, shared by every renderer.
 * D4: project, then branch, then session start time. Never by recency.
 */

import type { WireSession } from './types.js';

export function baseLabel(s: Pick<WireSession, 'project' | 'branch'>): string {
  const project = s.project || '?';
  return s.branch ? `${project}:${s.branch}` : project;
}

export function shortId(sessionId: string): string {
  const compact = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  return (compact || sessionId).slice(0, 3);
}

/** D4 ordering. Stable and independent of when events arrived. */
export function sortSessions<T extends WireSession>(sessions: readonly T[]): T[] {
  return sessions.slice().sort((a, b) => {
    const p = (a.project || '').localeCompare(b.project || '');
    if (p !== 0) return p;
    const br = (a.branch || '').localeCompare(b.branch || '');
    if (br !== 0) return br;
    if (a.sessionStart !== b.sessionStart) return a.sessionStart - b.sessionStart;
    return a.sessionId.localeCompare(b.sessionId);
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

export function labelSessions<T extends WireSession>(sessions: readonly T[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const base = baseLabel(s);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of sessions) {
    const base = baseLabel(s);
    out.set(s.sessionId, (counts.get(base) ?? 0) > 1 ? `${base}${COLLISION_MARK}${shortId(s.sessionId)}` : base);
  }
  return out;
}

/** Truncate labels before glyphs. Attention glyphs never truncate away. */
export function truncateLabel(label: string, max: number, ellipsis = '…'): string {
  if (max <= 1 || label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - ellipsis.length))}${ellipsis}`;
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
