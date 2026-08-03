/**
 * The keys journal, spec/CONTRACTS.md section 8. Every mechanism read and every undo
 * goes through a scripted exec, so no test ever binds a tmux key or writes a gsetting.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { recordingExec, type Command, type ExecResult } from '../src/exec.js';
import { paths, type Paths } from '../src/paths.js';
import {
  appendJournal,
  formatCommand,
  GNOME_ITEM,
  GNOME_LIST,
  gvariantString,
  JOURNAL_MAX,
  readJournal,
  renderStatus,
  runUndo,
  statusAll,
  writeJournal,
  type JournalEntry,
} from '../src/commands/keys-journal.js';
import { keysJournalCheck, secureKeyboardEntryCheck, secureKeyboardEntryCommand } from '../src/commands/doctor.js';
import { runKeysSetup } from '../src/commands/keys-setup.js';
import { distDir, runNode, tempDir, tempEnv, type TempEnv } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const CLI = join(distDir(), 'cctap.mjs');

const JUMP = '"/abs/node" "/h/.cctap/bin/cctap.mjs" jump';
const RUN = `${JUMP} >/dev/null 2>&1`;
const ESCAPED = RUN.replace(/"/g, '\\"');
const FREE = 'bind-key    -T prefix c                 new-window\n';
const OURS = `${FREE}bind-key    -T prefix g                 run-shell -b "${ESCAPED}"\n`;
const THEIRS = `${FREE}bind-key    -T prefix g                 display-message "mine"\n`;

function tmuxEntry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    at: 1000,
    kind: 'tmux-bind',
    key: 'g',
    command: RUN,
    undo: [{ cmd: 'tmux', args: ['unbind-key', 'g'] }],
    ...over,
  };
}

function gnomeEntry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    at: 2000,
    kind: 'gnome-keybinding',
    key: '<Super>j',
    command: JUMP,
    undo: [
      { cmd: 'gsettings', args: ['reset-recursively', GNOME_ITEM] },
      { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', "['/other/']"] },
    ],
    previous: "['/other/']",
    ...over,
  };
}

interface ScriptOpts {
  keys?: string;
  keysCode?: number;
  gnome?: string;
  gnomeCode?: number;
  undoCode?: number;
}

/** tmux answers list-keys, gsettings answers get, everything else is an undo write. */
function script(o: ScriptOpts = {}) {
  return (c: Command): ExecResult => {
    if (c.cmd === 'tmux' && c.args[0] === 'list-keys') {
      return { code: o.keysCode ?? 0, stdout: o.keys ?? '', stderr: o.keysCode ? 'no server running' : '' };
    }
    if (c.cmd === 'gsettings' && c.args[0] === 'get') {
      return { code: o.gnomeCode ?? 0, stdout: o.gnome ?? '', stderr: o.gnomeCode ? 'No such key' : '' };
    }
    const code = o.undoCode ?? 0;
    return { code, stdout: '', stderr: code === 0 ? '' : 'refused it' };
  };
}

const dirs: string[] = [];
const envs: TempEnv[] = [];

function tempPaths(): Paths {
  const dir = tempDir('cctap-kj-');
  dirs.push(dir);
  return paths({ CCTAP_DIR: dir });
}

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const e of envs) e.cleanup();
});

