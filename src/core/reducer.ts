/**
 * Pure state machine (spec/transitions.md). Invariant I10: no clock reads, no I/O,
 * no randomness. Time enters only through `event.ts` and explicit `sweep(model, nowTs)`.
 *
 * A true no-op returns the identical model reference, which is the daemon's change
 * signal. "True no-op" is narrower than it looks: per transitions.md, an unrecognised
 * event name on a known session still updates `lastEventTs` and clears the liveness
 * flags, because any event proves the session alive. That is a change, and it returns a
 * new reference.
 */

import type {
  AttentionKind,
  DisplayState,
  EventMeta,
  MainState,
  Model,
  NormalizedEvent,
  Session,
  TerminalInfo,
} from './types.js';

export const ENDED_TTL_MS = 5 * 60 * 1000;
export const LIVENESS_GRACE_MS = 60 * 1000;

/** Events the reducer understands. Anything else is a no-op (R7). */
const KNOWN_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'CwdChanged',
  'SessionEnd',
]);

/**
 * R8: the display answers "does this need me right now?". A blocked subagent outranks
 * everything a human can act on, and a main turn that stopped while its subagents are
 * still running is not the human's turn yet, so it keeps the spinner.
 */
export function displayStateOf(s: Pick<Session, 'state' | 'subagents'>): DisplayState {
  if (s.state === 'ended') return 'ended';
  if (s.state === 'permission_wait' || s.subagents.blocked.length > 0) return 'permission_wait';
  if (s.state === 'failed') return 'failed';
  if (s.state === 'your_turn') return s.subagents.active > 0 ? 'working' : 'your_turn';
  if (s.state === 'compacting') return 'compacting';
  return 'working';
}

/**
 * The jump handle. Lowest free positive integer, so the numbers a user has learned stay
 * small and dense; a slot only comes free when its session record drops.
 */
