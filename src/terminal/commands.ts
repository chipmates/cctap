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
 * AppleScript string literal escaping. Every value interpolated into a script below is
 * a string literal, and a quote inside one ends it early: the rest would be read as
 * source. Lives here rather than beside the notifier so the terminal layer never has to
 * reach up into the daemon layer for it.
 */
export function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
    `\t\t\t\tif tty of t is "${appleScriptString(ttyPath(tty))}" then`,
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
    `\t\t\t\t\tif tty of s is "${appleScriptString(ttyPath(tty))}" then`,
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

/**
 * The last argument of a list-keys row, with tmux's own quoting taken back off. tmux
 * echoes an argument that needs it inside double quotes and escapes with backslashes,
 * so the run-shell command comes back as one token however many spaces it holds.
 */
function lastArgument(s: string): string | undefined {
  let cur = '';
  let last: string | undefined;
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      started = true;
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(c)) {
      if (started) last = cur;
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  return started ? cur : last;
}

/**
 * What the row for this key actually runs. Comparing against the whole row instead
 * would call any superstring a match, so a foreign binding that happens to quote our
 * jump line inside a longer command would read back as ours.
 */
export function boundCommand(row: string): string | undefined {
  const head = /(^|\s)-T\s+\S+\s+\S+\s+/.exec(row);
  if (!head) return undefined;
  return lastArgument(row.slice(head.index + head[0].length));
}

export function tmuxUnbindLine(key: string): string {
  return `tmux unbind-key ${key}`;
}

/**
 * The ~/.tmux.conf line that survives a server restart. Single quotes because the
 * jump line carries its own double quotes, and tmux expands `#{}` and `$` inside
 * double-quoted strings: the fallback branch has to neutralise both, since a home
 * directory with an apostrophe in it is what forces the fallback in the first place.
 */
export function tmuxConfLine(key: string, runLine: string): string {
  const quoted = runLine.includes("'")
    ? `"${runLine.replace(/[\\"]/g, (c) => `\\${c}`).replace(/#/g, '##').replace(/\$/g, '\\$')}"`
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
