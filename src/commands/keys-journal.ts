/**
 * The keys journal (CONTRACTS section 8): what `keys setup` bound, and the exact way back.
 * Every read-back goes through the exec seam, so status can be scripted in a test and
 * CCTAP_NO_EXEC never runs a thing.
 */

import * as fs from 'node:fs';
import type { Command, Exec, ExecResult } from '../exec.js';
import { DIR_MODE, paths, readJsonFile, repairDirMode, writeFileAtomic, type Paths } from '../paths.js';
import { findKeyBinding, tmuxListKeysCommand } from '../terminal/commands.js';

/** K1: bounded, so a machine that re-runs setup every day never grows a log file. */
export const JOURNAL_MAX = 50;

export type JournalKind = 'tmux-bind' | 'gnome-keybinding';

export interface JournalEntry {
  at: number;
  kind: JournalKind;
  key: string;
  /** What the binding runs. The read-back compares the live value against this. */
  command: string;
  /** The exact commands that reverse the write, in order. */
  undo: Command[];
  /** What was there before, when the write took an existing binding over. */
  previous?: string;
}

interface JournalFile {
  v: number;
  entries: JournalEntry[];
}

/** Where the GNOME binding lives. One path, so a re-run edits rather than accumulates. */
export const GNOME_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cctap/';
export const GNOME_LIST = 'org.gnome.settings-daemon.plugins.media-keys';
export const GNOME_ITEM = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${GNOME_PATH}`;

export function gnomeReadCommand(): Command {
  return { cmd: 'gsettings', args: ['get', GNOME_ITEM, 'command'] };
}

/** K7: restore the prior keybinding list rather than only dropping ours out of it. */
export function gnomeUndo(previousList: string): Command[] {
  return [
    { cmd: 'gsettings', args: ['reset-recursively', GNOME_ITEM] },
    { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', previousList] },
  ];
}

export function tmuxUndo(key: string): Command[] {
  return [{ cmd: 'tmux', args: ['unbind-key', key] }];
}

/** Argv has no quoting of its own, so printing it back needs some to stay pasteable. */
export function formatCommand(c: Command): string {
  return [c.cmd, ...c.args.map(quoteArg)].join(' ');
}

function quoteArg(a: string): string {
  if (a !== '' && !/[\s"'\\$`]/.test(a)) return a;
  return `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

function isEntry(x: unknown): x is JournalEntry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Partial<JournalEntry>;
  if (typeof e.at !== 'number' || typeof e.key !== 'string' || typeof e.command !== 'string') return false;
  if (e.kind !== 'tmux-bind' && e.kind !== 'gnome-keybinding') return false;
  if (!Array.isArray(e.undo)) return false;
  return e.undo.every((c) => c && typeof c.cmd === 'string' && Array.isArray(c.args));
}

export function readJournal(p: Paths = paths()): JournalEntry[] {
  const raw = readJsonFile<JournalFile>(p.keys);
  if (!raw || !Array.isArray(raw.entries)) return [];
  return raw.entries.filter(isEntry);
}

export function writeJournal(p: Paths, entries: JournalEntry[]): void {
  fs.mkdirSync(p.dir, { recursive: true, mode: DIR_MODE });
  repairDirMode(p.dir);
  const kept = entries.slice(-JOURNAL_MAX);
  writeFileAtomic(p.keys, `${JSON.stringify({ v: 1, entries: kept }, null, 2)}\n`);
}

export function appendJournal(p: Paths, entry: JournalEntry): JournalEntry[] {
  const next = [...readJournal(p), entry].slice(-JOURNAL_MAX);
  writeJournal(p, next);
  return next;
}

export type LiveState = 'active' | 'gone' | 'changed' | 'unknown';

export interface JournalStatus {
  entry: JournalEntry;
  state: LiveState;
  /** What the mechanism answers right now, when it answers at all. */
  found?: string;
}

/** list-keys echoes a bound command with its quotes escaped. */
function deEscape(line: string): string {
  return line.replace(/\\(["\\])/g, '$1');
}

/** gsettings prints a string as a GVariant: single quoted, backslash escapes inside. */
export function gvariantString(out: string): string {
  const t = out.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return t;
}

export async function readBack(entry: JournalEntry, exec: Exec): Promise<JournalStatus> {
  if (entry.kind === 'tmux-bind') {
    const scan = await exec(tmuxListKeysCommand());
    // No server means no bind: the runtime bind dies with the server it lived in.
    if (scan.code !== 0) return { entry, state: 'gone' };
    const line = findKeyBinding(scan.stdout, entry.key);
    if (line === undefined) return { entry, state: 'gone' };
    const plain = deEscape(line);
    return plain.includes(entry.command)
      ? { entry, state: 'active', found: plain }
      : { entry, state: 'changed', found: plain };
  }
  const got = await exec(gnomeReadCommand());
  if (got.code !== 0) return { entry, state: 'gone' };
  const value = gvariantString(got.stdout);
  if (value === '') return { entry, state: 'gone' };
  return value === entry.command ? { entry, state: 'active', found: value } : { entry, state: 'changed', found: value };
}

/**
 * One read per mechanism, so fifty journaled tmux binds are one `list-keys`, and every
 * entry is classified against the same point in time.
 */
export async function statusAll(entries: JournalEntry[], exec: Exec): Promise<JournalStatus[]> {
  const memo = new Map<string, ExecResult>();
  const once: Exec = async (c) => {
    const key = [c.cmd, ...c.args].join('\u0000');
    const hit = memo.get(key);
    if (hit) return hit;
    const res = await exec(c);
    memo.set(key, res);
    return res;
  };
  const out: JournalStatus[] = [];
  for (const entry of entries) out.push(await readBack(entry, once));
  return out;
}

const PAD = 8;

function entryBlock(s: JournalStatus): string[] {
  const gap = ' '.repeat(2 + PAD + 1);
  const lines = [`  ${s.state.padEnd(PAD)} ${s.entry.kind} on ${s.entry.key}`];
  if (s.state === 'gone') {
    lines.push(`${gap}was   ${s.entry.command}`);
    lines.push(
      s.entry.kind === 'tmux-bind'
        ? `${gap}nothing is bound there now. A tmux bind dies with its tmux server`
        : `${gap}nothing is bound there now, so there is nothing to take back`,
    );
    return lines;
  }
  if (s.state === 'changed') {
    lines.push(`${gap}runs  ${s.found ?? '(unknown)'}`);
    lines.push(`${gap}ours  ${s.entry.command}`);
    lines.push(`${gap}cctap keys undo leaves this one alone, because it is not ours any more`);
    return lines;
  }
  lines.push(`${gap}runs  ${s.entry.command}`);
  for (const c of s.entry.undo) lines.push(`${gap}undo  ${formatCommand(c)}`);
  if (s.entry.previous !== undefined) lines.push(`${gap}was   ${s.entry.previous}`);
  return lines;
}

export function renderStatus(o: { statuses: JournalStatus[]; file: string; blocked: boolean }): string[] {
  if (o.statuses.length === 0) {
    return [
      'nothing journaled. cctap keys setup writes down every key it binds, so cctap keys undo',
      'can take it back. The journal would live at:',
      `  ${o.file}`,
    ];
  }
  const n = o.statuses.length;
  const lines: string[] = [];
  if (o.blocked) {
    lines.push('CCTAP_NO_EXEC is set, so the live state cannot be read back. This is the journal itself:');
  } else {
    lines.push(`${n} binding${n === 1 ? '' : 's'} journaled in ${o.file}, newest first, read back live:`);
  }
  lines.push('');
  // Newest first, the order undo walks, so the top block is the one undo takes back.
  for (const s of [...o.statuses].reverse()) lines.push(...entryBlock(s));
  lines.push('');
  lines.push('cctap keys undo takes the newest active one back, cctap keys undo --all takes back every one.');
  return lines;
}

export interface UndoResult {
  lines: string[];
  code: number;
  /** What the journal should hold afterwards. */
  remaining: JournalEntry[];
}

function leftInJournal(n: number): string {
  if (n === 0) return 'The journal is empty now.';
  return `${n} binding${n === 1 ? '' : 's'} left in the journal.`;
}

/**
 * K4: newest first, and a binding that is no longer ours is never touched. Undoing
 * someone else's newer binding is the exact harm the journal exists to prevent.
 */
export async function runUndo(o: {
  entries: JournalEntry[];
  exec: Exec;
  blocked: boolean;
  all: boolean;
}): Promise<UndoResult> {
  const newestFirst = [...o.entries].reverse();
  if (newestFirst.length === 0) {
    return { lines: ['nothing to undo: the keys journal is empty.'], code: 0, remaining: o.entries };
  }

  if (o.blocked) {
    const targets = o.all ? newestFirst : newestFirst.slice(0, 1);
    const lines = [
      'CCTAP_NO_EXEC is set, so nothing was run and nothing was taken back.',
      '',
      `this is what cctap keys undo${o.all ? ' --all' : ''} would run:`,
    ];
    for (const e of targets) for (const c of e.undo) lines.push(`  ${formatCommand(c)}`);
    return { lines, code: 0, remaining: o.entries };
  }

  const statuses = await statusAll(newestFirst, o.exec);
  if (!o.all) {
    const target = statuses.find((s) => s.state === 'active');
    if (!target) {
      const gone = statuses.filter((s) => s.state === 'gone').length;
      const changed = statuses.filter((s) => s.state === 'changed').length;
      return {
        lines: [
          'nothing to undo: no journaled binding is still ours and still bound.',
          `  ${gone} already gone, ${changed} bound to something that is not ours.`,
          'cctap keys status has the detail, cctap keys undo --all clears the gone ones.',
        ],
        code: 0,
        remaining: o.entries,
      };
    }
    const lines = ['undoing the newest active journaled binding:', ''];
    const run = await undoOne(target, o.exec, lines);
    const remaining = run.ok ? o.entries.filter((e) => e !== target.entry) : o.entries;
    lines.push('');
    lines.push(run.ok ? `done. ${leftInJournal(remaining.length)}` : `nothing was taken back. ${leftInJournal(remaining.length)}`);
    return { lines, code: run.ok ? 0 : 1, remaining };
  }

  const lines = [`taking back ${statuses.length} journaled binding${statuses.length === 1 ? '' : 's'}, newest first:`, ''];
  const drop = new Set<JournalEntry>();
  let undone = 0;
  let alone = 0;
  let cleared = 0;
  let failed = 0;
  for (const s of statuses) {
    if (s.state === 'changed') {
      lines.push(`  ${s.entry.kind} on ${s.entry.key}`);
      lines.push('    left alone, something that is not ours is bound there now');
      alone += 1;
      continue;
    }
    if (s.state === 'gone') {
      lines.push(`  ${s.entry.kind} on ${s.entry.key}`);
      lines.push('    already gone, nothing to run. Cleared from the journal');
      drop.add(s.entry);
      cleared += 1;
      continue;
    }
    const run = await undoOne(s, o.exec, lines);
    if (run.ok) {
      drop.add(s.entry);
      undone += 1;
    } else {
      failed += 1;
    }
  }
  const parts = [`undid ${undone}`];
  if (alone > 0) parts.push(`left ${alone} alone`);
  if (cleared > 0) parts.push(`cleared ${cleared} that ${cleared === 1 ? 'was' : 'were'} already gone`);
  if (failed > 0) parts.push(`${failed} refused`);
  const remaining = o.entries.filter((e) => !drop.has(e));
  lines.push('');
  lines.push(`${parts.join(', ')}. ${leftInJournal(remaining.length)}`);
  return { lines, code: failed > 0 ? 1 : 0, remaining };
}

/** Runs one entry's undo commands and prints them exactly as they were run. */
async function undoOne(s: JournalStatus, exec: Exec, lines: string[]): Promise<{ ok: boolean }> {
  lines.push(`  ${s.entry.kind} on ${s.entry.key}`);
  for (const c of s.entry.undo) {
    lines.push(`    ${formatCommand(c)}`);
    const res = await exec(c);
    if (res.code !== 0) {
      lines.push(`    refused: ${res.stderr.trim() || `exit ${res.code}`}. The entry stays in the journal`);
      return { ok: false };
    }
  }
  return { ok: true };
}