describe('the keys journal on disk (K1)', () => {
  it('round-trips an entry with every field intact, at 0600', () => {
    const p = tempPaths();
    assert.deepEqual(readJournal(p), [], 'an absent file is an empty journal, not an error');

    const entry = gnomeEntry();
    appendJournal(p, entry);
    assert.deepEqual(readJournal(p), [entry]);
    assert.equal(fs.statSync(p.keys).mode & 0o777, 0o600);
    assert.equal(p.keys.endsWith('keys.json'), true);

    const second = tmuxEntry({ at: 3000, previous: 'bind-key -T prefix g display-message "mine"' });
    appendJournal(p, second);
    assert.deepEqual(readJournal(p), [entry, second], 'oldest first, newest appended');

    // Written as JSON someone can read and hand-edit, not as an opaque blob.
    const raw = JSON.parse(fs.readFileSync(p.keys, 'utf8')) as { v: number; entries: JournalEntry[] };
    assert.equal(raw.v, 1);
    assert.equal(raw.entries.length, 2);
    assert.deepEqual(raw.entries[1]?.undo, [{ cmd: 'tmux', args: ['unbind-key', 'g'] }]);
  });

  it('keeps the last 50 and drops the oldest', () => {
    const p = tempPaths();
    for (let i = 0; i < JOURNAL_MAX + 12; i++) appendJournal(p, tmuxEntry({ at: i, key: `k${i}` }));
    const kept = readJournal(p);
    assert.equal(kept.length, JOURNAL_MAX);
    assert.equal(kept[0]?.key, 'k12', 'the twelve oldest went');
    assert.equal(kept[JOURNAL_MAX - 1]?.key, `k${JOURNAL_MAX + 11}`);
  });

  it('truncates a journal written over the cap in one write', () => {
    const p = tempPaths();
    writeJournal(
      p,
      Array.from({ length: 70 }, (_, i) => tmuxEntry({ at: i, key: `k${i}` })),
    );
    const kept = readJournal(p);
    assert.equal(kept.length, JOURNAL_MAX);
    assert.equal(kept[0]?.key, 'k20');
  });

  it('drops garbage rather than trusting a hand-edited file', () => {
    const p = tempPaths();
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.keys, JSON.stringify({ v: 1, entries: [{ nope: true }, tmuxEntry(), 7, null] }));
    assert.deepEqual(readJournal(p), [tmuxEntry()]);
    fs.writeFileSync(p.keys, 'not json at all');
    assert.deepEqual(readJournal(p), []);
  });
});

