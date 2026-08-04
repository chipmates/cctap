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
    // The cut marker is plain ascii on purpose. A truncated tool name becomes the tool
    // shown on the board, and the wire layer has no theme to ask: the ascii theme is
    // picked exactly when the terminal cannot draw anything else.
    out[key] = v.length > FIELD_MAX_CHARS ? `${v.slice(0, FIELD_MAX_CHARS)}...` : v;
  }
  return out;
}

/** How far into an unparseable payload we look for the short identifying fields. */
const SALVAGE_SCAN_CHARS = 64 * 1024;

/**
 * I13 on the salvage path. The scan matches a key anywhere in the prefix, so it cannot
 * tell a top-level key from the same name nested inside a field the whitelist drops: any
 * key on this list can be filled from a tool argument and put on the wire and into the
 * spool on disk. These two are the ones that stay safe, because Claude Code sends both at
 * the top of every payload, so the leftmost match is the real value and never a nested
 * namesake, and both are identifiers rather than free text. They are also the two the path
 * exists for: an event without them is dropped anyway. Salvaging a truncated giant's agent
 * tags and tool name is not worth the text that could ride out with them.
 */
type HookField = (typeof HOOK_FIELD_WHITELIST)[number];
export const SALVAGE_KEYS = ['session_id', 'hook_event_name'] as const satisfies readonly HookField[];

/**
 * Last resort for a payload that will not parse. Scans a bounded prefix for the
 * salvageable scalars, so a hook whose stdin was truncated still arrives attributable
 * instead of becoming an anonymous line the daemon can only drop.
 */
export function salvageHookFields(raw: string): Record<string, unknown> {
  const head = raw.slice(0, SALVAGE_SCAN_CHARS);
  const out: Record<string, unknown> = {};
  for (const key of SALVAGE_KEYS) {
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

/**
 * Captured env values are the last unbounded part of a frame. Linux allows 128 KiB per
 * variable, so nine of them could push a line past the daemon's 1 MiB cap, where it is
 * destroyed on arrival after the forwarder's flush callback already reported success:
 * silent loss, which is the exact failure the delivery invariant exists to prevent.
 * Bounded here, the arithmetic is decisive: 80 KiB of hook fields plus 36 KiB of env.
 */
export const ENV_MAX_CHARS = 4 * 1024;

export function captureEnv(env: NodeJS.ProcessEnv): CapturedEnv {
  const out: CapturedEnv = {};
  for (const k of CAPTURED_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v.length > ENV_MAX_CHARS ? `${v.slice(0, ENV_MAX_CHARS)}...` : v;
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
  eid?: string,
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
  const msg: WireEvent = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    ts: now,
    tag,
    hook,
    env: captureEnv(env),
    ppid,
  };
  if (eid !== undefined && eid !== '') msg.eid = eid;
  return msg;
}
