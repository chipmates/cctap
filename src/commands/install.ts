/**
 * `cctap install-hooks` / `uninstall-hooks`. All twelve install safety rules:
 * backup, deep merge, precise signature, JSON round-trip, atomic write, diff summary,
 * dry run, CCTAP_CLAUDE_SETTINGS override, the live-pickup note, one ownership answer,
 * and the status line, which is written only when the user has none of their own.
 */

import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bundleDir } from '../client.js';
import {
  cctapInvocation,
  claudeSettingsPath,
  ensureDirs,
  FILE_MODE,
  paths,
  readJsonFile,
  writeFileAtomic,
  type Paths,
} from '../paths.js';
import { readJournal } from './keys-journal.js';
import { countForeign, countOurs, mergeHooks, removeHooks, REGISTRATIONS, type Settings } from '../install/hooks.js';
import { mergeStatusLine, removeStatusLine } from '../install/statusline.js';
import { VERSION } from '../version.js';

const BIN_FILES = ['hook-forward.mjs', 'daemon.mjs', 'cctap.mjs'] as const;

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

function backupPath(file: string, now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${file}.cctap-bak-${ts}`;
}

/** Copies the bundled zero-dep scripts to the stable paths hooks point at. */
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
      fs.copyFileSync(from, to);
      fs.chmodSync(to, FILE_MODE);
    }
    copied.push(name);
  }
  return { copied, missing };
}

export async function cmdInstallHooks(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const noStatusLine = args.includes('--no-status-line');
  const p = paths();
  const settingsFile = claudeSettingsPath();
  const nodePath = process.execPath;

  if (!dryRun) ensureDirs(p);
  const bins = copyBinaries(p, dryRun);
  if (bins.missing.length > 0) {
    process.stderr.write(`cctap: missing bundled files: ${bins.missing.join(', ')}\n`);
    if (bins.missing.includes('hook-forward.mjs')) return 1;
  }

  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(settingsFile);
  } catch (err) {
    process.stderr.write(cannotRead(settingsFile, err));
    return 1;
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
  lines.push('legend:    + added   ~ updated   = already correct');
  lines.push('');
  for (const name of merged.added) lines.push(`  + ${name}`);
  for (const name of merged.replaced) lines.push(`  ~ ${name} (updated)`);
  for (const name of merged.unchanged) lines.push(`  = ${name}`);
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
    lines.push('no status line was written. The README section "In Claude Code\'s own status');
    lines.push('line" has the one-line JSON, if you want to add it by hand later.');
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
  if (rewrite) {
    if (read.existed) {
      backup = backupPath(settingsFile, new Date());
      fs.copyFileSync(settingsFile, backup);
    } else {
      fs.mkdirSync(dirname(settingsFile), { recursive: true });
    }

    const mode = read.existed ? (fs.statSync(settingsFile).mode & 0o777) : FILE_MODE;
    writeFileAtomic(settingsFile, text);
    try {
      fs.chmodSync(settingsFile, mode);
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
  if (backup) {
    const pruned = pruneBackups(settingsFile);
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

export async function cmdUninstallHooks(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const purge = args.includes('--purge');
  const force = args.includes('--force');
  const p = paths();
  const settingsFile = claudeSettingsPath();

  if (purge && !force) {
    const journaled = readJournal(p);
    if (journaled.length > 0) {
      process.stderr.write(purgeRefusal(journaled.length, p.dir));
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
  if (!read.existed) {
    process.stdout.write(`nothing to remove: ${settingsFile} does not exist\n`);
    return 0;
  }

  // Uninstall matches on what the install recorded, hooks and status line alike.
  const own = ownership(p);
  const { settings: withoutHooks, removed } = removeHooks(read.settings, own.forwarder);
  const status = removeStatusLine(withoutHooks, own.cliBin);
  const settings = status.settings;
  const kept = countForeign(read.settings, own.forwarder);
  const text = serializeChecked(settings);
  const lines: string[] = [`settings: ${settingsFile}`];
  for (const name of removed) lines.push(`  - ${name}`);
  if (removed.length === 0) lines.push('  (no cctap hooks found)');
  if (status.outcome === 'removed') lines.push('  - statusLine');
  if (status.outcome === 'kept') lines.push('  = statusLine that is not ours, left untouched');
  if (kept > 0) {
    lines.push(`  = ${kept} hook${kept === 1 ? ' that is' : 's that are'} not ours, left untouched`);
  }
  if (removed.length === 0 && status.outcome !== 'removed') {
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
  const rewrite = text !== read.raw;
  let backup = '';
  if (rewrite) {
    backup = backupPath(settingsFile, new Date());
    fs.copyFileSync(settingsFile, backup);
    const mode = fs.statSync(settingsFile).mode & 0o777;
    writeFileAtomic(settingsFile, text);
    try {
      fs.chmodSync(settingsFile, mode);
    } catch {
      /* best effort */
    }
  }

  stopDaemon(p);
  try {
    fs.unlinkSync(p.install);
  } catch {
    /* never installed */
  }

  lines.push('');
  if (backup) {
    const pruned = pruneBackups(settingsFile);
    lines.push(`backup:    ${backup}`);
    if (pruned.length > 0) {
      lines.push(`           kept the ${KEEP_BACKUPS} newest, removed ${pruned.length} older:`);
      for (const f of pruned) lines.push(`           ${f}`);
    }
  }
  const alsoStatus = status.outcome === 'removed' ? ' and the status line' : '';
  lines.push(`removed ${removed.length} hook${removed.length === 1 ? '' : 's'}${alsoStatus}, stopped the daemon`);

  if (purge) {
    fs.rmSync(p.dir, { recursive: true, force: true });
    lines.push(`purged:   ${p.dir}`);
  } else {
    lines.push(`kept:     ${p.dir} (state, spool, bin). Remove it with --purge`);
  }
  lines.push('');
  lines.push('the strip is gone from the bottom of your sessions. Claude Code picks that up live,');
  lines.push('and any session still reporting in only needs a restart.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** Shared by `cctap stop` and uninstall-hooks. */
export function stopDaemon(p: Paths): { stopped: boolean; pid?: number } {
  const info = readJsonFile<{ pid?: number }>(p.daemonInfo);
  if (!info?.pid) return { stopped: false };
  try {
    process.kill(info.pid, 'SIGTERM');
    return { stopped: true, pid: info.pid };
  } catch {
    return { stopped: false, pid: info.pid };
  }
}

export async function cmdStop(): Promise<number> {
  const p = paths();
  const { stopped, pid } = stopDaemon(p);
  if (stopped) process.stdout.write(`stopped the daemon (pid ${pid ?? '?'})\n`);
  else if (pid) process.stdout.write(`daemon pid ${pid} was already gone\n`);
  else process.stdout.write('no daemon running\n');
  return 0;
}

export function readInstallRecord(p: Paths = paths()): InstallRecord | undefined {
  return readJsonFile<InstallRecord>(p.install);
}