describe('keys setup writes the journal entry it earned', () => {
  const base = {
    blocked: false,
    now: 4242,
    jumpLine: JUMP,
    slotLines: [1].map((slot) => ({ slot, line: `${JUMP} ${slot}` })),
  };

  it('journals the tmux bind, with the undo that reverses it (K2)', async () => {
    const exec = recordingExec((c) => (c.args[0] === 'list-keys' ? { code: 0, stdout: FREE, stderr: '' } : { code: 0, stdout: '', stderr: '' }));
    const r = await runKeysSetup({ ...base, platform: 'darwin', env: { TMUX: 'x' }, exec });
    assert.deepEqual(r.journal, [
      { at: 4242, kind: 'tmux-bind', key: 'g', command: RUN, undo: [{ cmd: 'tmux', args: ['unbind-key', 'g'] }] },
    ]);
    assert.match(r.lines.join('\n'), /cctap keys undo/, 'and the output says the command exists');
  });

  it('records the binding it replaced when the key was taken over', async () => {
    const exec = recordingExec((c) => (c.args[0] === 'list-keys' ? { code: 0, stdout: THEIRS, stderr: '' } : { code: 0, stdout: '', stderr: '' }));
    const r = await runKeysSetup({ ...base, platform: 'darwin', env: { TMUX: 'x' }, exec, key: 'g' });
    assert.equal(r.journal?.[0]?.previous, 'bind-key    -T prefix g                 display-message "mine"');
  });

  it('journals nothing when it refused to overwrite someone else\'s key', async () => {
    const exec = recordingExec((c) => (c.args[0] === 'list-keys' ? { code: 0, stdout: THEIRS, stderr: '' } : { code: 0, stdout: '', stderr: '' }));
    const r = await runKeysSetup({ ...base, platform: 'darwin', env: { TMUX: 'x' }, exec });
    assert.equal(r.journal, undefined, 'nothing was written, so nothing is journaled');
  });

  it('journals nothing when tmux refused the bind', async () => {
    const exec = recordingExec((c) =>
      c.args[0] === 'list-keys' ? { code: 0, stdout: FREE, stderr: '' } : { code: 1, stdout: '', stderr: 'no server running' },
    );
    const r = await runKeysSetup({ ...base, platform: 'darwin', env: { TMUX: 'x' }, exec });
    assert.equal(r.journal, undefined);
  });

  it('journals the GNOME write with the prior list as previous (K7)', async () => {
    // Two reads now: the list before the write, and the W3 read-back after it.
    const exec = recordingExec((c) => {
      if (c.args[0] !== 'get') return { code: 0, stdout: '', stderr: '' };
      const out = c.args[2] === 'custom-keybindings' ? "['/other/']" : `'${JUMP}'`;
      return { code: 0, stdout: `${out}\n`, stderr: '' };
    });
    const r = await runKeysSetup({ ...base, platform: 'linux', exec });
    assert.equal(r.code, 0, 'the read-back matched, so this is a success');
    assert.deepEqual(r.journal, [
      {
        at: 4242,
        kind: 'gnome-keybinding',
        key: '<Super>j',
        command: JUMP,
        undo: [
          { cmd: 'gsettings', args: ['reset-recursively', GNOME_ITEM] },
          { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', "['/other/']"] },
        ],
        previous: "['/other/']",
      },
    ]);
  });

  it('journals nothing on macOS, because nothing was written', async () => {
    const exec = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const r = await runKeysSetup({ ...base, platform: 'darwin', exec });
    assert.equal(r.journal, undefined, 'the clipboard and Shortcuts are not a write');
  });
});

describe('cctap keys status classifies against the live mechanism (K3)', () => {
  it('reads a tmux bind back as active, changed or gone', async () => {
    const active = await statusAll([tmuxEntry()], recordingExec(script({ keys: OURS })));
    assert.equal(active[0]?.state, 'active');

    const changed = await statusAll([tmuxEntry()], recordingExec(script({ keys: THEIRS })));
    assert.equal(changed[0]?.state, 'changed');
    assert.equal(changed[0]?.found?.includes('display-message "mine"'), true);

    const unbound = await statusAll([tmuxEntry()], recordingExec(script({ keys: FREE })));
    assert.equal(unbound[0]?.state, 'gone');

    // No tmux server at all: the runtime bind died with it.
    const noServer = await statusAll([tmuxEntry()], recordingExec(script({ keysCode: 1 })));
    assert.equal(noServer[0]?.state, 'gone');
  });

  it('reads a GNOME keybinding back the same three ways', async () => {
    const active = await statusAll([gnomeEntry()], recordingExec(script({ gnome: `'${JUMP}'\n` })));
    assert.equal(active[0]?.state, 'active');

    const changed = await statusAll([gnomeEntry()], recordingExec(script({ gnome: "'/usr/bin/other'\n" })));
    assert.equal(changed[0]?.state, 'changed');
    assert.equal(changed[0]?.found, '/usr/bin/other');

    const empty = await statusAll([gnomeEntry()], recordingExec(script({ gnome: "''\n" })));
    assert.equal(empty[0]?.state, 'gone');

    const noSchema = await statusAll([gnomeEntry()], recordingExec(script({ gnomeCode: 2 })));
    assert.equal(noSchema[0]?.state, 'gone');
  });

  it('asks each mechanism once, however many entries name it', async () => {
    const exec = recordingExec(script({ keys: OURS, gnome: `'${JUMP}'\n` }));
    const out = await statusAll([tmuxEntry(), tmuxEntry({ key: 'h' }), gnomeEntry()], exec);
    assert.equal(out.length, 3);
    assert.equal(exec.calls.filter((c) => c.args[0] === 'list-keys').length, 1);
    assert.equal(exec.calls.filter((c) => c.args[0] === 'get').length, 1);
    assert.equal(out[1]?.state, 'gone', 'the second key is not in the same table');
  });

  it('unquotes a gsettings string, escapes and all', () => {
    assert.equal(gvariantString("'/usr/bin/x'\n"), '/usr/bin/x');
    assert.equal(gvariantString("'it\\'s'"), "it's");
    assert.equal(gvariantString("''"), '');
    assert.equal(gvariantString('@as []'), '@as []');
  });

  it('prints one block per binding, with the undo spelled out', () => {
    const statuses = [
      { entry: tmuxEntry(), state: 'active' as const },
      { entry: gnomeEntry(), state: 'changed' as const, found: '/usr/bin/other' },
      { entry: tmuxEntry({ key: 'h' }), state: 'gone' as const },
    ];
    const text = renderStatus({ statuses, file: '/h/.cctap/keys.json', blocked: false }).join('\n');
    assert.match(text, /^3 bindings journaled in \/h\/\.cctap\/keys\.json, newest first, read back live:$/m);
    assert.ok(text.indexOf('tmux-bind on h') < text.indexOf('tmux-bind on g'), 'newest first, like undo');
    assert.match(text, /^ {2}active {3}tmux-bind on g$/m);
    assert.match(text, /^ {11}undo {2}tmux unbind-key g$/m);
    assert.match(text, /^ {2}changed {2}gnome-keybinding on <Super>j$/m);
    assert.match(text, /^ {11}runs {2}\/usr\/bin\/other$/m);
    assert.match(text, /leaves this one alone, because it is not ours any more/);
    assert.match(text, /^ {2}gone {5}tmux-bind on h$/m);
    assert.match(text, /A tmux bind dies with its tmux server/);
    assert.match(text, /cctap keys undo --all takes back every one/);
  });

  it('says the journal is empty rather than printing a header over nothing', () => {
    const text = renderStatus({ statuses: [], file: '/h/.cctap/keys.json', blocked: false }).join('\n');
    assert.match(text, /nothing journaled/);
    assert.match(text, /\/h\/\.cctap\/keys\.json/);
  });

  it('says it cannot read back under CCTAP_NO_EXEC, and shows the journal anyway', () => {
    const text = renderStatus({
      statuses: [{ entry: tmuxEntry(), state: 'unknown' }],
      file: '/h/.cctap/keys.json',
      blocked: true,
    }).join('\n');
    assert.match(text, /CCTAP_NO_EXEC is set, so the live state cannot be read back/);
    assert.match(text, /^ {2}unknown {2}tmux-bind on g$/m);
    assert.match(text, /undo {2}tmux unbind-key g/);
  });
});

describe('cctap keys undo runs exactly the journaled argv (K4)', () => {
  it('unbinds the tmux key and drops the entry', async () => {
    const exec = recordingExec(script({ keys: OURS }));
    const r = await runUndo({ entries: [gnomeEntry(), tmuxEntry()], exec, blocked: false, all: false });
    assert.equal(r.code, 0);
    assert.deepEqual(
      exec.calls.filter((c) => c.args[0] !== 'list-keys' && c.args[0] !== 'get'),
      [{ cmd: 'tmux', args: ['unbind-key', 'g'] }],
      'exactly one write, and it is the journaled one',
    );
    assert.deepEqual(r.remaining, [gnomeEntry()], 'the newest active entry left the journal');
    const text = r.lines.join('\n');
    assert.match(text, /undoing the newest active journaled binding:/);
    assert.match(text, /^ {2}tmux-bind on g$/m);
    assert.match(text, /^ {4}tmux unbind-key g$/m);
    assert.match(text, /done\. 1 binding left in the journal\./);
  });

  it('runs both GNOME resets in order, restoring the prior list (K7)', async () => {
    const exec = recordingExec(script({ gnome: `'${JUMP}'\n` }));
    const r = await runUndo({ entries: [gnomeEntry()], exec, blocked: false, all: false });
    assert.deepEqual(
      exec.calls.filter((c) => c.args[0] !== 'get'),
      [
        { cmd: 'gsettings', args: ['reset-recursively', GNOME_ITEM] },
        { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', "['/other/']"] },
      ],
    );
    assert.deepEqual(r.remaining, []);
    const text = r.lines.join('\n');
    assert.match(text, /gsettings reset-recursively/);
    assert.ok(text.includes(`"['/other/']"`), 'the list is quoted so the line stays pasteable');
    assert.match(text, /The journal is empty now\./);
  });

  it('never touches a binding that is not ours any more', async () => {
    const exec = recordingExec(script({ keys: THEIRS }));
    const r = await runUndo({ entries: [tmuxEntry()], exec, blocked: false, all: false });
    assert.deepEqual(
      exec.calls.filter((c) => c.args[0] !== 'list-keys'),
      [],
      'nothing was run against someone else\'s binding',
    );
    assert.deepEqual(r.remaining, [tmuxEntry()], 'and the entry stays, so status keeps reporting it');
    assert.match(r.lines.join('\n'), /nothing to undo: no journaled binding is still ours and still bound/);
    assert.match(r.lines.join('\n'), /0 already gone, 1 bound to something that is not ours/);
  });

  it('--all walks newest first, leaves changed alone and clears what is gone', async () => {
    const exec = recordingExec(script({ keys: THEIRS, gnome: `'${JUMP}'\n` }));
    const gone = tmuxEntry({ at: 1, key: 'h' });
    const changed = tmuxEntry({ at: 2 });
    const active = gnomeEntry({ at: 3 });
    const r = await runUndo({ entries: [gone, changed, active], exec, blocked: false, all: true });
    assert.equal(r.code, 0);
    assert.deepEqual(
      exec.calls.filter((c) => c.args[0] !== 'list-keys' && c.args[0] !== 'get'),
      [
        { cmd: 'gsettings', args: ['reset-recursively', GNOME_ITEM] },
        { cmd: 'gsettings', args: ['set', GNOME_LIST, 'custom-keybindings', "['/other/']"] },
      ],
      'the changed tmux key was never unbound',
    );
    assert.deepEqual(r.remaining, [changed], 'only the one that is no longer ours stays behind');
    const text = r.lines.join('\n');
    assert.match(text, /taking back 3 journaled bindings, newest first:/);
    assert.match(text, /left alone, something that is not ours is bound there now/);
    assert.match(text, /already gone, nothing to run\. Cleared from the journal/);
    assert.match(text, /^undid 1, left 1 alone, cleared 1 that was already gone\. 1 binding left in the journal\.$/m);
    const order = text.indexOf('gnome-keybinding on <Super>j');
    assert.ok(order > 0 && order < text.indexOf('tmux-bind on h'), 'newest first');
  });

  it('keeps an entry whose undo the mechanism refused', async () => {
    const exec = recordingExec(script({ keys: OURS, undoCode: 1 }));
    const r = await runUndo({ entries: [tmuxEntry()], exec, blocked: false, all: false });
    assert.equal(r.code, 1);
    assert.deepEqual(r.remaining, [tmuxEntry()]);
    assert.match(r.lines.join('\n'), /refused: refused it\. The entry stays in the journal/);
  });

  it('refuses under CCTAP_NO_EXEC and prints what it would have run', async () => {
    const exec = recordingExec(script());
    const r = await runUndo({ entries: [tmuxEntry(), gnomeEntry()], exec, blocked: true, all: true });
    assert.deepEqual(exec.calls, [], 'not even a read-back');
    assert.equal(r.code, 0);
    assert.deepEqual(r.remaining, [tmuxEntry(), gnomeEntry()]);
    const text = r.lines.join('\n');
    assert.match(text, /CCTAP_NO_EXEC is set, so nothing was run and nothing was taken back/);
    assert.match(text, /this is what cctap keys undo --all would run:/);
    assert.match(text, /^ {2}tmux unbind-key g$/m);
    assert.match(text, /^ {2}gsettings reset-recursively /m);
  });

  it('says so on an empty journal, and runs nothing', async () => {
    const exec = recordingExec(script());
    const r = await runUndo({ entries: [], exec, blocked: false, all: true });
    assert.deepEqual(exec.calls, []);
    assert.equal(r.code, 0);
    assert.match(r.lines.join('\n'), /nothing to undo: the keys journal is empty\./);
  });

  it('quotes a printed argv only where a shell would need it', () => {
    assert.equal(formatCommand({ cmd: 'tmux', args: ['unbind-key', 'g'] }), 'tmux unbind-key g');
    assert.equal(
      formatCommand({ cmd: 'gsettings', args: ['set', 'org.x', 'k', "['/a/', '/b/']"] }),
      `gsettings set org.x k "['/a/', '/b/']"`,
    );
  });
});

describe('doctor reports journal drift in one line (K5)', () => {
  it('is quiet when there is no journal', async () => {
    const exec = recordingExec(script({ keys: OURS }));
    assert.equal(await keysJournalCheck({ entries: [], exec, blocked: false }), undefined);
    assert.deepEqual(exec.calls, []);
  });

  it('is quiet under CCTAP_NO_EXEC, because nothing can be read back', async () => {
    const exec = recordingExec(script({ keys: OURS }));
    assert.equal(await keysJournalCheck({ entries: [tmuxEntry()], exec, blocked: true }), undefined);
    assert.deepEqual(exec.calls, []);
  });

  it('says ok while every journaled binding is still active', async () => {
    const exec = recordingExec(script({ keys: OURS, gnome: `'${JUMP}'\n` }));
    const check = await keysJournalCheck({ entries: [tmuxEntry(), gnomeEntry()], exec, blocked: false });
    assert.equal(check?.level, 'ok');
    assert.equal(check?.title, '2 journaled key bindings, all still active');
    assert.equal(check?.detail, 'cctap keys status lists them');
  });

  it('warns with the counts and the remedy when one drifted', async () => {
    const exec = recordingExec(script({ keys: THEIRS, gnomeCode: 2 }));
    const check = await keysJournalCheck({ entries: [tmuxEntry(), gnomeEntry()], exec, blocked: false });
    assert.equal(check?.level, 'warn');
    assert.equal(check?.title, 'journaled key bindings drifted: 1 gone, 1 changed');
    assert.equal(check?.detail, 'run: cctap keys status');
  });
});

/** Secure Keyboard Entry eats OS-level hotkeys silently, so doctor is the only symptom. */
describe('doctor flags Secure Keyboard Entry on macOS', () => {
  const on = (): ExecResult => ({ code: 0, stdout: '1\n', stderr: '' });

  it('warns when the setting reads 1, and names where to turn it off', async () => {
    const exec = recordingExec(on);
    const check = await secureKeyboardEntryCheck({ platform: 'darwin', exec, blocked: false });
    assert.deepEqual(exec.calls, [{ cmd: 'defaults', args: ['read', 'com.apple.Terminal', 'SecureKeyboardEntry'] }]);
    assert.deepEqual(secureKeyboardEntryCommand(), exec.calls[0]);
    assert.equal(check?.level, 'warn');
    assert.equal(check?.title, 'Terminal.app has Secure Keyboard Entry on');
    assert.match(check?.detail ?? '', /Terminal > Secure Keyboard Entry/);
    assert.match(check?.detail ?? '', /if the jump key does nothing/);
  });

  it('says nothing when it reads 0', async () => {
    const check = await secureKeyboardEntryCheck({
      platform: 'darwin',
      exec: recordingExec(() => ({ code: 0, stdout: '0\n', stderr: '' })),
      blocked: false,
    });
    assert.equal(check, undefined);
  });

  it('says nothing when the key was never written', async () => {
    const check = await secureKeyboardEntryCheck({
      platform: 'darwin',
      exec: recordingExec(() => ({ code: 1, stdout: '', stderr: 'does not exist' })),
      blocked: false,
    });
    assert.equal(check, undefined);
  });

  it('never runs off darwin, and never under CCTAP_NO_EXEC', async () => {
    const linux = recordingExec(on);
    assert.equal(await secureKeyboardEntryCheck({ platform: 'linux', exec: linux, blocked: false }), undefined);
    assert.deepEqual(linux.calls, []);

    const blocked = recordingExec(on);
    assert.equal(await secureKeyboardEntryCheck({ platform: 'darwin', exec: blocked, blocked: true }), undefined);
    assert.deepEqual(blocked.calls, []);
  });
});

/** K6: purging the tree takes the journal with it, so a live binding loses its way back. */
describe('uninstall-hooks --purge guards the journal', () => {
  async function installed(): Promise<{ t: TempEnv; settings: string }> {
    const t = tempEnv();
    envs.push(t);
    const settings = join(t.dir, 'settings.json');
    await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings } });
    return { t, settings };
  }

  it('refuses, names undo --all first and leaves everything in place', async () => {
    const { t, settings } = await installed();
    writeJournal(paths({ CCTAP_DIR: t.dir }), [tmuxEntry()]);

    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings } });
    assert.equal(r.code, 1);
    const err = r.stderr.toString();
    assert.match(err, /the keys journal still holds 1 binding that cctap set up/);
    assert.match(err, /take them back first: {2}cctap keys undo --all/);
    assert.match(err, /a tmux bind dies with its tmux server, so yours may be gone already/);
    assert.match(err, /cctap uninstall-hooks --purge --force/);
    assert.match(err, /Nothing was changed\./);
    assert.equal(fs.existsSync(t.dir), true, 'the tree is still there');
    assert.match(fs.readFileSync(settings, 'utf8'), /hook-forward\.mjs/, 'and the hooks were not removed');
  });

  it('--force purges anyway, journal and all', async () => {
    const { t, settings } = await installed();
    writeJournal(paths({ CCTAP_DIR: t.dir }), [tmuxEntry(), gnomeEntry()]);

    const r = await runNode(CLI, ['uninstall-hooks', '--purge', '--force'], {
      env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings },
    });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /purged:/);
    assert.equal(fs.existsSync(t.dir), false);
  });

  it('purges without a fight once the journal is empty', async () => {
    const { t, settings } = await installed();
    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.equal(fs.existsSync(t.dir), false);
  });

  it('leaves the journal alone without --purge, like the rest of the tree', async () => {
    const { t, settings } = await installed();
    const p = paths({ CCTAP_DIR: t.dir });
    writeJournal(p, [tmuxEntry()]);

    const r = await runNode(CLI, ['uninstall-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: settings } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.deepEqual(readJournal(p), [tmuxEntry()]);
  });
});

