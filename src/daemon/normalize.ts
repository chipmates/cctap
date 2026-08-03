/** Wire event (CONTRACTS section 2) to normalized event (CONTRACTS section 3). */

import type { NormalizedEvent, TerminalInfo } from '../core/types.js';
import type { CapturedEnv, WireEvent } from '../proto.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** tmux wins over the host terminal: the pane is the jump target either way (D5). */
export function detectTerminal(env: CapturedEnv): TerminalInfo {
  const t: TerminalInfo = { kind: 'unknown' };
  if (str(env.TMUX) && str(env.TMUX_PANE)) {
    t.kind = 'tmux';
    t.tmuxPane = env.TMUX_PANE;
    return t;
  }
  if (str(env.KITTY_WINDOW_ID)) {
    t.kind = 'kitty';
    t.kittyWindowId = env.KITTY_WINDOW_ID;
    const listen = str(env.KITTY_LISTEN_ON);
    if (listen) t.kittyListenOn = listen;
    return t;
  }
  if (str(env.WEZTERM_PANE)) {
    t.kind = 'wezterm';
    t.weztermPane = env.WEZTERM_PANE;
    return t;
  }
  if (env.TERM_PROGRAM === 'iTerm.app' || str(env.ITERM_SESSION_ID)) {
    t.kind = 'iterm2';
    if (str(env.TERM_SESSION_ID)) t.termSessionId = env.TERM_SESSION_ID;
    return t;
  }
  if (env.TERM_PROGRAM === 'Apple_Terminal') {
    t.kind = 'apple-terminal';
    if (str(env.TERM_SESSION_ID)) t.termSessionId = env.TERM_SESSION_ID;
    return t;
  }
  return t;
}

export function isWireEvent(msg: Record<string, unknown>): boolean {
  return msg.kind === 'event' && typeof msg.hook === 'object' && msg.hook !== null;
}

/** Returns undefined when the event cannot be routed to a session. */
export function normalize(wire: WireEvent, receivedTs: number): NormalizedEvent | undefined {
  const hook = (wire.hook ?? {}) as Record<string, unknown>;
  const env = (wire.env ?? {}) as CapturedEnv;
  const tag = wire.tag ?? { event: '' };

  const sessionId = str(hook.session_id);
  if (!sessionId) return undefined;

  const event = str(tag.event) ?? str(hook.hook_event_name);
  if (!event) return undefined;

  const ts = typeof wire.ts === 'number' && Number.isFinite(wire.ts) ? wire.ts : receivedTs;

  const ev: NormalizedEvent = { ts, sessionId, event };
  const notif = str(tag.notif);
  if (notif) ev.notif = notif;
  const agentId = str(hook.agent_id);
  if (agentId) ev.agentId = agentId;
  const toolName = str(hook.tool_name);
  if (toolName) ev.toolName = toolName;
  const source = str(hook.source);
  if (source) ev.source = source;
  const cwd = str(hook.cwd);
  if (cwd) ev.cwd = cwd;
  const message = str(hook.message);
  if (message) ev.message = message;
  const reason = str(hook.reason);
  if (reason) ev.reason = reason;

  const meta: NonNullable<NormalizedEvent['meta']> = {};
  if (typeof wire.ppid === 'number' && wire.ppid > 0) meta.ppid = wire.ppid;
  const transcript = str(hook.transcript_path);
  if (transcript) meta.transcriptPath = transcript;
  const projectDir = str(env.CLAUDE_PROJECT_DIR);
  if (projectDir) meta.projectDir = projectDir;
  meta.terminal = detectTerminal(env);
  ev.meta = meta;

  return ev;
}

/** Which capture keys actually arrived non-empty. `doctor` reports this. */
export function observedEnvKeys(env: CapturedEnv): string[] {
  return Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k]) => k);
}