export function lowestFreeSlot(model: Model): number {
  const taken = new Set<number>();
  for (const s of Object.values(model.sessions)) if (s.slot > 0) taken.add(s.slot);
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

function newSession(sessionId: string, ts: number, inferred: boolean, slot: number): Session {
  const s: Session = {
    sessionId,
    slot,
    project: '',
    branch: '',
    cwd: '',
    transcriptPath: '',
    sessionSource: '',
    state: 'working',
    displayState: 'working',
    stateSince: ts,
    lastEventTs: ts,
    sessionStart: ts,
    subagents: { active: 0, running: [], anonymous: 0, blocked: [] },
    terminal: { kind: 'unknown' },
    ppid: 0,
  };
  if (inferred) s.inferred = true;
  return s;
}

function clone(s: Session): Session {
  return {
    ...s,
    subagents: {
      active: s.subagents.active,
      running: s.subagents.running.slice(),
      anonymous: s.subagents.anonymous,
      blocked: s.subagents.blocked.slice(),
    },
    terminal: { ...s.terminal },
  };
}

function withSession(model: Model, s: Session): Model {
  return { sessions: { ...model.sessions, [s.sessionId]: s } };
}

function applyMeta(s: Session, meta: EventMeta | undefined): void {
  if (!meta) return;
  if (typeof meta.ppid === 'number' && meta.ppid > 0) s.ppid = meta.ppid;
  if (meta.transcriptPath) s.transcriptPath = meta.transcriptPath;
  if (meta.terminal) {
    // An event without terminal env must not erase what an earlier one proved,
    // and the daemon-resolved tty outlives every env capture.
    const tty = s.terminal.tty;
    if (meta.terminal.kind !== 'unknown' || s.terminal.kind === 'unknown') {
      s.terminal = { ...meta.terminal };
    }
    if (tty && !s.terminal.tty) s.terminal.tty = tty;
  }
}

/** Blocked subagent ids are a set; order is insertion order for stable rendering. */
function block(s: Session, agentId: string): void {
  if (!s.subagents.blocked.includes(agentId)) s.subagents.blocked.push(agentId);
}

function unblock(s: Session, agentId: string): void {
  const i = s.subagents.blocked.indexOf(agentId);
  if (i >= 0) s.subagents.blocked.splice(i, 1);
}

/** `active` is derived, never incremented: that is what made repeats corrupt it. */
function recount(s: Session): void {
  s.subagents.active = s.subagents.running.length + s.subagents.anonymous;
}

/** R1: a set, so a repeated start is a no-op. */
function startAgent(s: Session, agentId: string): void {
  if (!s.subagents.running.includes(agentId)) s.subagents.running.push(agentId);
  recount(s);
}

/** R1: a stop for an id that is not running is a no-op, not a decrement. */
function stopAgent(s: Session, agentId: string): void {
  const i = s.subagents.running.indexOf(agentId);
  if (i >= 0) s.subagents.running.splice(i, 1);
  recount(s);
}

function setMain(s: Session, main: MainState): void {
  s.state = main;
}

function attention(s: Session, main: MainState, kind: AttentionKind, message?: string): void {
  setMain(s, main);
  s.attentionKind = kind;
  if (message !== undefined) s.lastMessage = message;
}

/**
 * R5: turn boundary shared by Stop and StopFailure. Subagent bookkeeping survives it:
 * the tree can outlive the main turn, and R8 derives the display from both counts.
 */
function endTurn(s: Session, main: MainState): void {
  setMain(s, main);
  delete s.currentTool;
}

/**
 * R1: events carrying `agentId` never change `main`. They may only add/remove that
 * agentId in `blocked` and in `running`.
 */
function reduceSubagentEvent(s: Session, ev: NormalizedEvent, agentId: string): void {
  // R9, same as the main path: an ended session stops accruing bookkeeping. A late
  // subagent event cannot change what it displays, so recording it only builds a tree
  // for a session that is over.
  if (s.state === 'ended') return;

  switch (ev.event) {
    case 'SubagentStart':
      startAgent(s, agentId);
      break;
    case 'SubagentStop':
      stopAgent(s, agentId);
      unblock(s, agentId);
      break;
    case 'PreToolUse':
    case 'PermissionDenied':
      unblock(s, agentId);
      break;
    case 'Notification':
      if (
        ev.notif === 'permission_prompt' ||
        ev.notif === 'agent_needs_input' ||
        ev.notif === 'elicitation_dialog'
      ) {
        block(s, agentId);
      } else if (ev.notif === 'elicitation_response' || ev.notif === 'elicitation_complete') {
        unblock(s, agentId);
      }
      break;
    default:
      break;
  }
}

function reduceMainEvent(s: Session, ev: NormalizedEvent): void {
  // R9: an ended session is over. Only a SessionStart brings it back, so a late Stop
  // cannot raise a your_turn ghost that carries endedReason and outlives the TTL sweep.
  if (s.state === 'ended' && ev.event !== 'SessionStart') return;

  switch (ev.event) {
    case 'SessionStart':
      if (s.state === 'ended') delete s.endedReason;
      setMain(s, 'working');
      // A start is a clean slate: nothing observed before it describes the session now.
      // Carrying a subagent tree across meant a blocked id from the previous life
      // displayed as a permission prompt nobody could answer, and a leftover running id
      // held the spinner so no later Stop could ever read as your_turn. Compaction is
      // safe here too: it sits between turns, so the tree is at rest.
      s.subagents = { active: 0, running: [], anonymous: 0, blocked: [] };
      delete s.attentionKind;
      delete s.lastMessage;
      delete s.currentTool;
      if (ev.source !== undefined) s.sessionSource = ev.source;
      if (ev.cwd !== undefined) s.cwd = ev.cwd;
      // A real start is direct observation, not inference (R6).
      delete s.inferred;
      break;

    case 'UserPromptSubmit':
      // R3. The message belongs to the turn that is over: keeping it lets an old
      // permission prompt come back later as a failure reason.
      setMain(s, 'working');
      s.subagents.blocked = [];
      delete s.attentionKind;
      delete s.lastMessage;
      break;

    case 'PreToolUse':
      // R4
      setMain(s, 'working');
      if (ev.toolName !== undefined) s.currentTool = ev.toolName;
      break;

    case 'PermissionDenied':
      if (s.state === 'permission_wait') setMain(s, 'working');
      break;

    case 'Notification':
      reduceNotification(s, ev);
      break;

    case 'Stop':
      endTurn(s, 'your_turn');
      break;

    case 'StopFailure':
      endTurn(s, 'failed');
      // No fallback: a failure with no information says nothing rather than borrowing
      // the last thing that happened to be in the field.
      if (ev.message !== undefined || ev.reason !== undefined) s.lastMessage = ev.message ?? ev.reason;
      else delete s.lastMessage;
      break;

    case 'SubagentStart':
      // No agentId to track, so this one really is only a count.
      s.subagents.anonymous += 1;
      recount(s);
      break;

    case 'SubagentStop':
      s.subagents.anonymous = Math.max(0, s.subagents.anonymous - 1);
      recount(s);
      break;

    case 'PreCompact':
      setMain(s, 'compacting');
      break;

    case 'PostCompact':
      if (s.state === 'compacting') setMain(s, 'working');
      break;

    case 'CwdChanged':
      if (ev.cwd !== undefined) s.cwd = ev.cwd;
      break;

    case 'SessionEnd':
      setMain(s, 'ended');
      if (ev.reason !== undefined) s.endedReason = ev.reason;
      break;

    default:
      break;
  }
}

function reduceNotification(s: Session, ev: NormalizedEvent): void {
  switch (ev.notif) {
    case 'permission_prompt':
      attention(s, 'permission_wait', 'permission', ev.message);
      break;
    case 'agent_needs_input':
      attention(s, 'permission_wait', 'agent_needs_input', ev.message);
      break;
    case 'elicitation_dialog':
      attention(s, 'permission_wait', 'elicitation', ev.message);
      break;
    case 'elicitation_response':
    case 'elicitation_complete':
      if (s.state === 'permission_wait' && s.attentionKind === 'elicitation') {
        setMain(s, 'working');
      }
      break;
    case 'idle_prompt':
      // R2: upgrade only
      if (s.state === 'working') attention(s, 'your_turn', 'idle', ev.message);
      break;
    case 'agent_completed':
      if (s.state === 'working') attention(s, 'your_turn', 'agent_completed', ev.message);
      break;
    default:
      // R7: unknown notif values (including auth_success) are no-ops.
      break;
  }
}

export function reduce(model: Model, ev: NormalizedEvent): Model {
  if (!ev || typeof ev.sessionId !== 'string' || ev.sessionId === '') return model;

  // Own properties only: a session id of `__proto__` or `toString` would otherwise read
  // back an inherited object, which `clone` then chokes on, and the session becomes
  // permanently invisible to cctap instead of merely oddly named.
  const existing = Object.hasOwn(model.sessions, ev.sessionId) ? model.sessions[ev.sessionId] : undefined;
  const known = KNOWN_EVENTS.has(ev.event);

  // R6 creates sessions for known events only; an unknown event name stays a
  // no-op (R7) rather than conjuring a session out of a name we cannot interpret.
  if (!existing && !known) return model;

  const s = existing ? clone(existing) : newSession(ev.sessionId, ev.ts, true, lowestFreeSlot(model));
  s.lastEventTs = ev.ts;
  applyMeta(s, ev.meta);

  // A fresh event proves the session is alive again.
  delete s.deadSince;
  delete s.staleCandidate;

  if (known) {
    const agentId = ev.agentId;
    if (agentId) reduceSubagentEvent(s, ev, agentId);
    else reduceMainEvent(s, ev);
    // What the stall ceiling measures from: the last sign the tree is really moving.
    if (agentId || ev.event === 'SubagentStart' || ev.event === 'SubagentStop') {
      s.lastAgentEventTs = ev.ts;
    }
  }

  const display = displayStateOf(s);
  if (display !== (existing ? existing.displayState : s.displayState)) {
    s.stateSince = ev.ts;
  }
  s.displayState = display;

  return withSession(model, s);
}

/**
 * A subagent tree can skew: an id-tagged start with an anonymous stop, or the reverse,
 * leaves `active` above zero with nothing left to bring it down. R8 then holds the
 * spinner forever, so the session never reads as `your_turn` and never becomes a jump
 * target. Nothing in the event stream reconciles that, so a ceiling does.
 *
 * The asymmetry decides the tuning: clearing a tree that was merely slow shows `your_turn`
 * for a moment until the next event corrects it, while not clearing hides `your_turn` for
 * the rest of the session. Long enough that real work never trips it, finite either way.
 */
export const SUBAGENT_STALL_MS = 30 * 60 * 1000;

/**
 * `blocked` is deliberately left alone: it renders as `permission_wait`, which is visible
 * and actionable, so a human can resolve it. `running` and `anonymous` render as a
 * spinner, which says "wait" about something that will never finish.
 */
function stalled(s: Session, nowTs: number, stallMs: number): boolean {
  if (s.state !== 'your_turn' || s.subagents.active <= 0) return false;
  return nowTs - (s.lastAgentEventTs ?? s.stateSince) > stallMs;
}

/** Removes ended sessions past their TTL and processes-gone sessions past the grace. */
export function sweep(
  model: Model,
  nowTs: number,
  opts: { endedTtlMs?: number; livenessGraceMs?: number; subagentStallMs?: number } = {},
): Model {
  const endedTtl = opts.endedTtlMs ?? ENDED_TTL_MS;
  const grace = opts.livenessGraceMs ?? LIVENESS_GRACE_MS;
  const stallMs = opts.subagentStallMs ?? SUBAGENT_STALL_MS;
  let next: Record<string, Session> | null = null;

  for (const [id, s] of Object.entries(model.sessions)) {
    const endedOut = s.displayState === 'ended' && nowTs - s.stateSince >= endedTtl;
    const deadOut = s.deadSince !== undefined && nowTs - s.deadSince >= grace;
    if (endedOut || deadOut) {
      if (!next) next = { ...model.sessions };
      delete next[id];
      continue;
    }
    if (stalled(s, nowTs, stallMs)) {
      if (!next) next = { ...model.sessions };
      const cleared = clone(s);
      cleared.subagents.running = [];
      cleared.subagents.anonymous = 0;
      recount(cleared);
      cleared.subagentsClearedAt = nowTs;
      const display = displayStateOf(cleared);
      if (display !== cleared.displayState) cleared.stateSince = nowTs;
      cleared.displayState = display;
      next[id] = cleared;
    }
  }
  return next ? { sessions: next } : model;
}

/** Daemon-side liveness: the parent pid is gone, start the grace clock. */
export function markDead(model: Model, sessionId: string, nowTs: number): Model {
  const s = model.sessions[sessionId];
  if (!s || s.deadSince !== undefined) return model;
  const next = clone(s);
  next.deadSince = nowTs;
  return withSession(model, next);
}

/** Daemon-side liveness: the parent pid answered, cancel any grace clock. */
export function markAlive(model: Model, sessionId: string): Model {
  const s = model.sessions[sessionId];
  if (!s || (s.deadSince === undefined && !s.staleCandidate)) return model;
  const next = clone(s);
  delete next.deadSince;
  delete next.staleCandidate;
  return withSession(model, next);
}

/** After a snapshot restore, every loaded session is unproven until an event or a live ppid. */
/**
 * Everything restored is unproven until an event or a live ppid says otherwise.
 * `forgetPpid` additionally drops the recorded parent, for a snapshot old enough that
 * the pid may since have been handed to an unrelated process.
 */
export function markStaleCandidates(model: Model, forgetPpid = false): Model {
  const ids = Object.keys(model.sessions);
  if (ids.length === 0) return model;
  const sessions: Record<string, Session> = {};
  for (const id of ids) {
    const s = clone(model.sessions[id]!);
    s.staleCandidate = true;
    if (forgetPpid) s.ppid = 0;
    sessions[id] = s;
  }
  return { sessions };
}

export function removeSession(model: Model, sessionId: string): Model {
  if (!model.sessions[sessionId]) return model;
  const sessions = { ...model.sessions };
  delete sessions[sessionId];
  return { sessions };
}

/** Daemon side effect results (branch, project, tty) folded back in purely. */
export function setResolved(
  model: Model,
  sessionId: string,
  patch: { project?: string; branch?: string; terminal?: Partial<TerminalInfo> },
): Model {
  const s = model.sessions[sessionId];
  if (!s) return model;
  const nextProject = patch.project ?? s.project;
  const nextBranch = patch.branch ?? s.branch;
  const current = s.terminal as unknown as Record<string, unknown>;
  const termChanged =
    patch.terminal !== undefined && Object.entries(patch.terminal).some(([k, v]) => current[k] !== v);
  if (nextProject === s.project && nextBranch === s.branch && !termChanged) return model;
  const next = clone(s);
  next.project = nextProject;
  next.branch = nextBranch;
  if (patch.terminal) next.terminal = { ...next.terminal, ...patch.terminal };
  return withSession(model, next);
}
