/**
 * `cctap keys`: every way to reach a session, cheapest first. cctap binds nothing
 * itself, so this prints what to paste rather than doing it for you.
 * The `status` and `undo` subcommands read and reverse the keys journal (CONTRACTS 8).
 */

import * as fs from 'node:fs';
import { execBlocked, realExec } from '../exec.js';
import { cctapInvocation, paths } from '../paths.js';
import { runKeysSetup } from './keys-setup.js';
import {
  appendJournal,
  readJournal,
  renderStatus,
  runUndo,
  statusAll,
  writeJournal,
  type JournalStatus,
} from './keys-journal.js';
import { readInstallRecord } from './install.js';

export async function cmdKeys(args: string[] = []): Promise<number> {
  const p = paths();
  const node = readInstallRecord(p)?.nodePath ?? process.execPath;
  const cli = `"${node}" "${p.cliBin}"`;
  const installed = fs.existsSync(p.cliBin);

  if (args[0] === 'status') {
    const entries = readJournal(p);
    const blocked = execBlocked();
    const statuses: JournalStatus[] = blocked
      ? entries.map((entry) => ({ entry, state: 'unknown' as const }))
      : await statusAll(entries, realExec);
    process.stdout.write(`${renderStatus({ statuses, file: p.keys, blocked }).join('\n')}\n`);
    return 0;
  }

  if (args[0] === 'undo') {
    const entries = readJournal(p);
    const result = await runUndo({
      entries,
      exec: realExec,
      blocked: execBlocked(),
      all: args.includes('--all'),
    });
    if (result.remaining.length !== entries.length) writeJournal(p, result.remaining);
    process.stdout.write(`${result.lines.join('\n')}\n`);
    return result.code;
  }

  if (args[0] === 'setup') {
    const rest = args.slice(1).filter((a) => a !== '--os');
    const result = await runKeysSetup({
      platform: process.platform,
      exec: realExec,
      env: process.env,
      osOnly: args.includes('--os'),
      jumpLine: `${cli} jump`,
      slotLines: [1, 2, 3].map((slot) => ({ slot, line: `${cli} jump ${slot}` })),
      key: rest.find((a) => !a.startsWith('-')),
    });
    for (const entry of result.journal ?? []) appendJournal(p, entry);
    process.stdout.write(`${result.lines.join('\n')}\n`);
    return result.code;
  }

  const run = cctapInvocation();
  const lines: string[] = [];
  lines.push('the instant jump is a system-wide key, and setup carries it as far as your OS allows:');
  lines.push(`  ${run} keys setup        macOS to the Shortcuts doorstep, GNOME written for you, tmux bound live`);
  lines.push('');

  if (!installed) {
    lines.push(`the recipes below need the installed copy at ${p.cliBin}`);
    lines.push('  run: cctap install-hooks');
    lines.push('');
  }

  lines.push('what that does by hand, on macOS (Shortcuts, one "Run Shell Script" action):');
  lines.push('  open Shortcuts, new shortcut, paste the line, then assign a key in the details');
  lines.push('  panel. Ctrl+Cmd+J is free on a stock Mac. Raycast, Alfred and Hammerspoon take the');
  lines.push('  same line.');
  lines.push(`    ${cli} jump`);
  lines.push('');
  lines.push('on Linux, bind the same line in your desktop keyboard settings (GNOME and KDE both');
  lines.push('take a custom shortcut with a command). Super+J is a good free one. `cctap keys setup`');
  lines.push('writes it for you on GNOME.');
  lines.push('');
  lines.push('inside tmux, `cctap keys setup` binds prefix + g in the running server, nothing');
  lines.push('written, `tmux unbind-key g` undoes it. The ~/.tmux.conf line, if you want it to');
  lines.push('survive a server restart:');
  lines.push(`  bind-key g run-shell -b '${cli} jump >/dev/null 2>&1'`);
  lines.push('');
  lines.push('a jump also lands from any shell or a running strip:');
  lines.push(`  ${`${run} 2`.padEnd(22)}  slot 2, from any shell`);
  lines.push(`  ${'press 2'.padEnd(22)}  in a running cctap strip or cctap top`);
  if (run !== 'cctap') {
    lines.push('  that is npx because cctap is not on your PATH. `npm install -g @chipmates/cctap` shortens it.');
  }
  lines.push('');
  lines.push('cctap binds no keys and edits no config of yours, unless you run keys setup. What it');
  lines.push('binds then is written down, and taking it back is one command:');
  lines.push(`  ${`${run} keys status`.padEnd(22)}  what cctap bound, and whether it is still bound`);
  lines.push(`  ${`${run} keys undo`.padEnd(22)}  take the newest one back (--all for every one)`);
  lines.push('');
  lines.push('advanced: a key per session, if you want them. Claude Code binds Alt+1 to Alt+9 in');
  lines.push('its agent view, so pick something else for these.');
  for (const slot of [1, 2, 3]) lines.push(`  ${cli} jump ${slot}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
