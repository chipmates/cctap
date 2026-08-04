/**
 * `cctap install-hooks` / `uninstall-hooks`. All twelve install safety rules:
 * backup, deep merge, precise signature, JSON round-trip, atomic write, diff summary,
 * dry run, CCTAP_CLAUDE_SETTINGS override, the live-pickup note, one ownership answer,
 * and the status line, which is written only when the user has none of their own.
 */

import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bundleDir } from '../client.js';
import { execBlocked, realExec, type Exec } from '../exec.js';
import {
  BIN_FILES,
  cctapInvocation,
  claudeSettingsPath,
  ensureDirs,
  FILE_MODE,
  isOurBinFile,
  isOurSpoolFile,
  paths,
  readJsonFile,
  writeFileAtomic,
  type Paths,
} from '../paths.js';
import { readJournal } from './keys-journal.js';
import { countForeign, countOurs, mergeHooks, removeHooks, REGISTRATIONS, type Settings } from '../install/hooks.js';
import { mergeStatusLine, removeStatusLine } from '../install/statusline.js';
import { VERSION } from '../version.js';

/**
 * Exit 2 on the first argument we do not recognize. `install-hooks --dry-rnu` used to
 * perform the real install and report success, which is the worst possible answer to a
 * typo in the flag that means "change nothing".
 *
 * A value form is refused for the same reason: no flag here takes one, and `--dry-run=1`
 * validated as the flag while every `includes('--dry-run')` that decides anything read it
 * as absent, so the run told to change nothing did the whole real thing and exited 0.
 */
export function rejectUnknown(args: string[], known: readonly string[], command: string): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue;
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!known.includes(name)) {
      return `cctap: unknown option "${arg}" for ${command}\n  known: ${known.join(', ')}\n`;
    }
    if (eq >= 0) {
      return `cctap: "${arg}" is not an option for ${command}: "${name}" takes no value\n  write it as "${name}"\n`;
    }
  }
  return undefined;
}

export interface InstallRecord {
  version: string;
  nodePath: string;
  forwarderPath: string;
  settingsPath: string;
  installedAt: number;
}

export interface Ownership {
  forwarder: string;
  cliBin: string;
}

/**
 * One identity for both ownership tests. Hooks and the status line must agree on what
 * belongs to this install, or a run against the wrong CCTAP_DIR removes half of it.
 */
export function ownership(p: Paths = paths()): Ownership {
  const forwarder = readInstallRecord(p)?.forwarderPath ?? p.hookForward;
  return { forwarder, cliBin: join(dirname(forwarder), 'cctap.mjs') };
}

function readSettings(file: string): { settings: Settings; existed: boolean; raw: string } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { settings: parsed as Settings, existed: true, raw };
    }
    throw new Error('settings root is not an object');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { settings: {}, existed: false, raw: '' };
    throw err;
  }
}

/**
 * A raw SyntaxError sends people to file permissions. Name the real problem, and the
 * two things that make a settings file unparseable in practice.
 */
function cannotRead(file: string, err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  if (!(err instanceof SyntaxError)) {
    return `cctap: cannot read ${file}\n  ${why}\n  Nothing was changed.\n`;
  }
  const at = /line (\d+) column (\d+)/.exec(why);
  const where = at ? ` (line ${at[1]}, column ${at[2]})` : '';
  return [
    `cctap: cannot parse ${file} as JSON${where}. Nothing was changed.`,
    '  Claude Code settings must be strict JSON: no comments, no trailing commas.',
    '',
  ].join('\n');
}

/** Rule 5: parse what we are about to write before we write it. */
function serializeChecked(settings: Settings): string {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const back = JSON.parse(text) as unknown;
  if (JSON.stringify(back) !== JSON.stringify(settings)) throw new Error('settings failed JSON round-trip');
  return text;
}

const KEEP_BACKUPS = 5;

/** Backups accumulate on every run, so keep the five newest and name what went. */
function pruneBackups(settingsFile: string): string[] {
  const dir = dirname(settingsFile);
  const base = `${basename(settingsFile)}.cctap-bak-`;
  try {
    const olds = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base))
      .sort()
      .slice(0, -KEEP_BACKUPS);
    for (const f of olds) fs.unlinkSync(join(dir, f));
    return olds;
  } catch {
    return [];
  }
}

