/**
 * `cctap keys setup`: carries the system-wide jump key as far as each OS allows.
 * macOS has no API to create a shortcut, so it goes to the doorstep (line on the
 * clipboard, Shortcuts open, three steps printed). GNOME has gsettings, so it is done.
 * Everything goes through the exec seam: CCTAP_NO_EXEC degrades to printing.
 */

import { execBlocked, realExec, type Exec } from '../exec.js';
import {
  findKeyBinding,
  tmuxBindCommand,
  tmuxConfLine,
  tmuxListKeysCommand,
  tmuxUnbindLine,
} from '../terminal/commands.js';
import {
  formatCommand,
  GNOME_ITEM,
  GNOME_KEYS,
  GNOME_LIST,
  GNOME_PATH,
  gnomeReadCommand,
  gnomeUndo,
  gvariantString,
  tmuxUndo,
  type GnomePrevious,
  type JournalEntry,
} from './keys-journal.js';

/**
 * Suggested keys. Not Alt+digit: Claude Code binds Alt+1 through Alt+9 in its agent
 * view. Not Option+J either, which a terminal reads as Meta-j.
 */
const MAC_KEY = 'Ctrl+Cmd+J';
const LINUX_KEY = 'super+j';
/** A bare key in the prefix table, so it reads as `prefix + g`. */
const TMUX_KEY = 'g';
const TMUX_NOTE = 'cctap: jump to the session that needs you';

/** How GNOME spells each modifier word a person may type. */
const GNOME_MODS: Record<string, string> = {
  alt: '<Alt>',
  option: '<Alt>',
  ctrl: '<Control>',
  control: '<Control>',
  shift: '<Shift>',
  super: '<Super>',
  cmd: '<Super>',
  meta: '<Super>',
};

/** The accepted modifier words, in the order the rejection message lists them. */
export const MODIFIER_WORDS = Object.keys(GNOME_MODS);

/** Own properties only: `constructor+j` must be an unknown word, not a function. */
function modifierFor(word: string): string | undefined {
  const w = word.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GNOME_MODS, w) ? GNOME_MODS[w] : undefined;
}

/**
 * W2: what is wrong with a key, or undefined when nothing is. A word that is not a
 * modifier would be dropped silently, and `hyper+j` would bind a bare j system wide.
 */
export function keyProblem(key: string): string | undefined {
  const parts = key.split('+');
  if ((parts[parts.length - 1] ?? '').trim() === '') {
    return 'the key itself is missing after the last +';
  }
  for (const part of parts.slice(0, -1)) {
    if (modifierFor(part) === undefined) return `"${part.trim()}" is not a modifier cctap knows`;
  }
  return undefined;
}

/** `alt+j` to GNOME's `<Alt>j`. Unknown words are passed through as written. */
export function gnomeBinding(key: string): string {
  const parts = key.split('+').map((x) => x.trim()).filter((x) => x !== '');
  let out = '';
  let final = '';
  for (const part of parts) {
    const mod = modifierFor(part);
    if (mod) out += mod;
    else final = part;
  }
  return `${out}${final}`;
}

export interface SetupOptions {
  platform: string;
  exec: Exec;
  /** The quoted absolute command a hotkey should run. */
  jumpLine: string;
  /** Per-slot variants, for people who want a key each. */
  slotLines: { slot: number; line: string }[];
  key?: string;
  blocked?: boolean;
  /** Passed in rather than read here, so a test never inherits a real $TMUX. */
  env?: NodeJS.ProcessEnv;
  /** `--os`: skip the tmux bind and set up the system-wide key instead. */
  osOnly?: boolean;
  /** Injected so a journal entry is byte-comparable in a test. */
  now?: number;
  /**
   * Printed the moment it is written, not collected for the end. A warning about the
   * clipboard has to reach the person before the clipboard goes, and everything the
   * caller returns is printed after the last command has already run.
   */
  echo?: (line: string) => void;
}

export interface SetupResult {
  lines: string[];
  code: number;
  /**
   * K1: what this run actually wrote, for the caller to append to the keys journal.
   * Building it here and writing it there keeps this function free of the filesystem.
   */
  journal?: JournalEntry[];
}

