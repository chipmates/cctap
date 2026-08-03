/** Shared state vocabulary. Wire shapes are normative in spec/CONTRACTS.md section 2. */

export const PROTOCOL_VERSION = 1;

export type MainState =
  | 'working'
  | 'permission_wait'
  | 'your_turn'
  | 'failed'
  | 'compacting'
  | 'ended';

export type DisplayState = MainState;

export type AttentionKind =
  | 'permission'
  | 'elicitation'
  | 'agent_needs_input'
  | 'idle'
  | 'agent_completed';

export type TerminalKind =
  | 'tmux'
  | 'apple-terminal'
  | 'iterm2'
  | 'kitty'
  | 'wezterm'
  | 'unknown';

export interface TerminalInfo {
  kind: TerminalKind;
  tmuxPane?: string;
  tty?: string;
  kittyWindowId?: string;
  /** kitty's remote-control socket. `kitten @` cannot find it from outside kitty. */
  kittyListenOn?: string;
  weztermPane?: string;
  termSessionId?: string;
}

export interface SubagentInfo {
  /** running.length + anonymous. What the `xn` suffix shows. */
  active: number;
  /** Subagents currently running, by id. A set: repeats and unknown ids are no-ops. */
  running: string[];
  /** Starts that carried no agentId, so there is nothing to identify. Floor 0. */
  anonymous: number;
  blocked: string[];
}

/** One element of the `sessions` array on the wire (CONTRACTS section 2). */
export interface WireSession {
  sessionId: string;
  /** Stable jump handle: lowest free positive integer at first sight, held for life. */
  slot: number;
  project: string;
  branch: string;
  cwd: string;
  transcriptPath: string;
  sessionSource: string;
  state: MainState;
  displayState: DisplayState;
  stateSince: number;
  lastEventTs: number;
  sessionStart: number;
  currentTool?: string;
  lastMessage?: string;
  attentionKind?: AttentionKind;
  subagents: SubagentInfo;
  terminal: TerminalInfo;
  ppid: number;
  inferred?: boolean;
  endedReason?: string;
}

/**
 * Internal session record: the wire shape plus bookkeeping the daemon needs.
 * `deadSince` / `staleCandidate` are stripped before anything is published.
 */
export interface Session extends WireSession {
  deadSince?: number;
  staleCandidate?: boolean;
}

export interface Model {
  sessions: Record<string, Session>;
}

/**
 * Daemon-supplied metadata attached to a normalized event. Fixtures omit it,
 * which keeps the reducer pure and the fixture format exactly CONTRACTS section 3.
 */
export interface EventMeta {
  ppid?: number;
  transcriptPath?: string;
  projectDir?: string;
  terminal?: TerminalInfo;
}

/** CONTRACTS section 3. Fixture events are exactly this shape (minus `meta`). */
export interface NormalizedEvent {
  ts: number;
  sessionId: string;
  event: string;
  notif?: string;
  agentId?: string;
  toolName?: string;
  source?: string;
  cwd?: string;
  message?: string;
  reason?: string;
  meta?: EventMeta;
}

export const EMPTY_MODEL: Model = Object.freeze({ sessions: Object.freeze({}) as Record<string, Session> });

export function emptyModel(): Model {
  return { sessions: {} };
}