/**
 * Milliseconds and the pid, because an install and an uninstall inside the same second
 * both wanted the same name and the second copy overwrote the first. That first one is
 * the file holding someone's pre-cctap settings.
 */
function backupPath(file: string, now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/Z$/, '').replace('.', '');
  return `${file}.cctap-bak-${ts}-${process.pid}`;
}

/**
 * Rule 2, exclusively: COPYFILE_EXCL means an existing backup is never the destination.
 * A taken name is answered with the next one, not with an overwrite.
 */
export function writeBackup(settingsFile: string, now: Date): string {
  const base = backupPath(settingsFile, now);
  for (let n = 0; n < 20; n++) {
    const dest = n === 0 ? base : `${base}-${n}`;
    try {
      fs.copyFileSync(settingsFile, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`cannot write a backup beside ${settingsFile}: 20 names in the same millisecond are taken`);
}

/**
 * Copies the bundled zero-dep scripts to the stable paths hooks point at. Written to a
 * temp name in the same directory and renamed into place: a hook firing mid-install
 * loads the old bundle or the new one, never half of either.
 */
export function copyBinaries(p: Paths, dryRun: boolean): { copied: string[]; missing: string[] } {
  const src = bundleDir();
  const copied: string[] = [];
  const missing: string[] = [];
  for (const name of BIN_FILES) {
    const from = join(src, name);
    if (!fs.existsSync(from)) {
      missing.push(name);
      continue;
    }
    const to = join(p.bin, name);
    // Re-running the installed CLI would otherwise copy a file onto itself.
    if (resolve(from) === resolve(to)) continue;
    if (!dryRun) {
      const tmp = join(p.bin, `.${name}.tmp-${process.pid}`);
      try {
        fs.copyFileSync(from, tmp);
        fs.chmodSync(tmp, FILE_MODE);
        fs.renameSync(tmp, to);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* nothing to clean up */
        }
        throw err;
      }
    }
    copied.push(name);
  }
  return { copied, missing };
}

/** How many links deep a settings path may be chained before we stop following. */
const MAX_LINK_HOPS = 10;

/**
 * The path to write settings through. A settings.json managed by a dotfiles repo is a
 * symlink, and writing the link path replaces the link with a regular file: the repo
 * keeps the old content and stops managing anything. Resolving first writes through it,
 * and puts the backup beside the real file rather than beside the link.
 *
 * realpath answers that for a link whose target exists and throws ENOENT for one whose
 * target does not, which is a state a dotfiles setup passes through routinely: cloned but
 * not stowed yet, or the target moved for a moment. lstat still sees the link there, so
 * the chain is walked by hand and the write lands where the link points.
 */
function writeTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    /* nothing there, or a link whose target is not there */
  }
  let current = file;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let link: string;
    try {
      if (!fs.lstatSync(current).isSymbolicLink()) return current;
      link = fs.readlinkSync(current);
    } catch {
      return current; // nothing at this path, so this is where the file goes
    }
    current = isAbsolute(link) ? link : join(dirname(current), link);
  }
  return current;
}

/**
 * Cheap lost-update guard: a re-read right before the write, compared against what the
 * merge was computed from. Claude Code writes this file too, and a settings change made
 * while an install was thinking would otherwise be silently reverted.
 */
export function changedSince(file: string, seen: string, existed: boolean): boolean {
  try {
    return fs.readFileSync(file, 'utf8') !== seen;
  } catch (err) {
    // Absent is what we read the first time too, when the file did not exist.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return existed;
    return true;
  }
}

function raceMessage(file: string): string {
  return [
    `cctap: ${file} changed while this run was working it out. Nothing was changed.`,
    '  something else writes this file too. Run the command again.',
    '',
  ].join('\n');
}

export const INSTALL_FLAGS = ['--dry-run', '--no-status-line'] as const;

