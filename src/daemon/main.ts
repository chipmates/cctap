/**
 * The daemon: one state model, one socket, no network. Owns liveness, persistence
 * and every side effect the reducer is not allowed to have (I10).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { labelSessions, sortSessions } from '../core/labels.js';
import { loadConfig } from '../config.js';
import { realExec } from '../exec.js';
import { bannersOn, bellAlways, Notifier, notifyEnabled, togglesFrom } from './notify.js';
import {
  ENDED_TTL_MS,
  LIVENESS_GRACE_MS,
  markAlive,
  markDead,
  markStaleCandidates,
  reduce,
  removeSession,
  setResolved,
  sweep,
} from '../core/reducer.js';
import { emptyModel, type Model, type Session, type WireSession } from '../core/types.js';
import type { StateMsg } from '../proto.js';
import { HIGHLIGHT_MS } from '../proto.js';
import { ensureDirs, FILE_MODE, paths, repairAllModes, socketPathError, writeFileAtomic, type Paths } from '../paths.js';
import { encodeLine, parseLine, splitLines, PROTOCOL_VERSION, type WireEvent } from '../proto.js';
import { VERSION } from '../version.js';
import { acquireLock, pidAlive, type LockHandle } from './lock.js';
import { isWireEvent, normalize, observedEnvKeys } from './normalize.js';
import { projectLabel, RepoResolver, resolveTty } from './resolve.js';
import {
  loadSnapshot,
  PPID_TRUST_MS,
  serialize,
  SnapshotWriter,
  SNAPSHOT_DEBOUNCE_MS,
  type Observed,
} from './snapshot.js';
import { replaySpool } from './spool.js';

export const SWEEP_INTERVAL_MS = 60 * 1000;
export const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface DaemonConfig {
  sweepIntervalMs: number;
  livenessGraceMs: number;
  endedTtlMs: number;
  snapshotDebounceMs: number;
  idleExitMs: number;
}

/** Defaults are the spec values; the overrides exist so tests do not sleep for minutes. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    sweepIntervalMs: num(env, 'CCTAP_SWEEP_INTERVAL_MS', SWEEP_INTERVAL_MS),
    livenessGraceMs: num(env, 'CCTAP_LIVENESS_GRACE_MS', LIVENESS_GRACE_MS),
    endedTtlMs: num(env, 'CCTAP_ENDED_TTL_MS', ENDED_TTL_MS),
    snapshotDebounceMs: num(env, 'CCTAP_SNAPSHOT_DEBOUNCE_MS', SNAPSHOT_DEBOUNCE_MS),
    idleExitMs: num(env, 'CCTAP_IDLE_EXIT_MS', IDLE_EXIT_MS),
  };
}

export function toWire(s: Session): WireSession {
  const { deadSince: _d, staleCandidate: _s, ...wire } = s;
  return wire;
}

/** Is something actually serving this socket? Cheap, local, and short-fused. */
function socketAnswers(sock: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}

export class Daemon {
  private model: Model = emptyModel();
  private observed: Observed = { subagentEvents: false, envKeys: [], firstSeen: {} };
  private readonly subscribers = new Set<net.Socket>();
  private readonly repo = new RepoResolver();
  private readonly resolvedCwd = new Map<string, string>();
  private readonly ttyResolved = new Set<string>();
  private readonly projectDirs = new Map<string, string>();
  private server: net.Server | undefined;
  /** True only while this process holds the bound server for the socket path. */
  private served = false;
  private lock: LockHandle | undefined;
  private snapshots: SnapshotWriter | undefined;
  private notifier: Notifier | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private lastBusyTs = Date.now();
  private stopping = false;
  /** True until the snapshot restore and spool replay have settled (no banners yet). */
  private starting = true;

  constructor(
    private readonly p: Paths = paths(),
    private readonly cfg: DaemonConfig = configFromEnv(),
  ) {}

  get sessionsForTest(): Model {
    return this.model;
  }

