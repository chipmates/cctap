/** I9: exactly one daemon per socket path. Lock file with pid, stale locks broken. */

import * as fs from 'node:fs';
import { FILE_MODE } from '../paths.js';

/** How long a lock may stay unreadable before it counts as orphaned rather than young. */
export const UNREADABLE_GRACE_MS = 250;
const RETRY_DELAY_MS = 15;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockHandle {
  path: string;
  pid: number;
  release(): void;
}

/** No sync sleep in node, and this path must stay synchronous to be race-free. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Creates the lock with its owner already inside it. `link` is atomic and fails when
 * the target exists, so the lock is never visible in a half-written state. Writing the
 * pid after an `open(O_EXCL)` instead leaves an empty file on disk for a moment, and a
 * second daemon that reads it in that window sees no owner and takes the lock too.
 */
function publishLock(lockPath: string, pid: number): boolean {
  const tmp = `${lockPath}.${pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${pid}\n`, { mode: FILE_MODE });
    try {
      fs.linkSync(tmp, lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

/** Only ever removes a lock that still names the pid we decided was gone. */
function breakLock(lockPath: string, expected: number | undefined): void {
  try {
    if (readLockPid(lockPath) !== expected) return;
    fs.unlinkSync(lockPath);
  } catch {
    /* another racer broke it first */
  }
}

function handleFor(lockPath: string): LockHandle {
  return {
    path: lockPath,
    pid: process.pid,
    release(): void {
      try {
        if (readLockPid(lockPath) === process.pid) fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Returns a handle on success, undefined when another live daemon holds the lock.
 * A lock owned by a dead pid is broken and retried; a lock that cannot be read yet
 * belongs to a daemon still starting up, so it is waited out rather than stolen.
 */
export function acquireLock(lockPath: string, attempts = 6): LockHandle | undefined {
  // Waiting out a young lock is bounded by the clock, and does not spend an attempt:
  // attempts exist to bound how often we break a lock, not how long we are patient.
  const waitUntil = Date.now() + UNREADABLE_GRACE_MS;
  let tries = 0;

  while (tries < attempts) {
    if (publishLock(lockPath, process.pid)) {
      // Someone could still have broken our lock between the link and this read.
      if (readLockPid(lockPath) === process.pid) return handleFor(lockPath);
      tries += 1;
      continue;
    }

    const holder = readLockPid(lockPath);
    if (holder === process.pid) return handleFor(lockPath);
    if (holder !== undefined && pidAlive(holder)) return undefined;

    if (holder === undefined) {
      // Empty or torn: a daemon mid-acquire, or a file left by a hard kill. Give the
      // owner time to appear before treating the lock as garbage.
      if (Date.now() < waitUntil) {
        sleep(RETRY_DELAY_MS);
        continue;
      }
      breakLock(lockPath, undefined);
      tries += 1;
      continue;
    }

    breakLock(lockPath, holder);
    tries += 1;
  }
  return undefined;
}

export function readLockPid(lockPath: string): number | undefined {
  try {
    const n = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
