/**
 * The Claude Code status line entry install-hooks writes, and the pure add,
 * refresh and remove logic. A status line that is not ours is never rewritten.
 */

import { cloneSettings, type Settings } from './hooks.js';

export interface StatusLineEntry {
  type: 'command';
  command: string;
  refreshInterval?: number;
  [k: string]: unknown;
}

/**
 * Seconds between re-runs, on top of the event-driven updates. Other sessions change
 * state while this one sits idle, and only a poll can show that.
 */
export const REFRESH_INTERVAL_S = 2;

/** The file a cctap status line runs, whatever directory it was installed into. */
const CLI_NAME = 'cctap.mjs';
/** Every subcommand a cctap status line has run. Older ones heal into the current one. */
const SUBCOMMANDS = ['strip', 'status'] as const;

/**
 * Absolute node, like the hook entries: a GUI-spawned shell has no version manager on
 * PATH. Quoted because a status line is one string run through a shell, unlike the
 * exec-form hooks, so a space in HOME or in the node path would split it. The colour
 * env is what keeps the piped one-shot strip looking like the strip in a pane.
 */
export function statusLineFor(nodePath: string, cliBin: string): StatusLineEntry {
  return {
    type: 'command',
    command: `CCTAP_COLOR=1 "${nodePath}" "${cliBin}" strip`,
    refreshInterval: REFRESH_INTERVAL_S,
  };
}

/**
 * Ours by the SHAPE of the command it runs: any `cctap.mjs` running a subcommand we have
 * ever put in a status line, in any directory, quoted or not. The same rule the hooks
 * use, so the two ownership answers cannot disagree and leave half an install behind.
 * A tilde recipe, an older `status` form and a relocated tree all read as ours.
 */
export function isOurStatusLine(value: unknown, cliBin: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = (value as { command?: unknown }).command;
  if (typeof command !== 'string') return false;
  const bare = command.replace(/"/g, '');
  return SUBCOMMANDS.some(
    (sub) => bare.includes(`${cliBin} ${sub}`) || new RegExp(`(^|[/\\s])${CLI_NAME} ${sub}(\\s|$)`).test(bare),
  );
}

export type StatusLineOutcome = 'added' | 'updated' | 'unchanged' | 'foreign';

export interface StatusLineResult {
  settings: Settings;
  outcome: StatusLineOutcome;
  /** The canonical command, for the change list and the chaining hint. */
  command: string;
}

export function mergeStatusLine(base: Settings, nodePath: string, cliBin: string): StatusLineResult {
  const next = cloneSettings(base ?? {});
  const desired = statusLineFor(nodePath, cliBin);
  const current = next.statusLine;

  if (current === undefined || current === null) {
    next.statusLine = desired;
    return { settings: next, outcome: 'added', command: desired.command };
  }
  if (!isOurStatusLine(current, cliBin)) {
    return { settings: next, outcome: 'foreign', command: desired.command };
  }

  const entry = current as Partial<StatusLineEntry>;
  if (entry.type === desired.type && entry.command === desired.command && entry.refreshInterval !== undefined) {
    return { settings: next, outcome: 'unchanged', command: desired.command };
  }
  // A refresh keeps every key the user set, refreshInterval included, and rewrites only
  // the two we own. Our defaults fill in what an older entry never had.
  next.statusLine = {
    ...desired,
    ...(current as Record<string, unknown>),
    type: desired.type,
    command: desired.command,
  };
  return { settings: next, outcome: 'updated', command: desired.command };
}

export type StatusLineRemoval = 'removed' | 'kept' | 'absent';

export interface StatusLineRemoveResult {
  settings: Settings;
  outcome: StatusLineRemoval;
}

export function removeStatusLine(base: Settings, cliBin: string): StatusLineRemoveResult {
  const next = cloneSettings(base ?? {});
  const current = next.statusLine;
  if (current === undefined || current === null) return { settings: next, outcome: 'absent' };
  if (!isOurStatusLine(current, cliBin)) return { settings: next, outcome: 'kept' };
  delete next.statusLine;
  return { settings: next, outcome: 'removed' };
}
