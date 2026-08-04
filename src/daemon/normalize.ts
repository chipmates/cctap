/** Wire event (CONTRACTS section 2) to normalized event (CONTRACTS section 3). */

import { sanitizeText } from '../core/sanitize.js';
import { usablePpid } from '../core/types.js';
import type { NormalizedEvent, TerminalInfo } from '../core/types.js';
import type { CapturedEnv, WireEvent } from '../proto.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * The sanitation boundary (I16). Every field below this line ends up drawn on a terminal,
 * so control bytes are stripped once, here, rather than at each of the surfaces. A field
 * left with nothing but controls carried no information and is treated as absent.
 */
function text(v: unknown): string | undefined {
  const raw = str(v);
  if (raw === undefined) return undefined;
  const clean = sanitizeText(raw);
  return clean === '' ? undefined : clean;
}

/**
 * How far ahead of the daemon's own clock an event stamp is allowed to sit. A clock
 * excursion into the future parks a session past every sweep horizon, so it never ages
 * out and never ends. The past is deliberately never clamped: spool replay carries
 * genuinely old stamps and they are the truth about when the event happened.
 */
export const FUTURE_TS_SLACK_MS = 60_000;

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

  // The session id is a routing key and a label suffix both, so it is sanitized like any
  // other rendered field. The transform is deterministic, so routing stays stable.
  const sessionId = text(hook.session_id);
  if (!sessionId) return undefined;

  const event = text(tag.event) ?? text(hook.hook_event_name);
  if (!event) return undefined;

  const raw = typeof wire.ts === 'number' && Number.isFinite(wire.ts) ? wire.ts : receivedTs;
  const ts = Math.min(raw, receivedTs + FUTURE_TS_SLACK_MS);

  const ev: NormalizedEvent = { ts, sessionId, event };
  const notif = text(tag.notif);
  if (notif) ev.notif = notif;
  const agentId = text(hook.agent_id);
  if (agentId) ev.agentId = agentId;
  const toolName = text(hook.tool_name);
  if (toolName) ev.toolName = toolName;
  const source = text(hook.source);
  if (source) ev.source = source;
  // cwd is a filesystem path handed to `git -C` and compared against peers, never drawn.
  const cwd = str(hook.cwd);
  if (cwd) ev.cwd = cwd;
  const message = text(hook.message);
  if (message) ev.message = message;
  const reason = text(hook.reason);
  if (reason) ev.reason = reason;

  const meta: NonNullable<NormalizedEvent['meta']> = {};
  if (usablePpid(wire.ppid)) meta.ppid = wire.ppid;
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
