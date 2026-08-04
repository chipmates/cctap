/** state.json: atomic writes, debounced at least 1 s, flushed on clean shutdown (I8). */

import { displayStateOf } from '../core/reducer.js';
import type { Model, Session } from '../core/types.js';
import { PROTOCOL_VERSION } from '../core/types.js';
import { REGISTRATIONS } from '../install/hooks.js';
import { readJsonFile, writeFileAtomic } from '../paths.js';

export const SNAPSHOT_DEBOUNCE_MS = 1000;

/**
 * The registration names doctor reports on, and therefore the only keys `firstSeen` is
 * allowed to hold. Event names arrive as input, so recording them unfiltered let the map
 * grow without bound and persisted whatever a local socket writer chose to send.
 */
export const REGISTRATION_KEYS: ReadonlySet<string> = new Set(
  REGISTRATIONS.map((r) => (r.notif ? `${r.event}(${r.notif})` : r.event)),
);

function pruneFirstSeen(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (REGISTRATION_KEYS.has(k) && typeof v === 'number') out[k] = v;
  }
  return out;
}

export interface Observed {
  subagentEvents: boolean;
  envKeys: string[];
  /** Registration name to the timestamp it was first seen. Doctor names what is missing. */
  firstSeen?: Record<string, number>;
  /**
   * Events the spool discarded, carried forward from the drop markers as they are
   * replayed. Without this the one record saying events were lost is unlinked with the
   * spool file, exactly when someone would run doctor to find out.
   */
  spoolDropped?: number;
}

export interface Snapshot {
  v: number;
  savedAt: number;
  version: string;
  sessions: Session[];
  observed: Observed;
}

/**
 * How long a restored session's recorded ppid is worth believing. Past this, the pid may
 * belong to something else entirely, and a session that outlives its process forever
 * would keep the daemon awake and haunt every renderer.
 */
export const PPID_TRUST_MS = 60 * 60 * 1000;

export function serialize(model: Model, observed: Observed, version: string, now: number): string {
  const snap: Snapshot = {
    v: PROTOCOL_VERSION,
    savedAt: now,
    version,
    sessions: Object.values(model.sessions),
    observed,
  };
  return `${JSON.stringify(snap, null, 2)}\n`;
}

export function loadSnapshot(file: string): { model: Model; observed: Observed; savedAt: number } | undefined {
  const snap = readJsonFile<Snapshot>(file);
  if (!snap || !Array.isArray(snap.sessions)) return undefined;
  // A snapshot from a protocol we do not know is not worth guessing at: start clean
  // rather than restore fields that may mean something else now.
  if (typeof snap.v === 'number' && snap.v !== PROTOCOL_VERSION) return undefined;
  // Null prototype: a plain assignment of a session id like `__proto__` would run the
  // inherited setter instead of storing anything, and the session would silently not exist.
  const sessions: Record<string, Session> = Object.create(null) as Record<string, Session>;
  for (const s of snap.sessions) {
    if (!s || typeof s.sessionId !== 'string' || s.sessionId === '') continue;
    // Defensive: a hand-edited or truncated snapshot must not crash the daemon.
    if (!s.subagents || typeof s.subagents !== 'object') {
      s.subagents = { active: 0, running: [], anonymous: 0, blocked: [] };
    }
    if (!Array.isArray(s.subagents.blocked)) s.subagents.blocked = [];
    // A snapshot from before subagents were tracked by id has no running set; the count
    // it carried cannot be attributed, so it lives on as anonymous rather than vanishing.
    if (!Array.isArray(s.subagents.running)) s.subagents.running = [];
    if (typeof s.subagents.anonymous !== 'number' || s.subagents.anonymous < 0) {
      const carried = typeof s.subagents.active === 'number' ? s.subagents.active : 0;
      s.subagents.anonymous = Math.max(0, carried - s.subagents.running.length);
    }
    s.subagents.active = s.subagents.running.length + s.subagents.anonymous;
    // displayState is derived, so a snapshot missing it is repairable rather than fatal:
    // a renderer that indexes on it would otherwise crash on a hand-damaged file.
    if (typeof s.state !== 'string') s.state = 'working';
    if (typeof s.displayState !== 'string') s.displayState = displayStateOf(s);
    if (!s.terminal || typeof s.terminal !== 'object') s.terminal = { kind: 'unknown' };
    sessions[s.sessionId] = s;
  }
  // A snapshot from before slots existed, or one hand-edited into collisions, is repaired
  // here: oldest session first, so the numbers people already learned mostly survive.
  const taken = new Set<number>();
  // Oldest first for BOTH passes: on a collision the session that has held the number
  // longest keeps it, which is the one whose number a human is most likely to know.
  const byAge = Object.values(sessions).sort((a, b) => a.sessionStart - b.sessionStart);
  for (const s of byAge) {
    if (typeof s.slot === 'number' && Number.isInteger(s.slot) && s.slot > 0 && !taken.has(s.slot)) {
      taken.add(s.slot);
      continue;
    }
    s.slot = 0;
  }
  for (const s of byAge) {
    if (s.slot > 0) continue;
    let n = 1;
    while (taken.has(n)) n += 1;
    s.slot = n;
    taken.add(n);
  }
  const raw = snap.observed?.firstSeen;
  const observed: Observed = {
    subagentEvents: Boolean(snap.observed?.subagentEvents),
    envKeys: Array.isArray(snap.observed?.envKeys) ? snap.observed.envKeys : [],
    // Only keys naming a real registration survive a restore, so a snapshot polluted by
    // an older build (or by any local socket writer, since event names are input) heals
    // instead of carrying its foreign keys forever.
    firstSeen: pruneFirstSeen(raw),
  };
  const carried = snap.observed?.spoolDropped;
  if (typeof carried === 'number' && carried > 0) observed.spoolDropped = carried;
  const savedAt = typeof snap.savedAt === 'number' ? snap.savedAt : 0;
  return { model: { sessions }, observed, savedAt };
}

export class SnapshotWriter {
  private timer: NodeJS.Timeout | undefined;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly file: string,
    private readonly render: () => string,
    private readonly debounceMs = SNAPSHOT_DEBOUNCE_MS,
  ) {}

  schedule(): void {
    this.pending = true;
    // A retry must not re-arm a writer that has already shut down.
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  flush(): void {
    if (!this.pending) return;
    try {
      writeFileAtomic(this.file, this.render());
      this.pending = false;
    } catch {
      // A snapshot is a cache, never worth crashing over, but clearing `pending` before
      // the write meant a transient ENOSPC or EPERM was swallowed and never retried
      // until the next state change. Stay dirty and come back; the debounce is what
      // stops this from becoming a hot loop.
      this.schedule();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }
}
