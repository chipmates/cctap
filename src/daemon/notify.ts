/**
 * Desktop notifications. Transition detection, debounce and command
 * construction are pure; dispatch goes through the single exec seam so tests never
 * fire a real notification.
 */

import type { Command, Exec } from '../exec.js';
import type { DisplayState, WireSession } from '../core/types.js';
import { appleScriptString } from '../terminal/commands.js';

export const NOTIFY_STATES = ['permission_wait', 'failed', 'your_turn'] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

export const DEBOUNCE_MS = 5000;
export const TITLE = 'cctap';

/**
 * A tool name or a failure message is free text off a hook, and it ends up in an
 * osascript, notify-send or tmux argument. Banners truncate anyway, so the only thing
 * an unbounded body buys is a multi-kilobyte argv.
 */
export const DETAIL_MAX = 120;

export type NotifyToggles = Record<NotifyState, boolean>;

export const DEFAULT_TOGGLES: NotifyToggles = {
  permission_wait: true,
  failed: true,
  your_turn: true,
};

/**
 * Master switch. `CCTAP_NOTIFY=off` silences every desktop banner, bell and tmux
 * message, which every test and dev run sets.
 */
export function bellAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CCTAP_BELL === '1';
}

export function notifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CCTAP_NOTIFY ?? '').toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * Desktop banners are opt in. Out of the box cctap speaks through terminal surfaces
 * only, so an install cannot surprise anyone with a popup. The env force-off still wins.
 */
export function bannersOn(cfg: { enabled?: boolean } | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return notifyEnabled(env) && cfg?.enabled === true;
}

export function togglesFrom(cfg: Partial<Record<string, boolean>> | undefined): NotifyToggles {
  const out = { ...DEFAULT_TOGGLES };
  if (!cfg) return out;
  for (const s of NOTIFY_STATES) if (typeof cfg[s] === 'boolean') out[s] = cfg[s] as boolean;
  return out;
}

export function isNotifyState(state: DisplayState): state is NotifyState {
  return (NOTIFY_STATES as readonly string[]).includes(state);
}

/** Codepoints, not code units, so a cut can never split a surrogate pair. */
function clamp(s: string): string {
  const chars = [...s];
  return chars.length <= DETAIL_MAX ? s : `${chars.slice(0, DETAIL_MAX - 1).join('')}…`;
}

/** The tap voice. Parenthetical detail only when we have one. */
export function notifyText(label: string, session: WireSession): string {
  switch (session.displayState) {
    case 'permission_wait': {
      const tool = session.currentTool ? ` (${clamp(session.currentTool)})` : '';
      return `tap tap: ${label} needs permission${tool}`;
    }
    case 'failed': {
      const why = session.lastMessage ? ` (${clamp(session.lastMessage)})` : '';
      return `tap tap: ${label} failed${why}`;
    }
    case 'your_turn':
      return `tap tap: ${label} is your turn`;
    default:
      return `tap tap: ${label}`;
  }
}

