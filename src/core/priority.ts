/** Jump target selection, per spec/transitions.md. Pure. */

import type { DisplayState, WireSession } from './types.js';

/** Never `working`, `compacting` or `ended`. Order is the priority order. */
export const ATTENTION_ORDER: DisplayState[] = ['permission_wait', 'failed', 'your_turn'];

export function needsAttention(s: Pick<WireSession, 'displayState'>): boolean {
  return ATTENTION_ORDER.includes(s.displayState);
}

/** Oldest permission_wait, then oldest failed, then oldest your_turn (by stateSince). */
export function pickJumpTarget<T extends WireSession>(sessions: readonly T[]): T | undefined {
  for (const want of ATTENTION_ORDER) {
    let best: T | undefined;
    for (const s of sessions) {
      if (s.displayState !== want) continue;
      if (!best || s.stateSince < best.stateSince) best = s;
    }
    if (best) return best;
  }
  return undefined;
}

/**
 * Explicit target: session id prefix first, then a case-insensitive substring of the
 * `project:branch` label. Ties break on the D4 sort order the caller already applied.
 */
/** A purely numeric argument is always a slot, never a label prefix. */
export function isSlotQuery(query: string): boolean {
  return /^[0-9]+$/.test(query);
}

export function findSlot<T extends WireSession>(sessions: readonly T[], slot: number): T | undefined {
  return sessions.find((s) => s.slot === slot);
}

export function findSession<T extends WireSession>(
  sessions: readonly T[],
  query: string,
  labelOf: (s: T) => string,
): T | undefined {
  if (isSlotQuery(query)) return findSlot(sessions, Number.parseInt(query, 10));
  const q = query.toLowerCase();
  const byId = sessions.find((s) => s.sessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const byLabelPrefix = sessions.find((s) => labelOf(s).toLowerCase().startsWith(q));
  if (byLabelPrefix) return byLabelPrefix;
  return sessions.find((s) => labelOf(s).toLowerCase().includes(q));
}