describe('the cli surfaces status and undo', () => {
  it('reads the journal back through cctap keys status', async () => {
    const t = tempEnv();
    envs.push(t);
    const p = paths({ CCTAP_DIR: t.dir });

    const empty = await runNode(CLI, ['keys', 'status'], { env: t.env });
    assert.equal(empty.code, 0, empty.stderr.toString());
    assert.match(empty.stdout.toString(), /nothing journaled/);

    writeJournal(p, [tmuxEntry()]);
    // The temp env blocks exec, which is exactly the degraded path K3 has to answer for.
    const listed = await runNode(CLI, ['keys', 'status'], { env: t.env });
    assert.equal(listed.code, 0, listed.stderr.toString());
    const out = listed.stdout.toString();
    assert.match(out, /the live state cannot be read back/);
    assert.match(out, /unknown {2}tmux-bind on g/);

    const undo = await runNode(CLI, ['keys', 'undo'], { env: t.env });
    assert.equal(undo.code, 0, undo.stderr.toString());
    assert.match(undo.stdout.toString(), /this is what cctap keys undo would run:/);
    assert.deepEqual(readJournal(p), [tmuxEntry()], 'a refused undo changes nothing');
  });

  it('teaches both from the keys listing', async () => {
    const t = tempEnv();
    envs.push(t);
    const r = await runNode(CLI, ['keys'], { env: t.env });
    assert.match(r.stdout.toString(), /keys status +what cctap bound, and whether it is still bound/);
    assert.match(r.stdout.toString(), /keys undo +take the newest one back \(--all for every one\)/);
  });
});