/** undefined means this platform has no notifier, so the caller rings the bell. */
export function desktopCommand(platform: string, body: string, title = TITLE): Command | undefined {
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`],
    };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: ['--app-name=cctap', title, body] };
  }
  return undefined;
}

/**
 * Deliberately untargeted: tmux shows this on the attached client, which is where
 * the eyes are. Targeting the session's own pane would put the message on a screen
 * nobody is looking at, which is the opposite of the point (ruling 2026-08-02).
 */
export function tmuxCommand(body: string): Command {
  // tmux expands #{...} and #(...) in display-message text. '##' is its literal escape,
  // so a branch called `feat#3` prints as written instead of running a format.
  return { cmd: 'tmux', args: ['display-message', body.replace(/#/g, '##')] };
}

/** Whatever the injected scheduler hands back, so a test can use a plain counter. */
export type TimerHandle = unknown;

export interface NotifierOptions {
  exec: Exec;
  platform?: string;
  toggles?: NotifyToggles;
  now?: () => number;
  /** Called when the platform has no desktop notifier: attached renderers ring. */
  onBell?: (sessionId: string) => void;
  /** CCTAP_BELL=1: ring alongside the banner, for anyone who misses silent popups. */
  alwaysBell?: boolean;
  /** Desktop banners. False leaves the tmux message and the jump, which are terminal. */
  desktop?: boolean;
  /** Injected beside `now` so a test drives the deferred banner without a real clock. */
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

/** Unref'd: a banner waiting out a debounce window is no reason to hold the daemon up. */
function defaultSchedule(fn: () => void, ms: number): TimerHandle {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

function defaultCancel(handle: TimerHandle): void {
  clearTimeout(handle as NodeJS.Timeout);
}

/** A transition that arrived inside the debounce window, waiting out the rest of it. */
interface Pending {
  state: NotifyState;
  label: string;
  text: string;
  tmux: boolean;
  handle: TimerHandle;
}

export interface Dispatch {
  sessionId: string;
  state: NotifyState;
  text: string;
  commands: Command[];
  bell: boolean;
}

export class Notifier {
  private readonly prev = new Map<string, DisplayState>();
  private readonly lastAt = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly exec: Exec;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly onBell: (sessionId: string) => void;
  private readonly alwaysBell: boolean;
  private readonly desktop: boolean;
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  toggles: NotifyToggles;

  constructor(opts: NotifierOptions) {
    this.exec = opts.exec;
    this.platform = opts.platform ?? process.platform;
    this.toggles = opts.toggles ?? { ...DEFAULT_TOGGLES };
    this.now = opts.now ?? Date.now;
    this.onBell = opts.onBell ?? ((): void => {});
    this.alwaysBell = opts.alwaysBell ?? false;
    this.desktop = opts.desktop ?? true;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.cancel = opts.cancel ?? defaultCancel;
  }

  /** Adopt current states without notifying, so a daemon restart stays quiet. */
  seed(sessions: readonly WireSession[]): void {
    for (const s of sessions) this.prev.set(s.sessionId, s.displayState);
  }

  /** Call after every state change. Returns what was dispatched, for tests and logs. */
  onState(sessions: readonly WireSession[], labels: Map<string, string>): Dispatch[] {
    const out: Dispatch[] = [];
    const seen = new Set<string>();

    for (const s of sessions) {
      seen.add(s.sessionId);
      const before = this.prev.get(s.sessionId);
      this.prev.set(s.sessionId, s.displayState);
      if (before === s.displayState) continue;
      if (!isNotifyState(s.displayState)) continue;
      if (!this.toggles[s.displayState]) continue;

      const label = labels.get(s.sessionId) ?? s.sessionId;
      const text = notifyText(label, s);
      const tmux = s.terminal.kind === 'tmux';
      const now = this.now();
      const last = this.lastAt.get(s.sessionId);
      if (last !== undefined && now - last < DEBOUNCE_MS) {
        this.defer(s.sessionId, { state: s.displayState, label, text, tmux }, last + DEBOUNCE_MS - now);
        continue;
      }
      this.clearPending(s.sessionId);
      this.lastAt.set(s.sessionId, now);
      out.push(this.dispatch(s.sessionId, s.displayState, text, tmux));
    }

    for (const id of [...this.prev.keys()]) {
      if (!seen.has(id)) {
        this.prev.delete(id);
        this.lastAt.delete(id);
        this.clearPending(id);
      }
    }
    return out;
  }

  /**
   * Holding the newest transition until the window closes, rather than dropping it.
   * permission_wait to your_turn inside five seconds is the ordinary shape of a
   * question answered fast, and dropping it left the session that now wants you
   * showing nothing at all.
   */
  private defer(sessionId: string, next: Omit<Pending, 'handle'>, wait: number): void {
    this.clearPending(sessionId);
    const handle = this.schedule(() => {
      const held = this.pending.get(sessionId);
      this.pending.delete(sessionId);
      // Moved on again while it waited, so the banner would name a state that is over.
      if (!held || this.prev.get(sessionId) !== held.state) return;
      this.lastAt.set(sessionId, this.now());
      this.dispatch(sessionId, held.state, held.text, held.tmux);
    }, Math.max(wait, 0));
    this.pending.set(sessionId, { ...next, handle });
  }

  private clearPending(sessionId: string): void {
    const held = this.pending.get(sessionId);
    if (!held) return;
    this.pending.delete(sessionId);
    this.cancel(held.handle);
  }

  private dispatch(sessionId: string, state: NotifyState, text: string, tmux: boolean): Dispatch {
    const commands: Command[] = [];
    const desktop = this.desktop ? desktopCommand(this.platform, text) : undefined;
    if (desktop) commands.push(desktop);
    if (tmux) commands.push(tmuxCommand(text));

    // A banner that fails silently is worse than no banner: fall back to the bell.
    // With banners off there is nothing to fall back from, so nothing rings either.
    const bell = this.alwaysBell || (this.desktop && desktop === undefined);
    if (desktop) {
      void this.exec(desktop).then((res) => {
        if (res.code !== 0) this.onBell(sessionId);
      });
    }
    for (const c of commands) if (c !== desktop) void this.exec(c);
    if (bell) this.onBell(sessionId);

    return { sessionId, state, text, commands, bell };
  }
}
