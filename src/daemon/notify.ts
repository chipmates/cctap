/**
 * Desktop notifications. Transition detection, debounce and command
 * construction are pure; dispatch goes through the single exec seam so tests never
 * fire a real notification.
 */

import type { Command, Exec } from '../exec.js';
import type { DisplayState, WireSession } from '../core/types.js';

export const NOTIFY_STATES = ['permission_wait', 'failed', 'your_turn'] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

export const DEBOUNCE_MS = 5000;
export const TITLE = 'cctap';

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

/** The tap voice. Parenthetical detail only when we have one. */
export function notifyText(label: string, session: WireSession): string {
  switch (session.displayState) {
    case 'permission_wait': {
      const tool = session.currentTool ? ` (${session.currentTool})` : '';
      return `tap tap: ${label} needs permission${tool}`;
    }
    case 'failed': {
      const why = session.lastMessage ? ` (${session.lastMessage})` : '';
      return `tap tap: ${label} failed${why}`;
    }
    case 'your_turn':
      return `tap tap: ${label} is your turn`;
    default:
      return `tap tap: ${label}`;
  }
}

/** AppleScript string literal escaping. Branch names can contain anything. */
export function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  private readonly exec: Exec;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly onBell: (sessionId: string) => void;
  private readonly alwaysBell: boolean;
  private readonly desktop: boolean;
  toggles: NotifyToggles;

  constructor(opts: NotifierOptions) {
    this.exec = opts.exec;
    this.platform = opts.platform ?? process.platform;
    this.toggles = opts.toggles ?? { ...DEFAULT_TOGGLES };
    this.now = opts.now ?? Date.now;
    this.onBell = opts.onBell ?? ((): void => {});
    this.alwaysBell = opts.alwaysBell ?? false;
    this.desktop = opts.desktop ?? true;
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

      const now = this.now();
      const last = this.lastAt.get(s.sessionId);
      if (last !== undefined && now - last < DEBOUNCE_MS) continue;
      this.lastAt.set(s.sessionId, now);

      const label = labels.get(s.sessionId) ?? s.sessionId;
      const text = notifyText(label, s);
      const commands: Command[] = [];
      const desktop = this.desktop ? desktopCommand(this.platform, text) : undefined;
      if (desktop) commands.push(desktop);
      if (s.terminal.kind === 'tmux') commands.push(tmuxCommand(text));

      // A banner that fails silently is worse than no banner: fall back to the bell.
      // With banners off there is nothing to fall back from, so nothing rings either.
      const bell = this.alwaysBell || (this.desktop && desktop === undefined);
      if (desktop) {
        void this.exec(desktop).then((res) => {
          if (res.code !== 0) this.onBell(s.sessionId);
        });
      }
      for (const c of commands) if (c !== desktop) void this.exec(c);
      if (bell) this.onBell(s.sessionId);

      out.push({ sessionId: s.sessionId, state: s.displayState, text, commands, bell });
    }

    for (const id of [...this.prev.keys()]) {
      if (!seen.has(id)) {
        this.prev.delete(id);
        this.lastAt.delete(id);
      }
    }
    return out;
  }
}
