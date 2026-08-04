/** Shared test plumbing. Every test runs against a throwaway CCTAP_DIR, never ~/.cctap. */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as net from 'node:net';

/**
 * Deadline multiplier for slow machines. A 2-core CI runner cold-starts node processes
 * several times slower than a dev laptop, so the waits that mean "a daemon should be up
 * by now" need headroom there. Default 1: local runs stay strict, and CI sets the number
 * out loud in the workflow rather than every default being quietly enormous.
 */
export function slack(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.CCTAP_TEST_SLACK ?? '');
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/** A deadline in local milliseconds, stretched for whatever machine this is. */
export function ms(local: number): number {
  return Math.round(local * slack());
}

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(join(dir, 'package.json')) && fs.existsSync(join(dir, 'spec'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root not found');
}

export function distDir(): string {
  return join(repoRoot(), 'dist');
}

export function fixturesDir(): string {
  return join(repoRoot(), 'spec', 'fixtures');
}

/** Short paths on purpose: macOS caps unix socket paths at 104 bytes. */
export function tempDir(prefix = 'cctap-t-'): string {
  const base = fs.mkdtempSync(join(tmpdir(), prefix));
  if (join(base, 'cctap.sock').length > 100) {
    fs.rmSync(base, { recursive: true, force: true });
    return fs.mkdtempSync(join('/tmp', prefix));
  }
  return base;
}

export interface TempEnv {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Where a test can drop a fake binary that its child will find. Empty by default. */
export function fakeBinDir(t: TempEnv): string {
  return join(t.dir, 'path');
}

/**
 * Puts an executable `cctap` on the child's PATH, for the branch that asks what cctap
 * looks like when it is installed globally.
 */
export function linkFakeCctap(t: TempEnv): void {
  const bin = join(fakeBinDir(t), 'cctap');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
}

export function tempEnv(extra: NodeJS.ProcessEnv = {}): TempEnv {
  const dir = tempDir();
  // A controlled PATH, not the host's. cctap reads PATH to decide whether to teach
  // `cctap` or `npx cctap`, so a developer machine with a globally linked cctap would
  // otherwise render one thing locally and another in CI. Tests opt in with
  // linkFakeCctap(). The system dirs stay, because git, ps and script are real needs.
  const fakeBin = join(dir, 'path');
  fs.mkdirSync(fakeBin, { recursive: true });
  // No test may ever fire a real desktop banner. Theme is pinned because CI runners
  // have a non-UTF-8 locale and the auto-detection would flip every glyph assertion.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // No node bin dir: children are spawned with an absolute execPath, and that
    // directory is exactly where a globally linked cctap lives on a dev machine.
    PATH: [fakeBin, '/usr/bin', '/bin'].join(':'),
    CCTAP_DIR: dir,
    CCTAP_NOTIFY: 'off',
    CCTAP_NO_EXEC: '1',
    CCTAP_THEME: 'unicode',
    ...extra,
  };
  delete env.CCTAP_DEBUG;
  return {
    dir,
    env,
    cleanup(): void {
      try {
        const info = JSON.parse(fs.readFileSync(join(dir, 'daemon.json'), 'utf8')) as { pid?: number };
        if (info.pid) process.kill(info.pid, 'SIGKILL');
      } catch {
        /* no daemon */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  ms: number;
}

/** Runs a bundled script and captures stdout as raw bytes (I2 needs a byte count). */
export function runNode(
  script: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout running ${script}`));
    }, opts.timeoutMs ?? ms(20000));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        ms: Date.now() - started,
      });
    });
    // A child that caps its stdin stops reading, which lands here as EPIPE. That is the
    // behaviour under test, not a failure of it.
    child.stdin.on('error', () => {
      /* the child stopped reading */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Runs a bundled script with stdin held open, sending keys on a schedule. A real
 * terminal delivers these one keypress at a time through raw mode; a pipe delivers
 * them a line at a time, and both land in the same handler.
 */
export function runWithKeys(
  script: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; keys?: { after: number; send: string }[]; runMs?: number },
): Promise<{ text: string; exited: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => out.push(c));
    const timers = (opts.keys ?? []).map((k) => setTimeout(() => child.stdin.write(k.send), k.after));
    let settled = false;
    const done = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      clearTimeout(deadline);
      child.kill('SIGKILL');
      resolve({ text: Buffer.concat(out).toString('utf8'), exited });
    };
    const deadline = setTimeout(() => done(false), opts.runMs ?? 3000);
    child.on('close', () => done(true));
  });
}

/** Escape sequences out, carriage returns to newlines: what a human would have seen. */
export function visibleText(raw: string): string {
  return raw.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '\n');
}

export function startDaemon(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [join(distDir(), 'daemon.mjs')], {
    env,
    stdio: 'ignore',
    detached: false,
  });
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + ms(timeoutMs);
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function socketUp(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    // Referenced on purpose, and cleared on every path: an unref'd deadline is not a
    // deadline once the loop goes idle, which is how a wedged connect hangs a runner.
    let timer: NodeJS.Timeout | undefined;
    const done = (v: boolean): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      c.destroy();
      resolve(v);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    timer = setTimeout(() => done(false), ms(400));
  });
}

/** One `get_state` round trip against a running daemon. */
export function getStateRaw(sock: string, timeoutMs = 3000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    let buf = '';
    let settled = false;
    let t: NodeJS.Timeout | undefined;
    const done = (v: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      if (t) clearTimeout(t);
      c.destroy();
      resolve(v);
    };
    t = setTimeout(() => done(undefined), ms(timeoutMs));
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${JSON.stringify({ v: 1, kind: 'get_state' })}\n`));
    c.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        done(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch {
        done(undefined);
      }
    });
    c.on('error', () => done(undefined));
    c.on('close', () => done(undefined));
  });
}

export function sendLines(sock: string, lines: string[], timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    const t = setTimeout(() => {
      c.destroy();
      resolve(false);
    }, ms(timeoutMs));
    t.unref();
    c.on('connect', () => {
      c.end(lines.join(''), () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    c.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

export function wireEvent(opts: {
  event: string;
  sessionId: string;
  notif?: string;
  agentId?: string;
  toolName?: string;
  source?: string;
  cwd?: string;
  message?: string;
  reason?: string;
  ppid?: number;
  env?: Record<string, string>;
  ts?: number;
}): string {
  const hook: Record<string, unknown> = {
    session_id: opts.sessionId,
    hook_event_name: opts.event,
  };
  if (opts.agentId) hook.agent_id = opts.agentId;
  if (opts.toolName) hook.tool_name = opts.toolName;
  if (opts.source) hook.source = opts.source;
  if (opts.cwd) hook.cwd = opts.cwd;
  if (opts.message) hook.message = opts.message;
  if (opts.reason) hook.reason = opts.reason;
  const tag: Record<string, string> = { event: opts.event };
  if (opts.notif) tag.notif = opts.notif;
  return `${JSON.stringify({
    v: 1,
    kind: 'event',
    ts: opts.ts ?? Date.now(),
    tag,
    hook,
    env: opts.env ?? {},
    ppid: opts.ppid ?? process.pid,
  })}\n`;
}

/**
 * How tmux echoes a command back in `list-keys`: a backslash before each double quote
 * and each backslash, and nothing else. Fixtures build their fake rows through this so
 * they escape exactly what tmux escapes. Escaping only the quote happened to work while
 * no fixture held a backslash, which is a simulation that would drift the day one did.
 */
export function tmuxEcho(command: string): string {
  return command.replace(/[\\"]/g, (c) => `\\${c}`);
}