export async function cmdInstallHooks(args: string[]): Promise<number> {
  const bad = rejectUnknown(args, INSTALL_FLAGS, 'install-hooks');
  if (bad) {
    process.stderr.write(bad);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  const noStatusLine = args.includes('--no-status-line');
  const p = paths();
  const settingsFile = claudeSettingsPath();
  const nodePath = process.execPath;

  // Validate before anything is written. Reading the settings after the binaries were
  // already replaced made "Nothing was changed." a false statement in the one case it
  // is printed: the live hook executables had been swapped a moment earlier.
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(settingsFile);
  } catch (err) {
    process.stderr.write(cannotRead(settingsFile, err));
    return 1;
  }

  if (!dryRun) ensureDirs(p);
  const bins = copyBinaries(p, dryRun);
  if (bins.missing.length > 0) {
    process.stderr.write(`cctap: missing bundled files: ${bins.missing.join(', ')}\n`);
    if (bins.missing.includes('hook-forward.mjs')) return 1;
  }

  // Install registers what it just copied, so it matches on the current paths.
  const merged = mergeHooks(read.settings, nodePath, p.hookForward);
  const status = noStatusLine
    ? { settings: merged.settings, outcome: 'skipped' as const, command: '' }
    : mergeStatusLine(merged.settings, nodePath, p.cliBin);
  const text = serializeChecked(status.settings);
  const changed =
    merged.added.length + merged.replaced.length > 0 || status.outcome === 'added' || status.outcome === 'updated';

  const lines: string[] = [];
  lines.push(`settings:  ${settingsFile}${read.existed ? '' : ' (will be created)'}`);
  lines.push(`node:      ${nodePath}`);
  lines.push(`forwarder: ${p.hookForward}`);
  lines.push(`cli:       ${p.cliBin}`);
  lines.push('legend:    + added   ~ updated   = already correct   ! skipped');
  lines.push('');
  for (const name of merged.added) lines.push(`  + ${name}`);
  for (const name of merged.replaced) lines.push(`  ~ ${name} (updated)`);
  for (const name of merged.unchanged) lines.push(`  = ${name}`);
  for (const name of merged.skipped) lines.push(`  ! ${name} (skipped, see below)`);
  if (status.outcome === 'added') lines.push('  + statusLine (the strip, inside Claude Code)');
  else if (status.outcome === 'updated') lines.push('  ~ statusLine (updated)');
  else if (status.outcome === 'unchanged') lines.push('  = statusLine');
  else if (status.outcome === 'skipped') lines.push('  = statusLine (skipped, --no-status-line)');
  else lines.push('  = statusLine (not ours, left untouched)');

  if (status.outcome === 'foreign') {
    lines.push('');
    lines.push('you already have a status line, so it stays exactly as it is');
    lines.push(`to show both, print your own line and then run: ${status.command}`);
  }
  if (status.outcome === 'skipped') {
    lines.push('');
    lines.push('no status line was written. docs/GUIDE.md, section "In Claude Code\'s own status');
    lines.push('line", has the one-line JSON, if you want to add it by hand later.');
  }
  if (merged.skipped.length > 0) {
    lines.push('');
    lines.push(`${merged.skipped.length} registration${merged.skipped.length === 1 ? '' : 's'} could not be written:`);
    lines.push('the settings file holds a shape at those keys that is not the list of hook groups');
    lines.push('Claude Code documents. cctap left every one of them exactly as it found them.');
    lines.push('fix the shape by hand and run this again, and they install like the rest.');
  }

  if (dryRun) {
    lines.push('');
    lines.push('dry run: nothing written');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // Nothing to write means nothing to back up: a re-run should not push the backup
  // that holds someone's pre-cctap settings out of the five we keep.
  const rewrite = !read.existed || text !== read.raw;
  let backup = '';
  let written = settingsFile;
  if (rewrite) {
    if (changedSince(settingsFile, read.raw, read.existed)) {
      process.stderr.write(raceMessage(settingsFile));
      return 1;
    }
    // Resolved even when the file does not exist yet, because a dangling symlink is a
    // path that does not exist and is still a link a rename would destroy.
    const target = writeTarget(settingsFile);
    written = target;
    if (read.existed) {
      backup = writeBackup(target, new Date());
    } else {
      fs.mkdirSync(dirname(target), { recursive: true });
    }

    const mode = read.existed ? (fs.statSync(target).mode & 0o777) : FILE_MODE;
    writeFileAtomic(target, text);
    try {
      fs.chmodSync(target, mode);
    } catch {
      /* best effort */
    }
  }

  const record: InstallRecord = {
    version: VERSION,
    nodePath,
    forwarderPath: p.hookForward,
    settingsPath: settingsFile,
    installedAt: Date.now(),
  };
  writeFileAtomic(p.install, `${JSON.stringify(record, null, 2)}\n`);

  lines.push('');
  // The settings path is a symlink, so the write went to what it points at.
  if (written !== settingsFile) lines.push(`written:   ${written} (through the link)`);
  if (backup) {
    const pruned = pruneBackups(written);
    lines.push(`backup:    ${backup}`);
    if (pruned.length > 0) {
      lines.push(`           kept the ${KEEP_BACKUPS} newest, removed ${pruned.length} older:`);
      for (const f of pruned) lines.push(`           ${f}`);
    }
  }
  const count = `${countOurs(status.settings, p.hookForward)}/${REGISTRATIONS.length} hooks`;
  if (changed) {
    lines.push(`installed ${count}`);
    lines.push('Claude Code watches this file and picks the change up live, within seconds');
  } else {
    lines.push(`${count} in place, already up to date`);
  }
  lines.push('');
  const run = cctapInvocation();
  const pad = (cmd: string): string => cmd.padEnd(Math.max(15, run.length + 13));
  // The install has no step two, so the epilogue leads with what the user already has
  // rather than with something else to set up. The strip is the product; the number is
  // how you reach it. Every command here is the one that works on this machine.
  const strip = status.outcome !== 'foreign' && status.outcome !== 'skipped';
  if (strip) {
    lines.push('done. The strip now shows at the bottom of every Claude Code session:');
    lines.push('every session as a numbered glyph, red and in words when one needs you.');
    lines.push('(if a session does not show up, restart that one session)');
  } else {
    lines.push('done. Your own status line was left alone, so the strip has no home yet:');
    lines.push(`park one where you can see it with ${run} strip, or chain ours onto yours.`);
    lines.push('(if a session does not show up, restart that one session)');
  }
  lines.push('');
  // The key leads because it is the only path that is instant no matter what the session
  // is doing, and it is the one that keeps working from a full-screen app.
  lines.push(`  ${pad(`${run} keys setup`)}give the jump its key. The instant path, full screen included`);
  lines.push(`  ${pad(`${run} 2`)}jump to the session holding number 2, from any shell`);
  lines.push(`  ${pad(run)}jump to whatever needs you`);
  lines.push(`  ${pad('banners off')}by default. Turn them on with: ${run} notify on`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * K6: --purge deletes the keys journal along with the rest of the tree, and a binding
 * whose recorded way back is gone is a binding nobody can take back.
 */
export function purgeRefusal(count: number, dir: string): string {
  const many = count === 1 ? 'binding' : 'bindings';
  return [
    `cctap: the keys journal still holds ${count} ${many} that cctap set up, and --purge deletes`,
    `the journal along with the rest of ${dir}. Nothing was changed.`,
    '',
    '  take them back first:  cctap keys undo --all',
    '  then purge:            cctap uninstall-hooks --purge',
    '',
    'a tmux bind dies with its tmux server, so yours may be gone already. Undo is safe to run',
    'either way. It reads each binding back first and touches nothing that is not ours.',
    '',
    'to purge now and leave whatever is still bound:  cctap uninstall-hooks --purge --force',
    '',
  ].join('\n');
}

/** The guard reads the journal file itself, so a file it cannot read is not "empty". */
export function journalUnreadable(file: string, dir: string): string {
  return [
    `cctap: ${file} cannot be read as a keys journal, and --purge deletes it along with`,
    `the rest of ${dir}. Nothing was changed.`,
    '',
    'the journal is the only record of what cctap bound and how to take it back, so a',
    'journal nobody can read is exactly when a purge is worth stopping.',
    '',
    'take your bindings back by hand, or purge anyway with:  cctap uninstall-hooks --purge --force',
    '',
  ].join('\n');
}

type JournalState = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; count: number };

/**
 * Fail closed. The shared reader answers `undefined` for absent, unreadable and
 * unparseable alike, which let a corrupt journal disarm the purge guard silently, so
 * the guard reads the raw file for itself and tells the three apart.
 */
function journalState(p: Paths): JournalState {
  let raw: string;
  try {
    raw = fs.readFileSync(p.keys, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return { kind: 'unreadable' };
  return { kind: 'ok', count: readJournal(p).length };
}

export const UNINSTALL_FLAGS = ['--dry-run', '--purge', '--force'] as const;

export async function cmdUninstallHooks(args: string[]): Promise<number> {
  const bad = rejectUnknown(args, UNINSTALL_FLAGS, 'uninstall-hooks');
  if (bad) {
    process.stderr.write(bad);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  const purge = args.includes('--purge');
  const force = args.includes('--force');
  const p = paths();
  const settingsFile = claudeSettingsPath();

  if (purge && !force) {
    const journal = journalState(p);
    if (journal.kind === 'unreadable') {
      process.stderr.write(journalUnreadable(p.keys, p.dir));
      return 1;
    }
    if (journal.kind === 'ok' && journal.count > 0) {
      process.stderr.write(purgeRefusal(journal.count, p.dir));
      return 1;
    }
  }

  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(settingsFile);
  } catch (err) {
    process.stderr.write(cannotRead(settingsFile, err));
    return 1;
  }

  // Uninstall matches on what the install recorded, hooks and status line alike.
  const own = ownership(p);
  const { settings: withoutHooks, removed } = removeHooks(read.settings, own.forwarder);
  const status = removeStatusLine(withoutHooks, own.cliBin);
  const settings = status.settings;
  const kept = countForeign(read.settings, own.forwarder);
  const text = serializeChecked(settings);
  const lines: string[] = [`settings: ${settingsFile}${read.existed ? '' : ' (does not exist)'}`];
  for (const name of removed) lines.push(`  - ${name}`);
  if (removed.length === 0) lines.push('  (no cctap hooks found)');
  if (status.outcome === 'removed') lines.push('  - statusLine');
  if (status.outcome === 'kept') lines.push('  = statusLine that is not ours, left untouched');
  if (kept > 0) {
    lines.push(`  = ${kept} hook${kept === 1 ? ' that is' : 's that are'} not ours, left untouched`);
  }
  if (read.existed && removed.length === 0 && status.outcome !== 'removed') {
    lines.push('');
    lines.push(`nothing in this file belongs to the install at ${p.dir}`);
    lines.push('if you installed with a different CCTAP_DIR, run this again with that one set');
  }

  if (dryRun) {
    lines.push('');
    lines.push('dry run: nothing written');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // Nothing of ours in the file means nothing to write, and no backup either: six no-op
  // runs would otherwise rotate the genuine pre-install backup out of the five we keep.
  // A settings file that is not there is not a reason to leave the daemon running and
  // the tree on disk: the phases below are what the user asked for either way.
  const rewrite = read.existed && text !== read.raw;
  let backup = '';
  let written = settingsFile;
  if (rewrite) {
    if (changedSince(settingsFile, read.raw, read.existed)) {
      process.stderr.write(raceMessage(settingsFile));
      return 1;
    }
    written = writeTarget(settingsFile);
    backup = writeBackup(written, new Date());
    const mode = fs.statSync(written).mode & 0o777;
    writeFileAtomic(written, text);
    try {
      fs.chmodSync(written, mode);
    } catch {
      /* best effort */
    }
  }

  const stop = await stopDaemon(p);
  if (stop.outcome === 'unreadable') lines.push(`  ! ${p.daemonInfo} is unreadable, so no daemon was stopped`);
  // The install record is the ownership answer for the next run. Deleting it on a run
  // that removed nothing threw away the record that names the CCTAP_DIR the same output
  // just told the user to try.
  if (purge || removed.length > 0 || status.outcome === 'removed') {
    try {
      fs.unlinkSync(p.install);
    } catch {
      /* never installed */
    }
  }

  lines.push('');
  if (backup) {
    const pruned = pruneBackups(written);
    lines.push(`backup:    ${backup}`);
    if (pruned.length > 0) {
      lines.push(`           kept the ${KEEP_BACKUPS} newest, removed ${pruned.length} older:`);
      for (const f of pruned) lines.push(`           ${f}`);
    }
  }
  const alsoStatus = status.outcome === 'removed' ? ' and the status line' : '';
  const alsoDaemon = stop.outcome === 'stopped' ? ', stopped the daemon' : '';
  lines.push(`removed ${removed.length} hook${removed.length === 1 ? '' : 's'}${alsoStatus}${alsoDaemon}`);

  if (purge) {
    // A daemon still running would keep writing into a tree we are deleting.
    if (stop.outcome === 'stopped' && stop.pid !== undefined) await waitForExit(stop.pid);
    const survived = purgeTree(p);
    if (survived) {
      const left = leftovers(p.dir);
      lines.push(`kept:     ${p.dir}`);
      if (left.length > 0) {
        lines.push('          a purge removes the files cctap writes and leaves the rest, so');
        lines.push('          the directory stays as long as this is in it:');
        for (const name of left) lines.push(`            ${name}`);
        lines.push('          read that list before you remove any of it');
      } else {
        lines.push('          the directory itself could not be removed. Remove it by hand');
      }
    } else {
      lines.push(`purged:   ${p.dir}`);
    }
  } else {
    lines.push(`kept:     ${p.dir} (state, spool, bin). Remove it with --purge`);
  }
  lines.push('');
  lines.push('the strip is gone from the bottom of your sessions. Claude Code picks that up live,');
  lines.push('and any session still reporting in only needs a restart.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** How long a purge waits for a daemon to let go of the tree it is about to delete. */
const DAEMON_EXIT_WAIT_MS = 2000;
const DAEMON_EXIT_STEP_MS = 25;

async function waitForExit(pid: number, budgetMs = DAEMON_EXIT_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(DAEMON_EXIT_STEP_MS);
  }
}

/**
 * Never a recursive delete of the root. `CCTAP_DIR` is an unvalidated override, and
 * `rmSync(dir, {recursive, force})` on a wrong one deletes whatever lives there.
 * Only the children cctap creates are removed, then a plain rmdir, which fails on a
 * directory holding anything else. That failure is the point: it is what keeps a wrong
 * CCTAP_DIR intact.
 *
 * @returns true when the directory survived, because something foreign is in it.
 */
export function purgeTree(p: Paths): boolean {
  const files = [p.state, p.daemonInfo, p.lock, p.config, p.install, p.jump, p.keys, p.spool];
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* not there, or not ours to remove */
    }
  }
  // The socket is the one path in this list the user can point somewhere else, through
  // `socket` in config.json, and it is the documented remedy for a long CCTAP_DIR. So it
  // is removed only if a socket is what is actually there: a config naming a regular file
  // would otherwise have a purge delete that file, wherever on disk it sits.
  try {
    if (fs.lstatSync(p.sock).isSocket()) fs.unlinkSync(p.sock);
  } catch {
    /* not there, or not ours to remove */
  }
  // `simulate` leaves git repos here, dozens of files deep, and without this the rmdir
  // below could never succeed again. Recursive is safe at this one path for the reason it
  // is not at the root: cctap picks the name, under a CCTAP_DIR that is not a home or a
  // root, and wrote everything under it. lstat, so a symlink is left for the rmdir instead.
  try {
    if (fs.lstatSync(p.sim).isDirectory()) fs.rmSync(p.sim, { recursive: true });
  } catch {
    /* never simulated, or something else is sitting at that name */
  }
  // Only the names cctap writes. Sweeping every entry deleted the lot when CCTAP_DIR
  // named a directory someone already kept binaries in. What is left makes the rmdir
  // fail, and that failure is the guard.
  const dirs: [string, (name: string) => boolean][] = [
    [p.bin, isOurBinFile],
    [p.spoolDir, isOurSpoolFile],
  ];
  for (const [d, ours] of dirs) {
    try {
      for (const name of fs.readdirSync(d)) {
        if (!ours(name)) continue;
        try {
          fs.unlinkSync(join(d, name));
        } catch {
          /* a directory, or not ours to remove */
        }
      }
      fs.rmdirSync(d);
    } catch {
      /* not there, or something we did not write is in it */
    }
  }
  try {
    fs.rmdirSync(p.dir);
    return false;
  } catch {
    return true;
  }
}

/** How many surviving names a purge lists before it counts the rest. */
const LEFTOVERS_SHOWN = 10;

/**
 * What is still in the tree after a purge. Named, not characterized: a run that removes
 * only what it wrote cannot know whether the rest is the user's or one of ours it missed.
 */
function leftovers(dir: string): string[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return [];
  }
  if (names.length <= LEFTOVERS_SHOWN) return names;
  return [...names.slice(0, LEFTOVERS_SHOWN), `and ${names.length - LEFTOVERS_SHOWN} more`];
}

export type StopOutcome = 'stopped' | 'already-gone' | 'none' | 'unreadable';

export interface StopResult {
  outcome: StopOutcome;
  pid?: number;
}

/** `command` runs `script` as a whole argument, followed by `args` when given. */
function runsScript(command: string, script: string, args = ''): boolean {
  const want = args === '' ? script : `${script} ${args}`;
  for (let at = command.indexOf(want); at >= 0; at = command.indexOf(want, at + 1)) {
    const before = at === 0 ? ' ' : command[at - 1];
    const after = command[at + want.length] ?? ' ';
    if ((before === ' ' || before === '\t') && /\s/.test(after)) return true;
  }
  return false;
}

/**
 * A cctap daemon runs `daemon.mjs`, or `cctap.mjs daemon` in the foreground, from one of
 * the two places cctap launches it: the installed tree and the bundle this process runs
 * from. Matching the bare name accepted any other project's `daemon.mjs`, and the pid
 * this guards is suspect by definition, since it comes from a `daemon.json` that a
 * SIGKILLed daemon left behind and a live process has since inherited.
 */
export function looksLikeDaemon(command: string, p: Paths = paths()): boolean {
  const bundle = bundleDir();
  for (const script of [p.daemonBin, join(bundle, 'daemon.mjs')]) {
    if (runsScript(command, script)) return true;
  }
  for (const cli of [p.cliBin, join(bundle, 'cctap.mjs')]) {
    if (runsScript(command, cli, 'daemon')) return true;
  }
  return false;
}

/**
 * Shared by `cctap stop` and uninstall-hooks. The pid in daemon.json is only a claim:
 * a daemon killed with SIGKILL leaves the file behind, the number gets recycled, and
 * SIGTERM then lands on whatever inherited it. So the pid is checked against what it is
 * actually running before it is signalled.
 *
 * With `CCTAP_NO_EXEC` set nothing may be spawned, so the check cannot run. Refusing
 * there would leave no way to stop a daemon at all, so the signal goes out unverified:
 * the escape hatch stays open, and the mode that promises to spawn nothing keeps it.
 */
export async function stopDaemon(p: Paths, exec: Exec = realExec): Promise<StopResult> {
  let raw: string;
  try {
    raw = fs.readFileSync(p.daemonInfo, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'none' };
    return { outcome: 'unreadable' };
  }
  let info: { pid?: unknown } | null;
  try {
    info = JSON.parse(raw) as { pid?: unknown } | null;
  } catch {
    return { outcome: 'unreadable' };
  }
  const pid = info?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return { outcome: 'none' };

  if (!execBlocked()) {
    const res = await exec({ cmd: 'ps', args: ['-o', 'command=', '-p', String(pid)] }, { timeoutMs: 2000 });
    if (res.code !== 0 || !looksLikeDaemon(res.stdout, p)) {
      // Whatever holds that number now, it is not a cctap daemon. The file is the stale
      // half of the pair, so it goes, and nothing is signalled.
      try {
        fs.unlinkSync(p.daemonInfo);
      } catch {
        /* already gone */
      }
      return { outcome: 'already-gone', pid };
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
    return { outcome: 'stopped', pid };
  } catch {
    return { outcome: 'already-gone', pid };
  }
}

export async function cmdStop(): Promise<number> {
  const p = paths();
  const { outcome, pid } = await stopDaemon(p);
  if (outcome === 'unreadable') {
    process.stderr.write(
      [
        `cctap: cannot read ${p.daemonInfo}, so there is no pid to stop.`,
        '  a daemon may still be running. Remove that file and it will be rewritten by the next one.',
        '',
      ].join('\n'),
    );
    return 1;
  }
  if (outcome === 'stopped') process.stdout.write(`stopped the daemon (pid ${pid ?? '?'})\n`);
  else if (pid) process.stdout.write(`daemon pid ${pid} was already gone\n`);
  else process.stdout.write('no daemon running\n');
  return 0;
}

export function readInstallRecord(p: Paths = paths()): InstallRecord | undefined {
  return readJsonFile<InstallRecord>(p.install);
}