  /** Resolves false when another live daemon already holds the lock (I9). */
  async start(): Promise<boolean> {
    ensureDirs(this.p);
    this.lock = acquireLock(this.p.lock);
    if (!this.lock) return false;
    repairAllModes(this.p);

    const restored = loadSnapshot(this.p.state);
    if (restored) {
      // A snapshot old enough that its pids may have been recycled cannot be trusted to
      // prove anything alive: drop the recorded ppid so those sessions have to earn their
      // place with a real event instead of haunting the board forever.
      const stale = Date.now() - (restored.savedAt ?? 0) > PPID_TRUST_MS;
      this.model = markStaleCandidates(restored.model, stale);
      this.observed = restored.observed;
    }

    this.snapshots = new SnapshotWriter(
      this.p.state,
      () => serialize(this.model, this.observed, VERSION, Date.now()),
      this.cfg.snapshotDebounceMs,
    );

    if (notifyEnabled()) {
      // The notifier still runs with banners off: the tmux message is terminal-native.
      const cfg = loadConfig(this.p);
      this.notifier = new Notifier({
        exec: realExec,
        toggles: togglesFrom(cfg.notify),
        desktop: bannersOn(cfg.notify),
        alwaysBell: bellAlways(),
        onBell: (sessionId) => this.broadcastLine(encodeLine({ v: PROTOCOL_VERSION, kind: 'bell', sessionId })),
      });
    }

    replaySpool(this.p.spool, (msg) => this.handleMessage(msg, undefined));

    // Losing here means someone else is serving: leave their socket alone and stand down.
    if (!(await this.listen())) {
      this.snapshots?.stop();
      this.lock?.release();
      this.lock = undefined;
      return false;
    }
    // A forwarder that gave up during our startup spooled its event between the
    // first replay and the socket going live. Claim that window immediately.
    replaySpool(this.p.spool, (msg) => this.handleMessage(msg, undefined));
    this.writeDaemonInfo();

    // Restored sessions are unproven: settle them before the first renderer connects.
    this.sweepNow();

    // Everything up to here is history: a snapshot restore and a spool replay must
    // never fire a burst of banners for transitions the user already lived through.
    // Adopt the settled state, then notify only on what happens from now on.
    this.notifier?.seed(this.wireSessions());
    this.starting = false;

    this.sweepTimer = setInterval(() => this.sweepNow(), this.cfg.sweepIntervalMs);
    this.sweepTimer.unref();

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => this.stop(0));
    }
    return true;
  }

  /** Resolves false when another daemon is already serving this socket. */
  private listen(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Binding a truncated path would serve, and be served by, another instance.
      const tooLong = socketPathError(this.p.sock);
      if (tooLong) {
        reject(new Error(tooLong));
        return;
      }
      const server = net.createServer((sock) => this.onConnection(sock));
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }
        // We hold the lock, so this is normally a leftover file. Normally is not
        // always: check for a live server before removing someone else's socket.
        void socketAnswers(this.p.sock).then((busy) => {
          if (busy) {
            resolve(false);
            return;
          }
          try {
            fs.unlinkSync(this.p.sock);
            server.listen(this.p.sock, () => this.afterListen(server, () => resolve(true)));
          } catch (e) {
            reject(e);
          }
        });
      });
      server.listen(this.p.sock, () => this.afterListen(server, () => resolve(true)));
    });
  }

  private afterListen(server: net.Server, resolve: () => void): void {
    this.server = server;
    this.served = true;
    // I5: the socket is 0600 like everything else under the directory.
    try {
      fs.chmodSync(this.p.sock, FILE_MODE);
    } catch {
      /* best effort */
    }
    resolve();
  }

  private writeDaemonInfo(): void {
    try {
      writeFileAtomic(
        this.p.daemonInfo,
        `${JSON.stringify(
          { pid: process.pid, version: VERSION, startedAt: Date.now(), socket: this.p.sock, v: PROTOCOL_VERSION },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* informational only */
    }
  }

  private onConnection(sock: net.Socket): void {
    this.lastBusyTs = Date.now();
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const { lines, rest, overflow } = splitLines(buf);
      buf = rest;
      if (overflow) {
        // I11: an over-long line is hostile or broken; drop the connection.
        sock.destroy();
        return;
      }
      for (const line of lines) {
        const msg = parseLine(line);
        if (!msg) continue;
        this.handleMessage(msg, sock);
      }
    });
    sock.on('close', () => this.subscribers.delete(sock));
  }

  private handleMessage(msg: Record<string, unknown>, sock: net.Socket | undefined): void {
    try {
      if (isWireEvent(msg)) {
        this.applyEvent(msg as unknown as WireEvent);
        return;
      }
      if (msg.kind === 'subscribe' && sock) {
        this.subscribers.add(sock);
        this.lastBusyTs = Date.now();
        this.send(sock);
        return;
      }
      if (msg.kind === 'get_state' && sock) {
        this.send(sock);
        sock.end();
        return;
      }
      if (msg.kind === 'highlight' && typeof msg.sessionId === 'string') {
        // The jump fallback: renderers flag the session for a few seconds.
        this.broadcastLine(
          encodeLine({
            v: PROTOCOL_VERSION,
            kind: 'highlight',
            sessionId: msg.sessionId,
            ms: typeof msg.ms === 'number' ? msg.ms : HIGHLIGHT_MS,
          }),
        );
        return;
      }
      // Unknown kind: ignored (CONTRACTS section 2).
    } catch {
      /* I11: malformed input never crashes the daemon */
    }
  }

  private applyEvent(wire: WireEvent): void {
    const now = Date.now();
    const ev = normalize(wire, now);
    if (!ev) return;

    const before = this.model;
    this.model = reduce(this.model, ev);
    if (this.model === before) return;

    if (ev.agentId) this.observed.subagentEvents = true;
    for (const k of observedEnvKeys(wire.env ?? {})) {
      if (!this.observed.envKeys.includes(k)) this.observed.envKeys.push(k);
    }
    if (ev.meta?.projectDir) this.projectDirs.set(ev.sessionId, ev.meta.projectDir);
    // Which registrations have actually fired, so doctor can name the silent ones.
    const seenKey = ev.notif ? `${ev.event}(${ev.notif})` : ev.event;
    this.observed.firstSeen ??= {};
    this.observed.firstSeen[seenKey] ??= now;

    this.lastBusyTs = now;
    const session = this.model.sessions[ev.sessionId];
    if (session) {
      const forced = ev.event === 'CwdChanged';
      void this.resolveSession(session.sessionId, forced);
      void this.resolveSessionTty(session.sessionId);
    }
    this.changed();
  }

  /** Project + branch for a session, only when its cwd is new or a CwdChanged forced it. */
  private async resolveSession(sessionId: string, force: boolean): Promise<void> {
    const s = this.model.sessions[sessionId];
    if (!s) return;
    const cwd = s.cwd;
    if (!cwd) {
      // No cwd yet: the captured project dir is the only label we can offer.
      const dir = this.projectDirFor(sessionId);
      if (dir && s.project === '') {
        const next = setResolved(this.model, sessionId, { project: projectLabel(dir, '', '') });
        if (next !== this.model) {
          this.model = next;
          this.changed();
        }
      }
      return;
    }
    // A repeat call for the same cwd still goes through, so the TTL can expire and
    // pick up a branch switch. RepoResolver decides whether that costs a git spawn.
    if (!force && this.resolvedCwd.get(sessionId) === cwd && s.project !== '' && !this.repoStale(cwd)) return;
    this.resolvedCwd.set(sessionId, cwd);
    if (force) this.repo.invalidate(cwd);

    const info = await this.repo.resolve(cwd, Date.now(), force);
    const current = this.model.sessions[sessionId];
    if (!current || current.cwd !== cwd) return;
    // A forced refresh reads the repo once and then hides behind a fresh cache entry, so
    // every other session in the same directory would keep its old branch until the TTL
    // expired. Fold the answer into all of them, not just the one that asked.
    let next = this.model;
    for (const peer of Object.values(next.sessions)) {
      if (peer.cwd !== cwd) continue;
      if (peer.sessionId !== sessionId && !force) continue;
      const project = projectLabel(this.projectDirFor(peer.sessionId), info.root, cwd);
      next = setResolved(next, peer.sessionId, { project, branch: info.branch });
    }
    if (next !== this.model) {
      this.model = next;
      this.changed();
    }
  }

  private repoStale(cwd: string): boolean {
    return this.repo.cached(cwd, Date.now()) === undefined;
  }

  private projectDirFor(sessionId: string): string | undefined {
    return this.projectDirs.get(sessionId);
  }

  private async resolveSessionTty(sessionId: string): Promise<void> {
    const s = this.model.sessions[sessionId];
    if (!s || this.ttyResolved.has(sessionId) || s.ppid <= 0) return;
    this.ttyResolved.add(sessionId);
    const tty = await resolveTty(s.ppid);
    if (!tty) return;
    const next = setResolved(this.model, sessionId, { terminal: { tty } });
    if (next !== this.model) {
      this.model = next;
      this.changed();
    }
  }

  private changed(): void {
    this.snapshots?.schedule();
    const sessions = this.wireSessions();
    if (!this.starting) this.notifier?.onState(sessions, labelSessions(sessions));
    if (this.subscribers.size > 0) this.broadcastLine(encodeLine(this.stateMessageFor(sessions)));
  }

  private wireSessions(): WireSession[] {
    return sortSessions(Object.values(this.model.sessions).map(toWire));
  }

  private stateMessageFor(sessions: WireSession[]): StateMsg {
    return { v: PROTOCOL_VERSION, kind: 'state', sessions };
  }

  private stateMessage(): string {
    return encodeLine(this.stateMessageFor(this.wireSessions()));
  }

  private send(sock: net.Socket): void {
    try {
      sock.write(this.stateMessage());
    } catch {
      /* peer went away */
    }
  }

  private broadcast(): void {
    if (this.subscribers.size === 0) return;
    this.broadcastLine(this.stateMessage());
  }

  private broadcastLine(line: string): void {
    for (const sock of this.subscribers) {
      try {
        sock.write(line);
      } catch {
        this.subscribers.delete(sock);
      }
    }
  }

  /** process.kill(ppid, 0): gone starts the grace clock, alive cancels it. */
  private livenessPass(now: number): void {
    for (const s of Object.values(this.model.sessions)) {
      if (s.ppid > 0) {
        this.model = pidAlive(s.ppid) ? markAlive(this.model, s.sessionId) : markDead(this.model, s.sessionId, now);
      } else if (s.staleCandidate) {
        // Restored without a usable ppid: age it out like a dead process.
        this.model = markDead(this.model, s.sessionId, now);
      }
    }
  }

  sweepNow(): void {
    const now = Date.now();
    void this.healSocket();
    const before = this.model;
    // Anything a forwarder spooled while we were busy or briefly unreachable.
    replaySpool(this.p.spool, (msg) => this.handleMessage(msg, undefined));
    this.livenessPass(now);
    this.model = sweep(this.model, now, {
      endedTtlMs: this.cfg.endedTtlMs,
      livenessGraceMs: this.cfg.livenessGraceMs,
    });
    for (const id of [...this.resolvedCwd.keys()]) {
      if (!this.model.sessions[id]) {
        this.resolvedCwd.delete(id);
        this.ttyResolved.delete(id);
        this.projectDirs.delete(id);
      }
    }
    // Branch can move under a long-lived session. The 60 s cache TTL does the
    // throttling, so this must not force: forcing spawns two gits per session per minute.
    for (const s of Object.values(this.model.sessions)) {
      if (s.cwd) void this.resolveSession(s.sessionId, false);
    }
    if (this.model !== before) this.changed();

    // Sessions that have never proved themselves since the restore do not count as
    // activity: a single ghost would otherwise hold the 24 hour idle exit open forever.
    const proven = Object.values(this.model.sessions).filter((s) => !s.staleCandidate).length;
    if (proven > 0 || this.subscribers.size > 0) {
      this.lastBusyTs = now;
    } else if (now - this.lastBusyTs >= this.cfg.idleExitMs) {
      this.stop(0);
    }
  }

  /**
   * A socket file that was deleted under a live daemon leaves it listening on an inode
   * nobody can reach: hooks spool, renderers see nothing, and only a manual stop cures
   * it. Notice on the sweep and bind again.
   */
  private async healSocket(): Promise<void> {
    if (!this.served || this.stopping) return;
    if (fs.existsSync(this.p.sock)) return;
    try {
      this.server?.close();
    } catch {
      /* it is already unreachable */
    }
    this.server = undefined;
    this.served = false;
    try {
      if (await this.listen()) this.writeDaemonInfo();
    } catch {
      /* the next sweep tries again */
    }
  }

  /** Used by uninstall and tests. */
  dropSession(sessionId: string): void {
    const next = removeSession(this.model, sessionId);
    if (next !== this.model) {
      this.model = next;
      this.changed();
    }
  }

  stop(code = 0, exit = true): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.snapshots?.stop();
    this.snapshots?.flush();
    for (const sock of this.subscribers) {
      try {
        sock.end();
      } catch {
        /* ignore */
      }
    }
    this.subscribers.clear();
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    // Only the daemon that is actually serving may remove the socket path. Unlinking it
    // blind lets a stale process take a live daemon's socket away on its way out.
    const files = this.served ? [this.p.sock, this.p.daemonInfo] : [this.p.daemonInfo];
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    this.lock?.release();
    if (exit) process.exit(code);
  }
}

export async function runDaemon(): Promise<void> {
  try {
    const d = new Daemon(paths(), configFromEnv());
    const won = await d.start();
    // I9: the losing racer exits silently while the winner serves.
    if (!won) process.exit(0);
  } catch (err) {
    // Loud on every start failure: a daemon that cannot bind is worth a line, and the
    // detached spawn path has stdio ignored anyway, so nothing leaks into a session.
    process.stderr.write(`cctap daemon: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
