/** Socket protocol (spec/CONTRACTS.md section 2). ndjson, one JSON object per line. */

import type { WireSession } from './core/types.js';
import { PROTOCOL_VERSION } from './core/types.js';

export { PROTOCOL_VERSION };

/** I11: untrusted input, capped per line. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** The env keys the forwarder captures for terminal adapters and project labels. */
export const CAPTURED_ENV_KEYS = [
  'TMUX',
  'TMUX_PANE',
  'TERM_PROGRAM',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON',
  'WEZTERM_PANE',
  'CLAUDE_PROJECT_DIR',
] as const;

export type CapturedEnv = Partial<Record<(typeof CAPTURED_ENV_KEYS)[number], string>>;

export interface EventTag {
  event: string;
  notif?: string;
}

export interface WireEvent {
  v: number;
  kind: 'event';
  ts: number;
  tag: EventTag;
  hook: Record<string, unknown>;
  env: CapturedEnv;
  ppid: number;
  /**
   * I17: one random id per hook invocation, shared by the delivered and the spooled copy
   * of that event, so the daemon can tell a redelivery from a second event. Optional: an
   * older forwarder, or a spool written by one, simply carries none. Never published.
   */
  eid?: string;
}

export interface SubscribeMsg {
  v: number;
  kind: 'subscribe';
}

export interface GetStateMsg {
  v: number;
  kind: 'get_state';
}

export interface StateMsg {
  v: number;
  kind: 'state';
  sessions: WireSession[];
}

/** Awareness fallback: the jump CLI asks renderers to flag a session (M2, additive). */
export interface HighlightMsg {
  v: number;
  kind: 'highlight';
  sessionId: string;
  ms?: number;
}

/** Sent to renderers when the platform has no desktop notifier. */
export interface BellMsg {
  v: number;
  kind: 'bell';
  sessionId?: string;
}

export const HIGHLIGHT_MS = 5000;

export type ClientMsg = WireEvent | SubscribeMsg | GetStateMsg | HighlightMsg;

export function encodeLine(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Splits a growing buffer into complete lines. Returns the leftover tail.
 * Over-long lines are dropped rather than buffered (I11).
 */
export function splitLines(buf: string, maxBytes = MAX_LINE_BYTES): { lines: string[]; rest: string; overflow: boolean } {
  const lines: string[] = [];
  let rest = buf;
  let overflow = false;
  for (;;) {
    const nl = rest.indexOf('\n');
    if (nl < 0) break;
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (Buffer.byteLength(line) > maxBytes) {
      overflow = true;
      continue;
    }
    if (line.trim() !== '') lines.push(line);
  }
  if (Buffer.byteLength(rest) > maxBytes) {
    // No newline in sight and already over the cap: discard the partial line.
    rest = '';
    overflow = true;
  }
  return { lines, rest, overflow };
}

export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
