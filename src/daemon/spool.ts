/**
 * Spool replay. The forwarder appends here when the daemon was down (I4); the daemon
 * claims the file by rename before reading, so a concurrent append cannot be lost.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLine, splitLines } from '../proto.js';

const CLAIM_SUFFIX = '.replaying-';
/** Milliseconds, zero padded past the year 5138, so string order is time order. */
const STAMP_WIDTH = 14;

/**
 * Strictly increasing within the process. The name is the only thing that makes a claim
 * unique, and `rename` overwrites silently: a rotation and a claim landing in the same
 * millisecond in the same process would otherwise build the same path and one segment
 * would vanish. Across processes the pid already separates them.
 */
let lastStamp = 0;
function claimStamp(now: number): string {
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return String(lastStamp).padStart(STAMP_WIDTH, '0');
}

/** Claim time from the name, falling back to mtime for a name from an older build. */
function claimOrder(file: string): number {
  const m = /\.replaying-(\d+)/.exec(path.basename(file));
  const stamped = m?.[1];
  if (stamped !== undefined && stamped.length >= STAMP_WIDTH) return Number.parseInt(stamped, 10);
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface SpoolBacklog {
  files: number;
  lines: number;
  bytes: number;
}

/** Where a rename puts the live spool so a replay finds it. Unique per renamer. */
function claimTarget(spoolFile: string, now: number): string {
  return `${spoolFile}${CLAIM_SUFFIX}${claimStamp(now)}-${process.pid}`;
}

/**
 * Every segment in the claim namespace, oldest first. The name carries a zero-padded
 * timestamp so a lexicographic sort is a chronological one: the old pid-first name put
 * pid 999 ahead of pid 1000 and replayed events out of order, which resurrects a
 * permission prompt that was already answered.
 */
function segmentFiles(spoolFile: string): string[] {
  const dir = path.dirname(spoolFile);
  const base = path.basename(spoolFile);
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}${CLAIM_SUFFIX}`))
      .map((name) => path.join(dir, name))
      .sort((a, b) => claimOrder(a) - claimOrder(b) || (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return []; // no spool dir yet
  }
}

/** Renames the spool aside and returns every claimed file, oldest first. */
export function claimSpoolFiles(spoolFile: string): string[] {
  // Leftovers from a daemon that died mid-replay come first, then whatever is live now.
  const claimed = segmentFiles(spoolFile);
  try {
    if (fs.existsSync(spoolFile)) {
      const target = claimTarget(spoolFile, Date.now());
      fs.renameSync(spoolFile, target);
      claimed.push(target);
    }
  } catch {
    /* lost the race to another renamer: their segment is in the list already */
  }
  return claimed;
}

export interface ReplayResult {
  /** Events handed to `apply`. */
  events: number;
  /** Events the spool threw away before this replay, read off the drop markers. */
  dropped: number;
}

/** Applies each spooled line in arrival order, then deletes the claimed file. */
export function replaySpool(spoolFile: string, apply: (msg: Record<string, unknown>) => void): ReplayResult {
  const out: ReplayResult = { events: 0, dropped: 0 };
  for (const file of claimSpoolFiles(spoolFile)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { lines } = splitLines(text.endsWith('\n') ? text : `${text}\n`);
    for (const line of lines) {
      if (line.startsWith(SPOOL_DROP_MARK)) {
        // The one record saying events were lost, and replay is where it would otherwise
        // vanish: the marker is skipped, then unlinked with its file, exactly when a user
        // would run doctor to find out. Carry the number out instead.
        out.dropped += markCount(line);
        continue;
      }
      const msg = parseLine(line);
      if (!msg) continue;
      try {
        apply(msg);
        out.events += 1;
      } catch {
        /* I11: one bad line never stops the replay */
      }
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
  return out;
}

/**
 * N3: a daemon that never comes back would otherwise let the spool grow forever. The
 * spool is bounded by rotation rather than by rewriting: at the size bound the live file
 * is renamed into the claim namespace, which replay already globs, orders and drains.
 *
 * Rewriting was the alternative, and it cost an append-read-filter-write per spooled
 * event: not atomic, so a concurrent append landed in the copy that was overwritten (I4),
 * and on a backed-up spool the read alone blew the forwarder's 100 ms budget (I3). A
 * rename is atomic and costs one syscall, so racing appends either land in the old inode
 * (renamed aside, so replayed) or in a fresh spool. Both survive.
 */
export const SPOOL_ROTATE_BYTES = 1024 * 1024;
/**
 * Segments kept in the claim namespace, daemon-claimed leftovers included. Counting the
 * leftovers is what makes a daemon crash-looping in the rename-then-unlink window
 * converge on this many segments instead of leaving one behind per crash.
 */
export const MAX_SPOOL_SEGMENTS = 5;
export const SPOOL_DROP_MARK = '#cctap-dropped ';

function markCount(line: string): number {
  return Number.parseInt(line.slice(SPOOL_DROP_MARK.length), 10) || 0;
}

/** Events plus already-dropped tallies in one segment: what deleting it would cost. */
function segmentLoss(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    n += line.startsWith(SPOOL_DROP_MARK) ? markCount(line) : 1;
  }
  return n;
}

/**
 * Rotates the live spool aside once it reaches the size bound, then enforces the segment
 * cap. The fast path is a single `statSync`, which is what keeps this callable from the
 * forwarder after every append.
 */
export function rotateSpool(
  spoolFile: string,
  maxBytes = SPOOL_ROTATE_BYTES,
  maxSegments = MAX_SPOOL_SEGMENTS,
): number {
  try {
    if (fs.statSync(spoolFile).size < maxBytes) return 0;
  } catch {
    return 0; // nothing to rotate
  }
  try {
    fs.renameSync(spoolFile, claimTarget(spoolFile, Date.now()));
  } catch {
    // ENOENT means another renamer got there first, which is the outcome we wanted.
    return 0;
  }
  return dropOldestSegments(spoolFile, maxSegments);
}

/** Deletes the oldest segments over the cap, leaving the tally where doctor can read it. */
function dropOldestSegments(spoolFile: string, maxSegments: number): number {
  const segments = segmentFiles(spoolFile);
  if (segments.length <= maxSegments) return 0;
  let dropped = 0;
  for (const file of segments.slice(0, segments.length - maxSegments)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    dropped += segmentLoss(text);
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
  if (dropped > 0) {
    try {
      // Into the live spool, which is where spoolDropped and the replay both look.
      fs.appendFileSync(spoolFile, `${SPOOL_DROP_MARK}${dropped}\n`, { mode: 0o600 });
    } catch {
      /* the count is a diagnostic, never worth failing a hook over */
    }
  }
  return dropped;
}

/** How many events the spool has thrown away, for doctor. */
export function spoolDropped(spoolFile: string): number {
  try {
    return fs
      .readFileSync(spoolFile, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith(SPOOL_DROP_MARK))
      .reduce((n, l) => n + markCount(l), 0);
  } catch {
    return 0;
  }
}

export function spoolBacklog(spoolFile: string): SpoolBacklog {
  const dir = path.dirname(spoolFile);
  const base = path.basename(spoolFile);
  const out: SpoolBacklog = { files: 0, lines: 0, bytes: 0 };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name !== base && !name.startsWith(`${base}${CLAIM_SUFFIX}`)) continue;
    const file = path.join(dir, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      out.files += 1;
      out.bytes += Buffer.byteLength(text);
      out.lines += text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith(SPOOL_DROP_MARK)).length;
    } catch {
      /* skip */
    }
  }
  return out;
}