/** Advanced, and last: most people want one key, and Alt+digit is already taken. */
function slotFootnote(o: SetupOptions): string[] {
  return [
    '',
    'advanced: one key per session, if you want them. Claude Code binds Alt+1 to Alt+9 in',
    'its agent view, so pick something else for these.',
    ...o.slotLines.map((s) => `  ${s.line}`),
  ];
}

function recipeOnly(o: SetupOptions, why: string | string[]): SetupResult {
  const head = typeof why === 'string' ? [why] : why;
  return { lines: [...head, '', 'the line to bind:', `  ${o.jumpLine}`, ...slotFootnote(o)], code: 0 };
}

async function setupMac(o: SetupOptions): Promise<SetupResult> {
  const key = o.key ?? MAC_KEY;
  const lines: string[] = [];
  // W4: setup is not interactive, so the only consent shape left is saying it plainly
  // before the clipboard is taken. Through the echo sink, because everything in `lines`
  // is printed by the caller once pbcopy has long since run.
  o.echo?.('before anything runs: the jump command is about to replace whatever is on your clipboard.');
  o.echo?.('');
  const copied = await o.exec({ cmd: 'pbcopy', args: [], input: o.jumpLine });
  const opened = await o.exec({ cmd: 'open', args: ['shortcuts://create-shortcut'] });
  if (copied.code !== 0 && opened.code !== 0) {
    return recipeOnly(o, 'could not reach pbcopy or open, so here is the manual version.');
  }

  lines.push('macOS has no way for a program to create a shortcut, so this goes to the doorstep:');
  lines.push('');
  if (copied.code === 0) lines.push('  the jump command is on your clipboard');
  if (opened.code === 0) lines.push('  Shortcuts is opening on a new shortcut');
  lines.push('');
  lines.push('  1. type "shell" in the actions search, top right, and double-click "Run Shell Script"');
  lines.push('  2. the action lands saying scripting actions are disabled. Click Open Preferences on');
  lines.push('     it, turn on "Allow Running Scripts", and come back (older macOS hides the action');
  lines.push('     instead: same switch, under Shortcuts > Settings > Advanced)');
  lines.push('  3. click into the script box and paste (cmd-V). The pasted line must end in: jump');
  lines.push('  4. name the shortcut at the top, "cctap jump" reads well in the consent dialog later');
  lines.push(`  5. the key hides behind the small (i) at the top right: open it, "Add Keyboard`);
  lines.push(`     Shortcut", press the keys. ${key} is free on a stock Mac`);
  lines.push('  6. press that key once straight away, while you are still looking at the desktop');
  lines.push('  7. done. That key now jumps to whatever needs you, from anywhere, full screen included');
  lines.push('');
  lines.push('step 6 is the one people skip. That first press pops a second consent dialog, worded');
  lines.push('nothing like the first. macOS names Shortcuts as the app asking for Automation consent,');
  lines.push('not cctap and not your terminal, because it grants terminal control per app. A full');
  lines.push('screen window can hide that dialog behind itself, so fire the key while you are still at');
  lines.push('the desktop watching for it.');
  if (copied.code !== 0) {
    lines.push('');
    lines.push('the clipboard was not reachable, so paste this instead:');
    lines.push(`  ${o.jumpLine}`);
  }
  lines.push(...slotFootnote(o));
  return { lines, code: 0 };
}

