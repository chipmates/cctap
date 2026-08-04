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
  SUBAGENT_STALL_MS,
  sweep,
} from '../core/reducer.js';
import { emptyModel, usablePpid, type Model, type Session, type WireSession } from '../core/types.js';
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
  REGISTRATION_KEYS,
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

/**
 * Subscribers get the whole board on every change, so a reader that has stopped reading
 * grows the daemon's memory with state nobody will ever look at. Dropping one is
 * lossless: it reconnects and the next frame is the complete truth again, which is why
 * this needs no flow-control protocol.
 */
export const SUBSCRIBER_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** I17: enough redelivery ids to cover a burst, bounded so memory cannot grow. */
export const SEEN_EID_MAX = 2048;

export interface DaemonConfig {
  sweepIntervalMs: number;
  livenessGraceMs: number;
  endedTtlMs: number;
  snapshotDebounceMs: number;
  idleExitMs: number;
  subagentStallMs: number;
}

/** Defaults are the spec values; the overrides exist so tests do not sleep for minutes. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    sweepIntervalMs: num(env, 'CCTAP_SWEEP_INTERVAL_MS', SWEEP_INTERVAL_MS),
    livenessGraceMs: num(env, 'CCTAP_LIVENESS_GRACE_MS', LIVENESS_GRACE_MS),
    endedTtlMs: num(env, 'CCTAP_ENDED_TTL_MS', ENDED_TTL_MS),
    snapshotDebounceMs: num(env, 'CCTAP_SNAPSHOT_DEBOUNCE_MS', SNAPSHOT_DEBOUNCE_MS),
    idleExitMs: num(env, 'CCTAP_IDLE_EXIT_MS', IDLE_EXIT_MS),
    subagentStallMs: num(env, 'CCTAP_SUBAGENT_STALL_MS', SUBAGENT_STALL_MS),
  };
}

export function toWire(s: Session): WireSession {
  const { deadSince: _d, staleCandidate: _s, lastAgentEventTs: _l, subagentsClearedAt: _c, ...wire } = s;
  return wire;
}

/** Long enough to notice, short enough that a renderer is never stuck flagging. */
export const HIGHLIGHT_MIN_MS = 250;
export const HIGHLIGHT_MAX_MS = 60_000;

function clampHighlightMs(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return HIGHLIGHT_MS;
  return Math.min(HIGHLIGHT_MAX_MS, Math.max(HIGHLIGHT_MIN_MS, ms));
}

/**
 * The socket path is configurable, so it can point anywhere. Removing a stale socket is
 * routine; removing whatever else happens to sit at that path is data loss committed by a
 * background process. A non-socket there is a configuration conflict, and saying so is
 * the only correct move.
 */
