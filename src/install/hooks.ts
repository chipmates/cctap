/**
 * The exact hook set cctap registers, and the pure merge and remove logic
 * that install-hooks and uninstall-hooks run against a settings object.
 */

export interface HookEntry {
  type: 'command';
  command: string;
  args: string[];
  async?: boolean;
  timeout?: number;
  [k: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [k: string]: unknown;
}

export type HooksConfig = Record<string, HookGroup[]>;

export interface Settings {
  hooks?: HooksConfig;
  statusLine?: unknown;
  [k: string]: unknown;
}

export interface Registration {
  event: string;
  /** Omitted for events registered without a matcher. */
  matcher?: string;
  /** Appended to args as `--notif=<value>` so classification needs no text parsing. */
  notif?: string;
}

/** The complete registration set. Order here is the order written to settings. */
export const REGISTRATIONS: Registration[] = [
  { event: 'SessionStart', matcher: '*' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PermissionDenied', matcher: '*' },
  { event: 'Notification', matcher: 'permission_prompt', notif: 'permission_prompt' },
  { event: 'Notification', matcher: 'idle_prompt', notif: 'idle_prompt' },
  { event: 'Notification', matcher: 'agent_needs_input', notif: 'agent_needs_input' },
  { event: 'Notification', matcher: 'agent_completed', notif: 'agent_completed' },
  { event: 'Notification', matcher: 'elicitation_dialog', notif: 'elicitation_dialog' },
  { event: 'Notification', matcher: 'elicitation_response', notif: 'elicitation_response' },
  { event: 'Notification', matcher: 'elicitation_complete', notif: 'elicitation_complete' },
  { event: 'Stop' },
  { event: 'StopFailure', matcher: '*' },
  { event: 'SubagentStart', matcher: '*' },
  { event: 'SubagentStop', matcher: '*' },
  { event: 'PreCompact', matcher: '*' },
  { event: 'PostCompact', matcher: '*' },
  { event: 'CwdChanged' },
  { event: 'SessionEnd', matcher: '*' },
];

export const HOOK_TIMEOUT_S = 5;

export function entryFor(reg: Registration, nodePath: string, forwarderPath: string): HookEntry {
  const args = [forwarderPath, `--event=${reg.event}`];
  if (reg.notif) args.push(`--notif=${reg.notif}`);
  return { type: 'command', command: nodePath, args, async: true, timeout: HOOK_TIMEOUT_S };
}

/** The file every cctap hook runs, whatever directory it was installed into. */
export const FORWARDER_NAME = 'hook-forward.mjs';

/**
 * Rule 4: ours is identified by the forwarder SHAPE in args[0], not by the node path and
 * not by one exact directory. A registration that runs a `hook-forward.mjs` is ours even
 * when it points at a tree we no longer use, so a re-install adopts and rewrites it. The
 * exact-path version left orphans behind: 19 dead registrations forking ENOENT node
 * processes on every event, invisible to uninstall and uncounted by doctor.
 */
export function isOurs(entry: unknown, _forwarderPath?: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<HookEntry>;
  if (e.type !== 'command' || !Array.isArray(e.args)) return false;
  const target = e.args[0];
  if (typeof target !== 'string' || target === '') return false;
  return target === _forwarderPath || target.split('/').pop() === FORWARDER_NAME;
}

/** Ours, but pointing somewhere other than this install: what a re-install adopts. */
export function isStrayOurs(entry: unknown, forwarderPath: string): boolean {
  if (!isOurs(entry, forwarderPath)) return false;
  return (entry as HookEntry).args[0] !== forwarderPath;
}

function sameEntry(a: HookEntry, b: HookEntry): boolean {
  return (
    a.command === b.command &&
    a.args.length === b.args.length &&
    a.args.every((v, i) => v === b.args[i]) &&
    a.async === b.async &&
    a.timeout === b.timeout
  );
}

export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}

export interface MergeResult {
  settings: Settings;
  added: string[];
  replaced: string[];
  unchanged: string[];
}

/** Rule 3: deep merge, never remove or reorder anything that is not ours. */
export function mergeHooks(base: Settings, nodePath: string, forwarderPath: string): MergeResult {
  const next = cloneSettings(base ?? {});
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  const added: string[] = [];
  const replaced: string[] = [];
  const unchanged: string[] = [];

  for (const reg of REGISTRATIONS) {
    const desired = entryFor(reg, nodePath, forwarderPath);
    const name = reg.matcher ? `${reg.event}(${reg.matcher})` : reg.event;
    const groups = (next.hooks[reg.event] ??= []);
    if (!Array.isArray(next.hooks[reg.event])) {
      // A foreign non-array value stays untouched; we cannot merge into it.
      continue;
    }
    let group = groups.find((g) => (g?.matcher ?? undefined) === reg.matcher);
    if (!group) {
      group = reg.matcher === undefined ? { hooks: [] } : { matcher: reg.matcher, hooks: [] };
      groups.push(group);
    }
    if (!Array.isArray(group.hooks)) group.hooks = [];

    const mine = group.hooks.filter((h) => isOurs(h, forwarderPath));
    const exact = mine.find((h) => sameEntry(h, desired));
    if (exact && mine.length === 1) {
      unchanged.push(name);
      continue;
    }
    group.hooks = group.hooks.filter((h) => !isOurs(h, forwarderPath));
    group.hooks.push(desired);
    if (mine.length > 0) replaced.push(name);
    else added.push(name);
  }

  return { settings: next, added, replaced, unchanged };
}

export interface RemoveResult {
  settings: Settings;
  removed: string[];
}

/** Rule 4 in reverse: removes precisely and only our entries, then prunes what we emptied. */
export function removeHooks(base: Settings, forwarderPath: string): RemoveResult {
  const next = cloneSettings(base ?? {});
  const removed: string[] = [];
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { settings: next, removed };

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups: HookGroup[] = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isOurs(h, forwarderPath));
      const gone = before - group.hooks.length;
      if (gone > 0) {
        const name = group.matcher ? `${event}(${group.matcher})` : event;
        for (let i = 0; i < gone; i++) removed.push(name);
      }
      // Only drop a group we emptied; a group that arrived empty is not ours to prune.
      if (group.hooks.length === 0 && gone > 0) continue;
      keptGroups.push(group);
    }
    if (keptGroups.length === 0 && groups.length > 0) delete hooks[event];
    else hooks[event] = keptGroups;
  }

  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

export function countOurs(settings: Settings, forwarderPath: string): number {
  let n = 0;
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) if (isOurs(h, forwarderPath)) n += 1;
    }
  }
  return n;
}

/** Hook entries that belong to someone else, so uninstall can say what it kept. */
export function countForeign(settings: Settings, forwarderPath: string): number {
  let n = 0;
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) if (!isOurs(h, forwarderPath)) n += 1;
    }
  }
  return n;
}

/** Our entries as (name, entry) pairs, for doctor. */
export function listOurs(settings: Settings, forwarderPath: string): { name: string; entry: HookEntry }[] {
  const out: { name: string; entry: HookEntry }[] = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (isOurs(h, forwarderPath)) {
          out.push({ name: g.matcher ? `${event}(${g.matcher})` : event, entry: h as HookEntry });
        }
      }
    }
  }
  return out;
}
