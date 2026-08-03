/**
 * Terminal adapters. Command construction lives in ./commands.ts and is
 * pure; every adapter here does nothing but pick a command, run it through the one
 * exec seam, and read the answer.
 */

import { realExec, type Command, type Exec } from '../exec.js';
import type { TerminalKind, WireSession } from '../core/types.js';
import {
  appleTerminalCommand,
  isAppMissing,
  isConsentDenial,
  iterm2Command,
  kittyCommand,
  pickMostRecentClient,
  tmuxFocusCommand,
  tmuxListClientsCommand,
  tmuxSessionNameCommand,
  weztermCommand,
} from './commands.js';

export type Consent = 'granted' | 'denied' | 'unknown';

export interface FocusResult {
  ok: boolean;
  /** What the adapter did or would do, in one line. */
  detail: string;
  reason?: string;
  consent?: Consent;
}

export interface TerminalAdapter {
  kind: TerminalKind | 'fallback';
  label: string;
  /** False where the command matches the docs but has never run against the real app. */
  liveVerified?: boolean;
  /** True when this session carries everything the adapter needs. */
  canTarget(session: WireSession): boolean;
  /** The concrete handle the adapter acts on, for logs and doctor. */
  describeTarget(session: WireSession): string;
  /** Exactly what focus() would run, for `jump --dry-run`. Runs nothing. */
  plan(session: WireSession): Command[];
  focus(session: WireSession): Promise<FocusResult>;
}

export interface AdapterOptions {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
}

const NOT_FOUND = 'the terminal has no tab on that tty any more';