function unlinkSocketPath(sock: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(sock);
  } catch {
    return; // already gone, which is what we wanted
  }
  if (!st.isSocket()) {
    throw new Error(`${sock} exists and is not a socket, refusing to remove it (check the configured socket path)`);
  }
  fs.unlinkSync(sock);
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
  private readonly seenEids = new Set<string>();
  private server: net.Server | undefined;
  /**
   * True only while this process holds the bound server for the socket path. It must keep
   * meaning exactly that: `stop()` decides whether to unlink the socket from it, and a
   * daemon that intends to rebind has not bound anything yet.
   */
  private served = false;
  /** A heal is owed: `served` went false on purpose and the rebind has not succeeded. */
  private healPending = false;
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

  private debug(what: string, err: unknown): void {
    if (process.env.CCTAP_DEBUG !== '1') return;
    try {
      process.stderr.write(`cctap daemon: ${what} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      /* stderr may be closed */
    }
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

    // Nothing touches the spool before we know we are the one serving. Replaying first
    // meant the losing racer consumed and deleted events on its way out, and they never
    // reached the daemon that was actually going to serve them.
    //
    // Losing here means someone else is serving: leave their socket alone and stand down.
    if (!(await this.listen())) {
      this.snapshots?.stop();
      this.lock?.release();
      this.lock = undefined;
      return false;
    }
    // The backlog, plus anything a forwarder spooled while we were starting up. The
    // sweep repeats this, so an event that lands between these two lines is not lost.
    this.replayBacklog();
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
      // I5 at birth: bind() creates the socket file with the umask applied, so a
      // permissive umask exposes a wider mode until the chmod in afterListen runs.
      // 0o177 makes it come into being at 0600; afterListen stays as the repair.
      const prevUmask = process.umask(0o177);
      const restoreUmask = (): void => {
        process.umask(prevUmask);
      };
      const server = net.createServer((sock) => this.onConnection(sock));
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          restoreUmask();
          reject(err);
          return;
        }
        // We hold the lock, so this is normally a leftover file. Normally is not
        // always: check for a live server before removing someone else's socket.
        void socketAnswers(this.p.sock).then((busy) => {
          if (busy) {
            restoreUmask();
            resolve(false);
            return;
          }
          try {
            unlinkSocketPath(this.p.sock);
            server.listen(this.p.sock, () => {
              restoreUmask();
              this.afterListen(server, () => resolve(true));
            });
          } catch (e) {
            restoreUmask();
            reject(e);
          }
        });
      });
      server.listen(this.p.sock, () => {
        restoreUmask();
        this.afterListen(server, () => resolve(true));
      });
    });
  }

  private afterListen(server: net.Server, resolve: () => void): void {
    this.server = server;
    this.served = true;
    this.healPending = false;
    // I5: the socket is 0600 like everything else under the directory.
    try {
      fs.chmodSync(this.p.sock, FILE_MODE);
    } catch {
      /* best effort */
    }
    resolve();
  }

  /** Drains the spool, keeping the count of anything it had to throw away. */
  private replayBacklog(): void {
    const { dropped } = replaySpool(this.p.spool, (msg) => this.handleMessage(msg, undefined));
    if (dropped > 0) {
      this.observed.spoolDropped = (this.observed.spoolDropped ?? 0) + dropped;
      this.snapshots?.schedule();
    }
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
      // A numeric `v` that is not ours describes a protocol we would be guessing at.
      if (typeof msg.v === 'number' && msg.v !== PROTOCOL_VERSION) return;
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
            ms: clampHighlightMs(msg.ms),
          }),
        );
        return;
      }
      // Unknown kind: ignored (CONTRACTS section 2).
    } catch {
      /* I11: malformed input never crashes the daemon */
    }
  }

  /**
   * I17. The forwarder can both deliver and spool one event: the socket write is accepted
   * but its flush callback misses the deadline, so the fallback fires on something that
   * did arrive. Anonymous SubagentStart and SubagentStop are counters, so a duplicate
   * inflates the tree and the session spins forever. Dropped here rather than in the
   * reducer, which stays pure and has no memory to dedupe against.
   */
  private duplicate(eid: unknown): boolean {
    if (typeof eid !== 'string' || eid === '') return false;
    if (this.seenEids.has(eid)) return true;
    this.seenEids.add(eid);
    if (this.seenEids.size > SEEN_EID_MAX) {
      // Insertion-ordered, so the first key is the oldest.
      const oldest = this.seenEids.values().next();
      if (!oldest.done) this.seenEids.delete(oldest.value);
    }
    return false;
  }

  private applyEvent(wire: WireEvent): void {
    const now = Date.now();
    if (this.duplicate(wire.eid)) return;
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
    // Which registrations have actually fired, so doctor can name the silent ones. Event
    // names are input, so only the ones naming a real registration are recorded: the map
    // is persisted, and an unfiltered one grows without bound on whatever gets sent.
    const seenKey = ev.notif ? `${ev.event}(${ev.notif})` : ev.event;
    if (REGISTRATION_KEYS.has(seenKey)) {
      this.observed.firstSeen ??= {};
      this.observed.firstSeen[seenKey] ??= now;
    }

    this.lastBusyTs = now;
    const session = this.model.sessions[ev.sessionId];
    if (session) {
      const forced = ev.event === 'CwdChanged';
      void this.resolveSession(session.sessionId, forced).catch((e: unknown) => this.debug('resolve', e));
      void this.resolveSessionTty(session.sessionId).catch((e: unknown) => this.debug('resolve tty', e));
      // The one state worth surviving a crash: a permission prompt the user has not seen
      // yet. Everything else the restart can infer or sweep.
      if (session.displayState === 'permission_wait' && before.sessions[ev.sessionId]?.displayState !== 'permission_wait') {
        this.snapshots?.schedule();
        this.snapshots?.flush();
      }
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
    if (!s || this.ttyResolved.has(sessionId) || !usablePpid(s.ppid)) return;
    // Marked before the await on purpose: it is what stops concurrent events from each
    // spawning a `ps` for the same session.
    this.ttyResolved.add(sessionId);
    const tty = await resolveTty(s.ppid);
    if (!tty) {
      // But one flaky `ps` must not disable this session's focus adapter for good. The
      // marker only survives a resolve that actually resolved something.
      this.ttyResolved.delete(sessionId);
      return;
    }
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
        // A subscriber that has stopped reading (a stopped process, a hung pane) would
        // otherwise buffer the whole board on every change, without bound, inside the
        // daemon. Dropping it costs nothing: the protocol sends full state every time,
        // so a reconnect is complete, which is why there is no flow control to negotiate.
        if (sock.writableLength > SUBSCRIBER_MAX_BUFFERED_BYTES) {
          this.subscribers.delete(sock);
          sock.destroy();
          continue;
        }
        sock.write(line);
      } catch {
        this.subscribers.delete(sock);
      }
    }
  }

  /** process.kill(ppid, 0): gone starts the grace clock, alive cancels it. */
  private livenessPass(now: number): void {
    for (const s of Object.values(this.model.sessions)) {
      // A pid this pass will not check is a pid it must not vouch for either: a snapshot
      // written before init was rejected would otherwise keep answering alive forever.
      if (usablePpid(s.ppid)) {
        this.model = pidAlive(s.ppid) ? markAlive(this.model, s.sessionId) : markDead(this.model, s.sessionId, now);
      } else if (s.staleCandidate) {
        // Restored without a usable ppid: age it out like a dead process.
        this.model = markDead(this.model, s.sessionId, now);
      }
    }
  }

  sweepNow(): void {
    const now = Date.now();
    void this.healSocket().catch((e: unknown) => this.debug('socket heal', e));
    const before = this.model;
    // Anything a forwarder spooled while we were busy or briefly unreachable.
    this.replayBacklog();
    this.livenessPass(now);
    this.model = sweep(this.model, now, {
      endedTtlMs: this.cfg.endedTtlMs,
      livenessGraceMs: this.cfg.livenessGraceMs,
      subagentStallMs: this.cfg.subagentStallMs,
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
      if (s.cwd) void this.resolveSession(s.sessionId, false).catch((e: unknown) => this.debug('resolve', e));
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
    // Run while serving (to notice a deleted socket) and while a heal is owed. `served`
    // alone made this one-shot: it goes false before the rebind, so a failed rebind left
    // a live, lock-holding daemon permanently unreachable with no sweep coming back to
    // it. `healPending` is the intent, kept separate from `served` so that stop() never
    // reads it and unlinks a socket it does not actually hold.
    if (this.stopping || (!this.served && !this.healPending)) return;
    if (fs.existsSync(this.p.sock)) return;
    this.healPending = true;
    try {
      this.server?.close();
    } catch {
      /* it is already unreachable */
    }
    this.server = undefined;
    this.served = false;
    try {
      if (await this.listen()) this.writeDaemonInfo();
    } catch (e: unknown) {
      this.debug('socket heal', e);
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
    // Only the daemon that is actually serving may remove these. A daemon that stood
    // down, or one whose rebind failed, is not the owner of either file: unlinking blind
    // lets it take a live daemon's socket and its info file away on the way out.
    if (this.served) {
      try {
        unlinkSocketPath(this.p.sock);
      } catch {
        /* a foreign file at that path is not ours to remove */
      }
      try {
        fs.unlinkSync(this.p.daemonInfo);
      } catch {
        /* ignore */
      }
    }
    this.lock?.release();
    if (exit) process.exit(code);
  }
}

export async function runDaemon(): Promise<void> {
  // Only in the real process, never in the Daemon class: the class runs in-process under
  // the test suite, where swallowing a throw would hide the failure it exists to catch.
  // Here the alternative is worse than staying up. On Node 15 and later an unhandled
  // rejection is fatal by default, so one throw inside a side effect takes the daemon
  // down, every session loses its board at once, and nothing says why.
  const survive = (kind: string, err: unknown): void => {
    try {
      process.stderr.write(`cctap daemon: ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    } catch {
      /* stderr may be closed */
    }
  };
  process.on('uncaughtException', (err) => survive('uncaught exception', err));
  process.on('unhandledRejection', (err) => survive('unhandled rejection', err));

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
