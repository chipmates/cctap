/**
 * Hook forwarder. Runs inside every Claude Code hook invocation, so it lives under
 * four hard rules: always exit 0 (I1), never write stdout (I2), be gone inside
 * 100 ms (I3), never lose an event (I4).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { encodeLine, type WireEvent } from './proto.js';
import { buildWireEvent } from './hook/wire.js';
import { ensureDirs, paths, repairFileMode, socketPathError } from './paths.js';
import { rotateSpool } from './daemon/spool.js';

const TOTAL_BUDGET_MS = 100;
/** Leaves room for a synchronous spool write before the hard 100 ms wall. */
const DEADLINE_MS = 80;
const SPAWN_WAIT_MS = 40;
const CONNECT_TIMEOUT_MS = 25;

let done = false;
let delivered = false;
const chunks: Buffer[] = [];
let stdinBytes = 0;
const startedAt = Date.now();

/**
 * Hook payloads are small. A huge one is a bug or an attack, and reading it all costs
 * the I3 budget: 25 MiB measured 257 ms in the encode alone. Read a bounded prefix and
 * drop the rest; the whitelist truncation downstream keeps the wire line legal either way.
 */
const STDIN_MAX_BYTES = 2 * 1024 * 1024;

function debug(msg: string): void {
  if (process.env.CCTAP_DEBUG === '1') {
    try {
      process.stderr.write(`cctap hook: ${msg}\n`);
    } catch {
      /* stderr may be closed */
    }
  }
}

function finish(): never {
  done = true;
  // Lets `doctor` and the test suite measure the real I3 budget from outside.
  debug(`done in ${Date.now() - startedAt}ms delivered=${delivered}`);
  process.exit(0);
}

/**
 * One id per hook invocation, so the delivered and the spooled copy of this event are
 * the same event. The retry path can deliver and spool the same thing when a write is
 * accepted but its flush callback misses the deadline, and an anonymous SubagentStart is
 * a counter, so a duplicate skews the tree. The daemon drops a repeated id.
 */
const EVENT_ID = randomUUID();

/**
 * Built once. The delivered line, the retried line and the spooled line must be the same
 * bytes for the id above to mean anything, and encoding a capped payload three times
 * costs the I3 budget for nothing.
 */
let builtEvent: WireEvent | undefined;
let builtLine: string | undefined;

function currentEvent(): WireEvent {
  builtEvent ??= buildWireEvent(
    Buffer.concat(chunks).toString('utf8'),
    process.argv.slice(2),
    process.env,
    Date.now(),
    process.ppid,
    EVENT_ID,
  );
  return builtEvent;
}

function currentLine(): string {
  builtLine ??= encodeLine(currentEvent());
  return builtLine;
}

/** Does this payload carry something the daemon can hang state on? */
function attributable(): boolean {
  const id = currentEvent().hook.session_id;
  return typeof id === 'string' && id !== '';
}

function spool(line: string): void {
  // I4: an unreachable daemon must never silently drop a permission prompt.
  try {
    const p = paths();
    ensureDirs(p);
    fs.appendFileSync(p.spool, line, { mode: 0o600 });
    repairFileMode(p.spool);
    const dropped = rotateSpool(p.spool);
    debug(dropped > 0 ? `spooled, dropped ${dropped} old` : 'spooled');
  } catch (err) {
    debug(`spool failed: ${String(err)}`);
  }
}

function tryDeliver(sock: string, line: string, cb: (ok: boolean) => void): void {
  let settled = false;
  const settle = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    cb(ok);
  };
  let conn: net.Socket;
  try {
    conn = net.connect(sock);
  } catch (err) {
    debug(`connect threw: ${String(err)}`);
    settle(false);
    return;
  }
  conn.setTimeout(CONNECT_TIMEOUT_MS);
  conn.on('timeout', () => {
    conn.destroy();
    settle(false);
  });
  conn.on('error', (err: Error) => {
    debug(`socket error: ${err.message}`);
    conn.destroy();
    settle(false);
  });
  conn.on('connect', () => {
    conn.end(line, () => {
      delivered = true;
      settle(true);
    });
  });
}

function spawnDaemon(): void {
  try {
    const p = paths();
    if (!fs.existsSync(p.daemonBin)) {
      debug(`no daemon at ${p.daemonBin}`);
      return;
    }
    // Absolute node path: bare `node` breaks under nvm and GUI-spawned contexts.
    const child = spawn(process.execPath, [p.daemonBin], { detached: true, stdio: 'ignore' });
    child.on('error', (err: Error) => debug(`spawn failed: ${err.message}`));
    child.unref();
  } catch (err) {
    debug(`spawn threw: ${String(err)}`);
  }
}

function readStdin(onDone: () => void): void {
  let finished = false;
  const flush = (): void => {
    if (finished) return;
    finished = true;
    onDone();
  };
  try {
    process.stdin.on('data', (c: Buffer) => {
      if (stdinBytes >= STDIN_MAX_BYTES) return;
      const room = STDIN_MAX_BYTES - stdinBytes;
      const piece = c.length > room ? c.subarray(0, room) : c;
      chunks.push(piece);
      stdinBytes += piece.length;
      if (stdinBytes >= STDIN_MAX_BYTES) {
        debug(`stdin capped at ${STDIN_MAX_BYTES} bytes`);
        flush();
      }
    });
    process.stdin.on('end', flush);
    process.stdin.on('error', flush);
    process.stdin.on('close', flush);
    process.stdin.resume();
  } catch {
    flush();
  }
}

export function main(): void {
  // I1: nothing escapes, ever.
  process.on('uncaughtException', (err) => {
    debug(`uncaught: ${String(err)}`);
    finish();
  });
  process.on('unhandledRejection', (err) => {
    debug(`unhandled: ${String(err)}`);
    finish();
  });

  const p = paths();

  // I3: one referenced wall-clock deadline governs every path below. It stays
  // referenced so the process cannot exit before the spool fallback runs (I4).
  setTimeout(() => {
    if (done) return;
    if (!delivered) spool(currentLine());
    finish();
  }, DEADLINE_MS);
  setTimeout(finish, TOTAL_BUDGET_MS).unref();

  readStdin(() => {
    // N2: with no session id the daemon can never attribute this, so sending or spooling
    // it only costs disk and noise. I1 and I2 still hold: exit 0, nothing on stdout.
    if (!attributable()) {
      debug('no session id in the payload, dropping');
      finish();
    }
    const line = currentLine();
    // A truncated socket path belongs to whichever instance got there first, so the
    // event goes to the spool instead of into a stranger's daemon. I1 and I2 hold.
    const tooLong = socketPathError(p.sock);
    if (tooLong) {
      debug(tooLong);
      spool(line);
      finish();
    }
    tryDeliver(p.sock, line, (ok) => {
      if (ok) finish();
      // Connect failed: start a daemon, give it a moment, try exactly once more.
      spawnDaemon();
      setTimeout(() => {
        tryDeliver(p.sock, line, (ok2) => {
          if (!ok2) spool(line);
          finish();
        });
      }, SPAWN_WAIT_MS);
    });
  });
}

main();
