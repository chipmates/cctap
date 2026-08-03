/**
 * Every command a jump can run, built purely from a TerminalInfo.
 * Nothing here executes anything, so the exact argv is unit-testable and no test
 * ever pops an Automation consent dialog.
 */

import type { Command } from '../exec.js';

/** The daemon stores `ttys003`; AppleScript compares against the device path. */
export function ttyPath(tty: string): string {
  return tty.startsWith('/') ? tty : `/dev/${tty}`;
}

/**
 * Walks every window and tab, selects the one on this tty and raises it.
 * Returns "ok" or "notfound" on stdout so the caller can fall back cleanly.
 */
export function appleTerminalScript(tty: string): string {
  return [
    'tell application "Terminal"',
    '\trepeat with w in windows',
    '\t\ttry',
    '\t\t\trepeat with t in tabs of w',
    `\t\t\t\tif tty of t is "${ttyPath(tty)}" then`,
    '\t\t\t\t\tset selected of t to true',
    '\t\t\t\t\tset index of w to 1',
    '\t\t\t\t\tactivate',
    '\t\t\t\t\treturn "ok"',
    '\t\t\t\tend if',
    '\t\t\tend repeat',
    '\t\tend try',
    '\tend repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
}

export function appleTerminalCommand(tty: string): Command {
  return { cmd: 'osascript', args: ['-e', appleTerminalScript(tty)] };
}

/**
 * Targets the bundle id, so it works whether the app is installed as iTerm2 or iTerm.
 * Naming the app by string breaks on the older install.
 */
export function iterm2Script(tty: string): string {
  return [
    'tell application id "com.googlecode.iterm2"',
    '\trepeat with w in windows',
    '\t\ttry',
    '\t\t\trepeat with t in tabs of w',
    '\t\t\t\trepeat with s in sessions of t',
    `\t\t\t\t\tif tty of s is "${ttyPath(tty)}" then`,
    '\t\t\t\t\t\tselect w',
    '\t\t\t\t\t\tselect t',
    '\t\t\t\t\t\tselect s',
    '\t\t\t\t\t\tactivate',
    '\t\t\t\t\t\treturn "ok"',
    '\t\t\t\t\tend if',
    '\t\t\t\tend repeat',
    '\t\t\tend repeat',
    '\t\tend try',
    '\tend repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
}

export function iterm2Command(tty: string): Command {
  return { cmd: 'osascript', args: ['-e', iterm2Script(tty)] };
}

/** switch-client needs a session name, and only the pane id is stored. */
export function tmuxSessionNameCommand(pane: string): Command {
  return { cmd: 'tmux', args: ['display', '-p', '-t', pane, '#{session_name}'] };
}

/** From outside a client, the attached clients are the only things left to move. */
export function tmuxListClientsCommand(): Command {
  return { cmd: 'tmux', args: ['list-clients', '-F', '#{client_activity} #{client_tty}'] };
}

/**
 * Highest activity wins, ties keep the first line. Activity is a unix epoch, so the
 * compare is numeric and has to hold values past 32 bits.
 */
export function pickMostRecentClient(stdout: string): string | undefined {
  let best: string | undefined;
  let bestAt = -Infinity;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const sep = line.indexOf(' ');
    if (sep <= 0) continue;
    const at = Number(line.slice(0, sep));
    const tty = line.slice(sep + 1).trim();
    if (!Number.isFinite(at) || tty === '') continue;
    if (at > bestAt) {
      bestAt = at;
      best = tty;
    }
  }
  return best;
}

/**
 * One tmux invocation: `;` is a command separator in argv, no shell involved.
 * A client tty targets an attached client, which is the only way to move one from
 * outside it.
 */
export function tmuxFocusCommand(pane: string, sessionName: string, clientTty?: string): Command {
  return {
    cmd: 'tmux',
    args: [
      'switch-client',
      ...(clientTty ? ['-c', clientTty] : []),
      '-t',
      sessionName,
      ';',
      'select-window',
      '-t',
      pane,
      ';',
      'select-pane',
      '-t',
      pane,
    ],
  };
}

/** run-shell hands the line to sh, so the redirect in it is a shell redirect. */
export function tmuxBindCommand(key: string, note: string, runLine: string, withNote: boolean): Command {
  return {
    cmd: 'tmux',
    args: ['bind-key', ...(withNote ? ['-N', note] : []), key, 'run-shell', '-b', runLine],
  };
}

/**
 * The whole prefix table. Asking for one key (`list-keys -T prefix <key>`) answers
 * empty on some builds even when the key is bound, so the filtering happens here.
 */
export function tmuxListKeysCommand(): Command {
  return { cmd: 'tmux', args: ['list-keys', '-T', 'prefix'] };
}

/** list-keys quotes keys that would not survive unquoted, `"` and `'` among them. */
function unquoteKey(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.length >= 2 && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * The line binding this key, verbatim. Rows read `bind-key -T prefix g run-shell -b x`
 * with variable whitespace and carry no `-N` note, so a caller can only recognise its
 * own binding by the command text.
 */
export function findKeyBinding(stdout: string, key: string): string | undefined {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const tokens = line.split(/\s+/);
    const table = tokens.indexOf('-T');
    if (table < 0 || tokens[table + 1] !== 'prefix') continue;
    const bound = tokens[table + 2];
    if (bound === undefined) continue;
    if (bound === key || unquoteKey(bound) === key) return line;
  }
  return undefined;
}

export function tmuxUnbindLine(key: string): string {
  return `tmux unbind-key ${key}`;
}

/**
 * The ~/.tmux.conf line that survives a server restart. Single quotes because the
 * jump line carries its own double quotes, and tmux expands `#{}` and `$` inside
 * double-quoted strings.
 */
export function tmuxConfLine(key: string, runLine: string): string {
  const quoted = runLine.includes("'")
    ? `"${runLine.replace(/[\\"]/g, (c) => `\\${c}`)}"`
    : `'${runLine}'`;
  return `bind-key ${key} run-shell -b ${quoted}`;
}

/**
 * `--to` belongs to `kitten @`, not to the subcommand, so it goes before `focus-window`.
 * Without it the jump only works from inside kitty, where the socket is in the env.
 */
export function kittyCommand(windowId: string, listenOn?: string): Command {
  return {
    cmd: 'kitten',
    args: ['@', ...(listenOn ? ['--to', listenOn] : []), 'focus-window', '--match', `id:${windowId}`],
  };
}

export function weztermCommand(pane: string): Command {
  return { cmd: 'wezterm', args: ['cli', 'activate-pane', '--pane-id', pane] };
}

/** macOS refuses Apple events with -1743 until the user grants Automation consent. */
export function isConsentDenial(stderr: string, code: number): boolean {
  if (code === 0) return false;
  return /-1743/.test(stderr) || /not authori[sz]ed to send apple events/i.test(stderr);
}

/** The app is not running, so there is no window to raise. */
export function isAppMissing(stderr: string, code: number): boolean {
  if (code === 0) return false;
  return /-600\b/.test(stderr) || /application isn'?t running/i.test(stderr);
}
