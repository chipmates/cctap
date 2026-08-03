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

function claimStamp(now: number): string {
  return String(now).padStart(STAMP_WIDTH, '0');
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

/** Renames the spool aside and returns every claimed file, oldest first. */
export function claimSpoolFiles(spoolFile: string): string[] {
  const dir = path.dirname(spoolFile);
  const base = path.basename(spoolFile);
  const claimed: string[] = [];

  // Leftovers from a daemon that died mid-replay come first, oldest first. The name
  // carries a zero-padded timestamp so a lexicographic sort is a chronological one: the
  // old pid-first name put pid 999 ahead of pid 1000 and replayed events out of order,
  // which resurrects a permission prompt that was already answered.
  try {
    const leftovers = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}${CLAIM_SUFFIX}`))
      .map((name) => path.join(dir, name))
      .sort((a, b) => claimOrder(a) - claimOrder(b) || (a < b ? -1 : a > b ? 1 : 0));
    claimed.push(...leftovers);
  } catch {
    /* no spool dir yet */
  }

  try {
    if (fs.existsSync(spoolFile)) {
      const target = `${spoolFile}${CLAIM_SUFFIX}${claimStamp(Date.now())}-${process.pid}`;
      fs.renameSync(spoolFile, target);
      claimed.push(target);
    }
  } catch {
    /* nothing to claim */
  }
  return claimed;
}

/** Applies each spooled line in arrival order, then deletes the claimed file. */
export function replaySpool(spoolFile: string, apply: (msg: Record<string, unknown>) => void): number {
  let count = 0;
  for (const file of claimSpoolFiles(spoolFile)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { lines } = splitLines(text.endsWith('\n') ? text : `${text}\n`);
    for (const line of lines) {
      if (line.startsWith(SPOOL_DROP_MARK)) continue;
      const msg = parseLine(line);
      if (!msg) continue;
      try {
        apply(msg);
        count += 1;
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
  return count;
}

/**
 * N3: a daemon that never comes back would otherwise let the spool grow forever. Keep
 * the newest lines, count what went, and leave the tally where doctor can read it.
 */
export const SPOOL_MAX_LINES = 10000;
export const SPOOL_DROP_MARK = '#cctap-dropped ';

export function trimSpool(spoolFile: string, maxLines = SPOOL_MAX_LINES): number {
  let text = '';
  try {
    text = fs.readFileSync(spoolFile, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const events = lines.filter((l) => !l.startsWith(SPOOL_DROP_MARK));
  if (events.length <= maxLines) return 0;

  const already = lines
    .filter((l) => l.startsWith(SPOOL_DROP_MARK))
    .reduce((n, l) => n + (Number.parseInt(l.slice(SPOOL_DROP_MARK.length), 10) || 0), 0);
  const dropped = events.length - maxLines;
  const kept = events.slice(dropped);
  try {
    fs.writeFileSync(spoolFile, `${[`${SPOOL_DROP_MARK}${already + dropped}`, ...kept].join('\n')}\n`, { mode: 0o600 });
  } catch {
    return 0;
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
      .reduce((n, l) => n + (Number.parseInt(l.slice(SPOOL_DROP_MARK.length), 10) || 0), 0);
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