export function createAdapters(opts: AdapterOptions = {}): Record<TerminalKind | 'fallback', TerminalAdapter> {
  const exec = opts.exec ?? realExec;
  const env = opts.env ?? process.env;

  /** Shared by both AppleScript adapters: they differ only in the script. */
  const osaAdapter = (
    kind: 'apple-terminal' | 'iterm2',
    label: string,
    build: (tty: string) => { cmd: string; args: string[] },
    liveVerified: boolean,
  ): TerminalAdapter => ({
    kind,
    label,
    liveVerified,
    canTarget: (s) => Boolean(s.terminal.tty),
    describeTarget: (s) => `tty ${s.terminal.tty ?? '?'}`,
    plan: (s) => (s.terminal.tty ? [build(s.terminal.tty)] : []),
    async focus(s): Promise<FocusResult> {
      const tty = s.terminal.tty;
      if (!tty) return { ok: false, detail: 'no tty resolved for this session' };
      const res = await exec(build(tty));
      if (res.stdout.trim() === 'ok') {
        return { ok: true, detail: `selected the ${label} tab on ${tty}`, consent: 'granted' };
      }
      if (isConsentDenial(res.stderr, res.code)) {
        return {
          ok: false,
          detail: `macOS blocked the Apple event to ${label}`,
          reason: 'grant Automation consent in System Settings > Privacy & Security > Automation, then: cctap doctor',
          consent: 'denied',
        };
      }
      if (isAppMissing(res.stderr, res.code)) {
        return { ok: false, detail: `${label} is not running`, consent: 'unknown' };
      }
      if (res.stdout.trim() === 'notfound') {
        return { ok: false, detail: NOT_FOUND, consent: 'granted' };
      }
      return { ok: false, detail: `${label} did not answer`, reason: res.stderr.trim() || undefined };
    },
  });

  const tmux: TerminalAdapter = {
    kind: 'tmux',
    label: 'tmux',
    liveVerified: true,
    canTarget: (s) => Boolean(s.terminal.tmuxPane),
    describeTarget: (s) => `pane ${s.terminal.tmuxPane ?? '?'}`,
    plan: (s) => {
      const pane = s.terminal.tmuxPane;
      if (!pane) return [];
      if (!env.TMUX) {
        return [
          tmuxListClientsCommand(),
          tmuxSessionNameCommand(pane),
          tmuxFocusCommand(pane, '<session-name>', '<client-tty>'),
        ];
      }
      return [tmuxSessionNameCommand(pane), tmuxFocusCommand(pane, '<session-name>')];
    },
    async focus(s): Promise<FocusResult> {
      const pane = s.terminal.tmuxPane;
      if (!pane) return { ok: false, detail: 'no tmux pane stored for this session' };
      let clientTty: string | undefined;
      if (!env.TMUX) {
        // An OS hotkey fires from outside every client, and tmux can still move an
        // attached one. Attaching is never an option here, it would hijack this
        // terminal (D5).
        const clients = await exec(tmuxListClientsCommand());
        clientTty = clients.code === 0 ? pickMostRecentClient(clients.stdout) : undefined;
        if (!clientTty) {
          return {
            ok: false,
            detail: 'not inside tmux and no tmux client attached',
            reason: `attach first, the session is on pane ${pane}`,
          };
        }
      }
      const name = await exec(tmuxSessionNameCommand(pane));
      const sessionName = name.stdout.trim();
      if (name.code !== 0 || sessionName === '') {
        return { ok: false, detail: NOT_FOUND, reason: name.stderr.trim() || undefined };
      }
      const res = await exec(tmuxFocusCommand(pane, sessionName, clientTty));
      if (res.code === 0) {
        return {
          ok: true,
          detail: clientTty
            ? `switched the client on ${clientTty} to ${sessionName} pane ${pane}`
            : `switched to ${sessionName} pane ${pane}`,
        };
      }
      return { ok: false, detail: 'tmux refused the switch', reason: res.stderr.trim() || undefined };
    },
  };

  const kitty: TerminalAdapter = {
    kind: 'kitty',
    label: 'kitty',
    liveVerified: false,
    canTarget: (s) => Boolean(s.terminal.kittyWindowId),
    describeTarget: (s) => `window ${s.terminal.kittyWindowId ?? '?'}`,
    plan: (s) =>
      s.terminal.kittyWindowId ? [kittyCommand(s.terminal.kittyWindowId, s.terminal.kittyListenOn)] : [],
    async focus(s): Promise<FocusResult> {
      const id = s.terminal.kittyWindowId;
      if (!id) return { ok: false, detail: 'no kitty window id stored' };
      const res = await exec(kittyCommand(id, s.terminal.kittyListenOn));
      if (res.code === 0) return { ok: true, detail: `focused kitty window ${id}` };
      return {
        ok: false,
        detail: 'kitty refused the focus',
        reason: /allow_remote_control/i.test(res.stderr)
          ? 'set allow_remote_control yes in kitty.conf'
          : res.stderr.trim() || undefined,
      };
    },
  };

  const wezterm: TerminalAdapter = {
    kind: 'wezterm',
    label: 'WezTerm',
    liveVerified: false,
    canTarget: (s) => Boolean(s.terminal.weztermPane),
    describeTarget: (s) => `pane ${s.terminal.weztermPane ?? '?'}`,
    plan: (s) => (s.terminal.weztermPane ? [weztermCommand(s.terminal.weztermPane)] : []),
    async focus(s): Promise<FocusResult> {
      const pane = s.terminal.weztermPane;
      if (!pane) return { ok: false, detail: 'no wezterm pane stored' };
      const res = await exec(weztermCommand(pane));
      // activate-pane moves the pane focus inside WezTerm and nothing else, so the
      // detail must not read like a completed jump.
      if (res.code === 0) {
        return {
          ok: true,
          detail: `activated wezterm pane ${pane}. WezTerm cannot bring its own window forward, so the window stays where it was`,
        };
      }
      return { ok: false, detail: 'wezterm refused the activation', reason: res.stderr.trim() || undefined };
    },
  };

  /** Awareness only: notify and highlight, never guess at a window (D5). */
  const fallback: TerminalAdapter = {
    kind: 'fallback',
    label: 'awareness only',
    canTarget: () => true,
    describeTarget: (s) => (s.terminal.tty ? `tty ${s.terminal.tty}` : 'no terminal handle'),
    plan: () => [],
    focus: () =>
      Promise.resolve({
        ok: false,
        detail: 'notify and highlight',
        reason: 'no jumpable terminal detected',
      }),
  };

  return {
    tmux,
    'apple-terminal': osaAdapter('apple-terminal', 'Terminal.app', appleTerminalCommand, true),
    iterm2: osaAdapter('iterm2', 'iTerm2', iterm2Command, false),
    kitty,
    wezterm,
    unknown: fallback,
    fallback,
  };
}

export type AdapterRegistry = ReturnType<typeof createAdapters>;

export function adapterFor(session: WireSession, registry: AdapterRegistry = createAdapters()): TerminalAdapter {
  const a = registry[session.terminal.kind] ?? registry.fallback;
  return a.canTarget(session) ? a : registry.fallback;
}

/** Adapter the current process would use, for `doctor`. */
export function detectLocalAdapter(
  env: NodeJS.ProcessEnv = process.env,
  registry: AdapterRegistry = createAdapters({ env }),
): TerminalAdapter {
  if (env.TMUX && env.TMUX_PANE) return registry.tmux;
  if (env.KITTY_WINDOW_ID) return registry.kitty;
  if (env.WEZTERM_PANE) return registry.wezterm;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.ITERM_SESSION_ID) return registry.iterm2;
  if (env.TERM_PROGRAM === 'Apple_Terminal') return registry['apple-terminal'];
  return registry.fallback;
}
