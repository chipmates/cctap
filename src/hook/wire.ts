/** Pure helpers shared by the forwarder and its tests (no side effects on import). */

import {
  CAPTURED_ENV_KEYS,
  PROTOCOL_VERSION,
  type CapturedEnv,
  type EventTag,
  type WireEvent,
} from '../proto.js';

/**
 * I13: the only hook fields that ever leave the forwarder. Everything else, above
 * all `prompt`, `tool_input` and `tool_response`, is dropped before the line is
 * written, so neither the socket nor the spool on disk can carry your text.
 */
export const HOOK_FIELD_WHITELIST = [
  'session_id',
  'hook_event_name',
  'agent_id',
  'agent_type',
  'tool_name',
  'source',
  'cwd',
  'message',
  'reason',
  'transcript_path',
] as const;

/**
 * Every whitelisted field is bounded, so no legal event can outgrow the daemon's line
 * cap. `message` and `reason` are free text straight from a hook payload: unbounded,
 * they produced a line the daemon dropped on overflow while the forwarder reported
 * success, which loses a permission prompt in silence.
 */
export const FIELD_MAX_CHARS = 8 * 1024;

/** Copies the whitelist and nothing else. Non-string values are dropped, not coerced. */
export function pickHookFields(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of HOOK_FIELD_WHITELIST) {
    const v = payload[key];
    if (typeof v !== 'string' || v === '') continue;
    out[key] = v.length > FIELD_MAX_CHARS ? `${v.slice(0, FIELD_MAX_CHARS)}…` : v;
  }
  return out;
}

/** How far into an unparseable payload we look for the short identifying fields. */
const SALVAGE_SCAN_CHARS = 64 * 1024;

/**
 * Last resort for a payload that will not parse. Scans a bounded prefix for the
 * whitelisted scalars, so a hook whose stdin was truncated still arrives attributable
 * instead of becoming an anonymous line the daemon can only drop.
 */
export function salvageHookFields(raw: string): Record<string, unknown> {
  const head = raw.slice(0, SALVAGE_SCAN_CHARS);
  const out: Record<string, unknown> = {};
  for (const key of HOOK_FIELD_WHITELIST) {
    // Bounded and termination-agnostic: a value whose closing quote was cut off still
    // yields its prefix, which is what keeps a truncated payload useful.
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,${FIELD_MAX_CHARS}})`).exec(head);
    let v = m?.[1];
    if (v === undefined || v === '') continue;
    if (/(^|[^\\])(\\\\)*\\$/.test(v)) v = v.slice(0, -1); // an escape cut in half
    try {
      out[key] = JSON.parse(`"${v}"`) as string;
    } catch {
      /* not recoverable as a string: leave the field out */
    }
  }
  return out;
}

export function parseTag(argv: readonly string[]): EventTag {
  let event = '';
  let notif: string | undefined;
  for (const a of argv) {
    if (a.startsWith('--event=')) event = a.slice('--event='.length);
    else if (a.startsWith('--notif=')) notif = a.slice('--notif='.length);
  }
  const tag: EventTag = { event };
  if (notif !== undefined && notif !== '') tag.notif = notif;
  return tag;
}

export function captureEnv(env: NodeJS.ProcessEnv): CapturedEnv {
  const out: CapturedEnv = {};
  for (const k of CAPTURED_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Wraps hook stdin per CONTRACTS section 2, copying only the whitelisted fields (I13).
 * Malformed stdin still produces a valid message: the argv tag carries the event name,
 * which is the attention-relevant part.
 */
export function buildWireEvent(
  raw: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  now: number,
  ppid: number,
): WireEvent {
  const tag = parseTag(argv);
  let hook: Record<string, unknown> = {};
  const trimmed = raw.trim();
  if (trimmed !== '') {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hook = pickHookFields(parsed as Record<string, unknown>);
      }
    } catch {
      // Truncated or malformed: a payload capped mid-JSON still has its identifying
      // fields near the front, and an event nobody can attribute is an event lost.
      hook = salvageHookFields(trimmed);
    }
  }
  if (tag.event === '' && typeof hook.hook_event_name === 'string') tag.event = hook.hook_event_name;
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    ts: now,
    tag,
    hook,
    env: captureEnv(env),
    ppid,
  };
}