async function setupGnome(o: SetupOptions): Promise<SetupResult> {
  // W2: validated ahead of the probe, so a word nobody understood reaches no command at all.
  const problem = keyProblem(o.key ?? LINUX_KEY);
  if (problem !== undefined) {
    return recipeOnly(o, [
      `${problem}, so nothing was bound and nothing was written down.`,
      '',
      'a key is its modifiers first and the key itself last. The modifiers cctap takes:',
      `  ${MODIFIER_WORDS.join(', ')}`,
      'so ctrl+alt+t is a key it can write, and so is a bare F9.',
    ]);
  }

  const probe = await o.exec({ cmd: 'gsettings', args: ['get', GNOME_LIST, 'custom-keybindings'] });
  if (probe.code !== 0) {
    return recipeOnly(
      o,
      'no GNOME custom-keybindings schema here, so bind it in your desktop\'s own keyboard settings.',
    );
  }

  const current = probe.stdout.trim();
  const already = current.includes(GNOME_PATH);
  const list = already
    ? current
    : current === '@as []' || current === '[]'
      ? `['${GNOME_PATH}']`
      : `${current.replace(/\]$/, '')}, '${GNOME_PATH}']`;
  const binding = gnomeBinding(o.key ?? LINUX_KEY);

  // K7: the full prior state of the path, not only the list it is registered in. The
  // path is a fixed one, so a second tool (or an older cctap) may already have written
  // an object there, and an undo that only reset it would delete what it found.
  const held: GnomePrevious = { list: current };
  for (const k of GNOME_KEYS) {
    const got = await o.exec({ cmd: 'gsettings', args: ['get', GNOME_ITEM, k] });
    const value = got.code === 0 ? gvariantString(got.stdout) : '';
    if (value !== '') held[k] = value;
  }
  const previous: string | GnomePrevious = GNOME_KEYS.some((k) => held[k] !== undefined) ? held : current;

  // W1: the object's own keys first, the list registration last. GNOME watches the list,
  // so registering first races the settings daemon against a half-written object.
  const writes = [
    { cmd: 'gsettings', args: ['set', GNOME_ITEM, 'name', 'cctap-jump'] },
    { cmd: 'gsettings', args: ['set', GNOME_ITEM, 'command', o.jumpLine] },
    { cmd: 'gsettings', args: ['set', GNOME_ITEM, 'binding', binding] },
    { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', list] },
  ];

  const entry: JournalEntry = {
    at: o.now ?? Date.now(),
    kind: 'gnome-keybinding',
    key: binding,
    command: o.jumpLine,
    undo: gnomeUndo(previous),
    previous,
  };

  for (const [i, w] of writes.entries()) {
    const res = await o.exec(w);
    if (res.code === 0) continue;
    const why = `gsettings refused: ${res.stderr.trim() || `exit ${res.code}`}. Bind it by hand instead.`;
    // A refusal partway through leaves the writes that already landed sitting in dconf.
    // Journaling them is what keeps them visible to keys status, keys undo and the purge
    // guard; a failure with nothing written down is the one that strands them.
    if (i === 0) return recipeOnly(o, why);
    const landed = `the ${i} write${i === 1 ? '' : 's'} that did land are in the keys journal:`;
    return { ...recipeOnly(o, [why, '', landed, '  cctap keys undo']), journal: [entry] };
  }

  // W3: a desktop that grabbed the key already refuses ours in silence, so the value read
  // back is the only honest answer. The entry is journaled either way: a write nobody can
  // undo is worse than a write that failed.
  const back = await o.exec(gnomeReadCommand());
  const live = back.code === 0 ? gvariantString(back.stdout) : '';
  if (live !== o.jumpLine) {
    return {
      lines: [
        'the writes went through, but reading the binding back gave something else, so this failed.',
        '',
        `  wrote  ${o.jumpLine}`,
        `  read   ${live === '' ? '(nothing came back)' : live}`,
        '',
        'something else may own that path, or the settings daemon rewrote it. The write is in the',
        'keys journal either way, so the way back is one command:',
        '  cctap keys undo',
        '',
        'which runs exactly this:',
        ...entry.undo.map((c) => `  ${formatCommand(c)}`),
      ],
      code: 1,
      journal: [entry],
    };
  }

  return {
    lines: [
      `bound ${binding} to the jump.`,
      '',
      'exactly what was written:',
      `  name     cctap-jump`,
      `  command  ${o.jumpLine}`,
      `  binding  ${binding}`,
      `  under    ${GNOME_PATH}`,
      '',
      'read back from gsettings after the write, and the command matches.',
      '',
      'to undo it:',
      '  cctap keys undo',
      '',
      'which runs exactly this:',
      ...entry.undo.map((c) => `  ${formatCommand(c)}`),
      '',
      ...slotFootnote(o),
    ],
    code: 0,
    journal: [entry],
  };
}

/**
 * Inside tmux the bind is one command away, and it writes nothing: the bind lives in
 * the running server, and ~/.tmux.conf stays the user's own file.
 */
async function setupTmux(o: SetupOptions): Promise<SetupResult> {
  const key = o.key ?? TMUX_KEY;
  const explicit = o.key !== undefined;
  // run-shell prints stdout in a blocking view, and a jump that moved the client
  // has nothing left to say.
  const runLine = `${o.jumpLine} >/dev/null 2>&1`;

  const scan = await o.exec(tmuxListKeysCommand());
  const existing = (scan.code === 0 ? findKeyBinding(scan.stdout, key) : undefined) ?? '';
  // list-keys echoes the bound command with its quotes escaped, so the jump line only
  // matches once those come back off.
  const plain = existing.replace(/\\(["\\])/g, '$1');
  // Only our own jump line counts as ours. Treating any binding that merely mentions
  // cctap as ours meant someone's own `run-shell cctap top` was rebound over silently,
  // with nothing journaled to put it back.
  const ours = existing !== '' && plain.includes(o.jumpLine);

  if (existing !== '' && !ours && !explicit) {
    return {
      lines: [
        `prefix + ${key} is already bound to something else, so nothing was changed:`,
        `  ${existing}`,
        '',
        'pick a free key and cctap takes that one:',
        '  cctap keys setup j',
        '',
        `or pass the same key to take it over: cctap keys setup ${key}`,
        ...slotFootnote(o),
      ],
      code: 0,
    };
  }

  let bound = await o.exec(tmuxBindCommand(key, TMUX_NOTE, runLine, true));
  // tmux learned -N in 3.1, and an older one fails the whole bind over it.
  if (bound.code !== 0) bound = await o.exec(tmuxBindCommand(key, TMUX_NOTE, runLine, false));
  if (bound.code !== 0) {
    const why = bound.stderr.trim() || `exit ${bound.code}`;
    return recipeOnly(o, `tmux refused the bind: ${why}. Bind it by hand instead.`);
  }

  const takeover = existing !== '' && !ours && explicit;
  const lines = [`prefix + ${key} now jumps to the session that needs you, in every tmux session.`];
  if (takeover) {
    lines.push('', 'what was bound to it before:', `  ${existing}`, 're-sourcing your tmux config brings that back.');
  }
  lines.push(
    '',
    'to undo it:',
    `  ${tmuxUnbindLine(key)}`,
    '  cctap keys undo, which runs the same thing without you remembering the key',
    '',
    'the bind lives until the tmux server exits. To keep it, add this line to ~/.tmux.conf:',
    `  ${tmuxConfLine(key, runLine)}`,
    '',
    'an OS-wide key reaches the same jump from outside tmux, full screen included:',
    '  cctap keys setup --os',
    ...slotFootnote(o),
  );
  // K2: journaled although it dies with the tmux server, so undo can take it back
  // without the user remembering which key it was.
  return {
    lines,
    code: 0,
    journal: [
      {
        at: o.now ?? Date.now(),
        kind: 'tmux-bind',
        key,
        command: runLine,
        undo: tmuxUndo(key),
        ...(takeover ? { previous: existing } : {}),
      },
    ],
  };
}

export async function runKeysSetup(opts: SetupOptions): Promise<SetupResult> {
  if (opts.blocked ?? execBlocked()) {
    return recipeOnly(opts, 'CCTAP_NO_EXEC is set, so nothing was run. This is what it would have done.');
  }
  if (opts.env?.TMUX && !opts.osOnly) return setupTmux(opts);
  if (opts.platform === 'darwin') return setupMac(opts);
  if (opts.platform === 'linux') return setupGnome(opts);
  return recipeOnly(opts, `no automatic setup for ${opts.platform}, so bind it yourself.`);
}

export const setupDefaults = { exec: realExec, macKey: MAC_KEY, linuxKey: LINUX_KEY };
