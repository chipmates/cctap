/** Client side of the socket protocol: one-shot state, live subscription, daemon spawn. */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WireSession } from './core/types.js';
import { encodeLine, parseLine, splitLines, PROTOCOL_VERSION } from './proto.js';
import { paths, socketPathError, type Paths } from './paths.js';

const CONNECT_TIMEOUT_MS = 1500;
const SPAWN_POLL_MS = 40;
const SPAWN_TIMEOUT_MS = 3000;
/** The daemon is ours, so a full state line is allowed to be large. Shared by the
 * one-shot read and the live subscription: they must tolerate the same sizes. */
const STATE_LINE_CAP = 64 * 1024 * 1024;

export function bundleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Prefer the daemon shipped next to this bundle, fall back to the installed stable
 * path. Keeps a freshly run CLI from talking to an older installed daemon build.
 */
export function daemonScript(p: Paths = paths()): string | undefined {
  const sibling = join(bundleDir(), 'daemon.mjs');
  if (fs.existsSync(sibling)) return sibling;
  if (fs.existsSync(p.daemonBin)) return p.daemonBin;
  return undefined;
}

export function connect(sock: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // Connecting to a truncated path would land us on someone else's daemon.
    const tooLong = socketPathError(sock);
    if (tooLong) {
      reject(new Error(tooLong));
      return;
    }
    const c = net.connect(sock);
    const t = setTimeout(() => {
      c.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    c.once('connect', () => {
      clearTimeout(t);
      resolve(c);
    });
    c.once('error', (err) => {
      clearTimeout(t);
      c.destroy();
      reject(err);
    });
  });
}

export async function isDaemonUp(p: Paths = paths()): Promise<boolean> {
  try {
    const c = await connect(p.sock, 300);
    c.destroy();
    return true;
  } catch {
    return false;
  }
}

/** Spawns the daemon detached with the absolute node path and waits for the socket. */
export async function ensureDaemon(p: Paths = paths()): Promise<boolean> {
  if (await isDaemonUp(p)) return true;
  const script = daemonScript(p);
  if (!script) return false;
  try {
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDaemonUp(p)) return true;
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
  }
  return false;
}

/** One `get_state` round trip. Returns undefined when no daemon is listening. */
export async function getState(p: Paths = paths()): Promise<WireSession[] | undefined> {
  let sock: net.Socket;
  try {
    sock = await connect(p.sock);
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = (v: WireSession[] | undefined): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), CONNECT_TIMEOUT_MS);
    timer.unref();
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const { lines, rest } = splitLines(buf, STATE_LINE_CAP);
      buf = rest;
      for (const line of lines) {
        const msg = parseLine(line);
        if (msg && msg.kind === 'state' && Array.isArray(msg.sessions)) {
          clearTimeout(timer);
          done(msg.sessions as WireSession[]);
          return;
        }
      }
    });
    sock.on('error', () => done(undefined));
    sock.on('close', () => done(undefined));
    sock.write(encodeLine({ v: PROTOCOL_VERSION, kind: 'get_state' }));
  });
}

/** A real get_state round trip, so a check cannot be fooled by an unserved socket file. */
export async function pingDaemon(p: Paths = paths()): Promise<boolean> {
  return (await getState(p)) !== undefined;
}

export interface Subscription {
  close(): void;
}

/** Full state now and on every change (CONTRACTS section 2). No deltas. */
export async function subscribe(
  p: Paths,
  onState: (sessions: WireSession[]) => void,
  onClose?: () => void,
  onMessage?: (msg: Record<string, unknown>) => void,
): Promise<Subscription | undefined> {
  let sock: net.Socket;
  try {
    sock = await connect(p.sock);
  } catch {
    return undefined;
  }
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    // Same cap as getState: a big state line must not silently stall a live renderer
    // on stale data while the one-shot path would have shown it.
    const { lines, rest } = splitLines(buf, STATE_LINE_CAP);
    buf = rest;
    for (const line of lines) {
      const msg = parseLine(line);
      if (!msg) continue;
      if (msg.kind === 'state' && Array.isArray(msg.sessions)) onState(msg.sessions as WireSession[]);
      else onMessage?.(msg);
    }
  });
  sock.on('error', () => onClose?.());
  sock.on('close', () => onClose?.());
  sock.write(encodeLine({ v: PROTOCOL_VERSION, kind: 'subscribe' }));
  return {
    close(): void {
      sock.destroy();
    },
  };
}

export interface PersistentHandlers {
  onState: (sessions: WireSession[]) => void;
  onMessage?: (msg: Record<string, unknown>) => void;
  /** Called on every connect and disconnect, so renderers can show the state. */
  onLink?: (up: boolean) => void;
}

/**
 * Subscribes and keeps resubscribing. A strip pane outlives daemon restarts, the
 * 24 h idle exit and `uninstall-hooks`, so a one-shot subscription is not enough.
 */
export function subscribePersistent(p: Paths, handlers: PersistentHandlers, retryMs = 2000): Subscription {
  let current: Subscription | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let linked = false;

  const setLink = (up: boolean): void => {
    if (linked === up) return;
    linked = up;
    handlers.onLink?.(up);
  };

  const schedule = (): void => {
    if (closed || timer) return;
    // Referenced on purpose: this timer is the only thing keeping an idle
    // renderer alive while the daemon is away.
    timer = setTimeout(() => {
      timer = undefined;
      void attempt();
    }, retryMs);
  };

  const attempt = async (): Promise<void> => {
    if (closed) return;
    const sub = await subscribe(p, handlers.onState, () => {
      current = undefined;
      setLink(false);
      schedule();
    }, handlers.onMessage);
    if (closed) {
      sub?.close();
      return;
    }
    if (!sub) {
      setLink(false);
      schedule();
      return;
    }
    current = sub;
    setLink(true);
  };

  void attempt();

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      current?.close();
    },
  };
}

/** Sends the awareness highlight the jump fallback broadcasts to renderers. */
export async function sendHighlight(p: Paths, sessionId: string, ms?: number): Promise<boolean> {
  try {
    const sock = await connect(p.sock, 500);
    await new Promise<void>((resolve) => {
      sock.end(encodeLine({ v: PROTOCOL_VERSION, kind: 'highlight', sessionId, ...(ms ? { ms } : {}) }), () =>
        resolve(),
      );
    });
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget event injection, used by `cctap simulate`. */
export function sendEvent(sock: net.Socket, msg: unknown): void {
  sock.write(encodeLine(msg));
}
