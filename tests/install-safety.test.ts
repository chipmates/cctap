/**
 * The installer as a transaction: validate before anything is written, swap binaries
 * atomically, quote what a shell will re-parse, delete only what cctap created, and
 * signal only a process that is actually a cctap daemon. Every case here is a repro
 * that used to end with a file, a binding or a stranger's process the worse for it.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { changedSince, looksLikeDaemon, purgeTree, rejectUnknown, stopDaemon, writeBackup } from '../src/commands/install.js';
import { recordingExec } from '../src/exec.js';
import { mergeHooks, REGISTRATIONS, type Settings } from '../src/install/hooks.js';
import { isOurStatusLine, statusLineFor } from '../src/install/statusline.js';
import { paths, SUN_PATH_MAX } from '../src/paths.js';
import { shquote } from '../src/shquote.js';
import { distDir, runNode, tempDir, tempEnv, type TempEnv } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const CLI = join(distDir(), 'cctap.mjs');
const FWD = '/home/u/.cctap/bin/hook-forward.mjs';

const envs: TempEnv[] = [];
after(() => envs.forEach((e) => e.cleanup()));

function fresh(): TempEnv {
  const t = tempEnv();
  envs.push(t);
  return t;
}

/** A CCTAP_DIR of its own, so a purge has nothing foreign to trip over. */
function ownTree(t: TempEnv): { dir: string; env: NodeJS.ProcessEnv; settings: string } {
  const dir = join(t.dir, 'tree');
  const settings = join(t.dir, 'settings.json');
  return { dir, env: { ...t.env, CCTAP_DIR: dir, CCTAP_CLAUDE_SETTINGS: settings }, settings };
}

/** Everything under a directory, so "nothing was written" can be asserted literally. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      out.push(rel);
      if (fs.statSync(full).isDirectory()) walk(full, rel);
    }
  };
  walk(dir, '');
  return out;
}

describe('--purge deletes what cctap made, never a directory wholesale', () => {
  it('takes the whole tree when the tree is only ours', async () => {
    const t = fresh();
    const o = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: o.env });
    // The copies go through a temp name and a rename, so a hook firing mid-install loads
    // one whole bundle or the other. Nothing of that is left behind.
    assert.deepEqual(fs.readdirSync(join(o.dir, 'bin')).sort(), ['cctap.mjs', 'daemon.mjs', 'hook-forward.mjs']);

    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /^purged: {3}/m);
    assert.equal(fs.existsSync(o.dir), false);
  });

  /**
   * CCTAP_DIR is an unvalidated override, so a recursive delete of its root deleted
   * whatever the user actually had there. The rmdir that fails on foreign content is
   * the guard: it is what keeps a wrong CCTAP_DIR intact.
   */
  it('leaves the directory standing when something foreign is in it', async () => {
    const t = fresh();
    const o = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: o.env });
    fs.writeFileSync(join(o.dir, 'not-ours.txt'), 'a file cctap never wrote\n');
    fs.mkdirSync(join(o.dir, 'notes'), { recursive: true });
    fs.writeFileSync(join(o.dir, 'notes', 'keep.md'), '# keep\n');

    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /it holds files that are not cctap/);
    assert.equal(fs.existsSync(o.dir), true, 'the directory survived');
    assert.equal(fs.readFileSync(join(o.dir, 'not-ours.txt'), 'utf8'), 'a file cctap never wrote\n');
    assert.equal(fs.readFileSync(join(o.dir, 'notes', 'keep.md'), 'utf8'), '# keep\n');
    // And everything of ours is gone all the same.
    for (const gone of ['bin', 'spool', 'install.json', 'state.json']) {
      assert.equal(fs.existsSync(join(o.dir, gone)), false, `${gone} removed`);
    }
  });

  it('purgeTree reports the survival rather than forcing it', () => {
    const dir = tempDir('cctap-purge-');
    const p = paths({ CCTAP_DIR: dir });
    fs.mkdirSync(p.bin, { recursive: true });
    fs.writeFileSync(p.install, '{}\n');
    fs.writeFileSync(join(p.bin, 'daemon.mjs'), 'x\n');
    fs.writeFileSync(join(dir, 'theirs'), 'x\n');
    assert.equal(purgeTree(p), true, 'survived, because something foreign is in it');
    assert.equal(fs.existsSync(join(dir, 'theirs')), true);
    assert.equal(fs.existsSync(p.bin), false);

    fs.unlinkSync(join(dir, 'theirs'));
    assert.equal(purgeTree(p), false, 'nothing foreign left, so it goes');
    assert.equal(fs.existsSync(dir), false);
  });
});

describe('the purge guard fails closed', () => {
  it('refuses a journal it cannot read instead of calling it empty', async () => {
    const t = fresh();
    const o = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: o.env });
    fs.writeFileSync(join(o.dir, 'keys.json'), '{"v":1,"entries":[trunc');

    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: o.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /cannot be read as a keys journal/);
    assert.match(r.stderr.toString(), /Nothing was changed\./);
    assert.equal(fs.existsSync(join(o.dir, 'bin')), true, 'and nothing was');

    const forced = await runNode(CLI, ['uninstall-hooks', '--purge', '--force'], { env: o.env });
    assert.equal(forced.code, 0, forced.stderr.toString());
    assert.equal(fs.existsSync(o.dir), false, '--force is still the way past it');
  });
});

describe('nothing is written before the settings file has been read', () => {
  it('a settings file it cannot parse leaves the disk exactly as it was', async () => {
    const t = fresh();
    const o = ownTree(t);
    fs.writeFileSync(o.settings, '{ this is not json');
    const before = tree(t.dir);

    const r = await runNode(CLI, ['install-hooks'], { env: o.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /Nothing was changed/);
    // The claim used to be false: the three live hook binaries were replaced first.
    assert.deepEqual(tree(t.dir), before, 'not one file, not one directory');
    assert.equal(fs.existsSync(o.dir), false, 'the tree was never created');
  });

  it('a dry run still writes nothing at all', async () => {
    const t = fresh();
    const o = ownTree(t);
    fs.writeFileSync(o.settings, '{}\n');
    const before = tree(t.dir);

    const r = await runNode(CLI, ['install-hooks', '--dry-run'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.deepEqual(tree(t.dir), before);
  });
});

describe('backups are never overwritten', () => {
  it('a second backup in the same millisecond takes the next name', () => {
    const dir = tempDir('cctap-bak-');
    const file = join(dir, 'settings.json');
    fs.writeFileSync(file, 'original\n');
    const at = new Date('2026-08-03T18:30:00.123Z');

    const first = writeBackup(file, at);
    fs.writeFileSync(file, 'installed\n');
    const second = writeBackup(file, at);

    assert.notEqual(first, second, 'a taken name is answered with the next one');
    assert.equal(fs.readFileSync(first, 'utf8'), 'original\n', 'the pre-cctap file survives');
    assert.equal(fs.readFileSync(second, 'utf8'), 'installed\n');
    // Milliseconds and the pid are in the name, so two runs a second apart cannot collide
    // in the first place.
    assert.match(first, /\.cctap-bak-20260803T183000123-\d+$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an install and an uninstall in the same second keep both backups', async () => {
    const t = fresh();
    const o = ownTree(t);
    fs.writeFileSync(o.settings, '{\n  "model": "opus"\n}\n');
    await runNode(CLI, ['install-hooks'], { env: o.env });
    await runNode(CLI, ['uninstall-hooks'], { env: o.env });

    const backups = fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak'));
    assert.equal(backups.length, 2, 'one per write, neither on top of the other');
    const pre = backups.map((f) => fs.readFileSync(join(t.dir, f), 'utf8'));
    assert.ok(
      pre.some((c) => c === '{\n  "model": "opus"\n}\n'),
      'the genuine pre-cctap file is still one of them',
    );
  });
});

describe('the daemon pid is checked before it is signalled', () => {
  it('knows a cctap daemon from a recycled number', () => {
    assert.equal(looksLikeDaemon('/usr/bin/node /home/u/.cctap/bin/daemon.mjs'), true);
    assert.equal(looksLikeDaemon('/usr/bin/node /tmp/x/dist/cctap.mjs daemon'), true);
    assert.equal(looksLikeDaemon('/usr/bin/node /opt/app/daemon.mjs --port 8080\n'), true);
    assert.equal(looksLikeDaemon('/usr/sbin/sshd -D'), false);
    assert.equal(looksLikeDaemon('postgres: writer process'), false);
    assert.equal(looksLikeDaemon(''), false);
  });

  /**
   * A daemon killed with SIGKILL leaves daemon.json behind, the number gets recycled,
   * and SIGTERM then landed on whatever inherited it.
   */
  it('signals nobody when the pid is running something else', async () => {
    const dir = tempDir('cctap-stop-');
    const p = paths({ CCTAP_DIR: dir });
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(p.daemonInfo, `${JSON.stringify({ pid: victim.pid, version: '0.0.0' })}\n`);

    // The seam is scripted, so no ps runs; CCTAP_NO_EXEC is lifted only so the check is
    // consulted at all, the way it is on a real machine.
    const exec = recordingExec(() => ({ code: 0, stdout: '/usr/bin/node -e setTimeout\n', stderr: '' }));
    const saved = process.env.CCTAP_NO_EXEC;
    delete process.env.CCTAP_NO_EXEC;
    let res;
    try {
      res = await stopDaemon(p, exec);
    } finally {
      if (saved !== undefined) process.env.CCTAP_NO_EXEC = saved;
    }

    assert.equal(res.outcome, 'already-gone');
    assert.deepEqual(exec.calls[0], { cmd: 'ps', args: ['-o', 'command=', '-p', String(victim.pid)] });
    assert.equal(victim.killed, false, 'nothing was signalled');
    assert.equal(process.kill(victim.pid as number, 0), true, 'and it is still running');
    assert.equal(fs.existsSync(p.daemonInfo), false, 'the stale half of the pair is gone');
    victim.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('signals a pid that really is a daemon', async () => {
    const dir = tempDir('cctap-stop-');
    const p = paths({ CCTAP_DIR: dir });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(p.daemonInfo, `${JSON.stringify({ pid: child.pid })}\n`);

    const exec = recordingExec(() => ({ code: 0, stdout: `node ${join(dir, 'bin', 'daemon.mjs')}\n`, stderr: '' }));
    const saved = process.env.CCTAP_NO_EXEC;
    delete process.env.CCTAP_NO_EXEC;
    let res;
    try {
      res = await stopDaemon(p, exec);
    } finally {
      if (saved !== undefined) process.env.CCTAP_NO_EXEC = saved;
    }
    assert.equal(res.outcome, 'stopped');
    assert.equal(res.pid, child.pid);
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an unreadable daemon.json is not the same fact as no daemon', async () => {
    const t = fresh();
    fs.writeFileSync(join(t.dir, 'daemon.json'), '{ truncated');
    const r = await runNode(CLI, ['stop'], { env: t.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /cannot read .*daemon\.json/);
    assert.equal(r.stdout.toString().includes('no daemon running'), false);
  });
});

describe('a hooks shape we do not own is preserved, never overwritten', () => {
  it('does not throw on a primitive beside a matcher-less group', () => {
    const base = { hooks: { Stop: [42] } } as unknown as Settings;
    const { settings, skipped } = mergeHooks(base, '/abs/node', FWD);
    assert.deepEqual(skipped, [], 'a foreign element is not a reason to skip the event');
    const groups = settings.hooks?.Stop as unknown[];
    assert.equal(groups[0], 42, 'left exactly where it was');
    assert.equal((groups[1] as { hooks: unknown[] }).hooks.length, 1, 'ours went beside it');
  });

  it('skips a matched group whose hooks are not a list', () => {
    const base = { hooks: { Stop: [{ hooks: 'nope' }] } } as unknown as Settings;
    const { settings, skipped, added } = mergeHooks(base, '/abs/node', FWD);
    assert.deepEqual(skipped, ['Stop'], 'named, not silently dropped');
    assert.equal(added.includes('Stop'), false);
    assert.deepEqual(settings.hooks?.Stop, [{ hooks: 'nope' }] as unknown, 'preserved as it stands');
  });

  it('skips an event whose value is not a list', () => {
    const base = { hooks: { Stop: 'nope' } } as unknown as Settings;
    const { settings, skipped } = mergeHooks(base, '/abs/node', FWD);
    assert.deepEqual(skipped, ['Stop']);
    assert.equal(settings.hooks?.Stop as unknown, 'nope');
  });

  it('never replaces a hooks map that is not a map', () => {
    const base = { model: 'opus', hooks: 'somebody else\u2019s data' } as unknown as Settings;
    const { settings, skipped, added } = mergeHooks(base, '/abs/node', FWD);
    assert.equal(skipped.length, REGISTRATIONS.length, 'every registration reported');
    assert.deepEqual(added, []);
    assert.equal(settings.hooks as unknown, 'somebody else\u2019s data', 'emptying it for ours would remove it');
    assert.equal(settings.model, 'opus');
  });

  it('the install says which registrations it could not write', async () => {
    const t = fresh();
    const o = ownTree(t);
    fs.writeFileSync(o.settings, `${JSON.stringify({ hooks: { Stop: 'nope' } }, null, 2)}\n`);
    const r = await runNode(CLI, ['install-hooks'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    const out = r.stdout.toString();
    assert.match(out, /^ {2}! Stop \(skipped, see below\)$/m, 'a skip that used to be invisible');
    assert.match(out, /could not be written/);
    const back = JSON.parse(fs.readFileSync(o.settings, 'utf8')) as Settings;
    assert.equal(back.hooks?.Stop as unknown, 'nope', 'and it stayed exactly as it was');
  });
});

describe('the status line survives a shell', () => {
  it('quotes what a shell would otherwise take for itself', () => {
    assert.equal(shquote('/plain/path'), "'/plain/path'");
    assert.equal(shquote("/o'brien/bin"), "'/o'\\''brien/bin'");
    const nasty = statusLineFor('/n$ode/bin/node', '/Users/`whoami`/.cctap/bin/cctap.mjs');
    assert.equal(nasty.command.includes('"'), false, 'no double quotes anywhere');
    assert.equal(isOurStatusLine(nasty, '/Users/`whoami`/.cctap/bin/cctap.mjs'), true, 'still ours');
  });

  /**
   * The entry goes into Claude Code's settings and is shell-parsed every two seconds. A
   * `$` in a home directory used to yield a dead strip, and a backtick ran path-derived
   * text on every refresh.
   */
  it('runs from a directory holding $ and a backtick', async () => {
    const t = fresh();
    const dir = join(t.dir, 'a$b`c d');
    const settings = join(t.dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...t.env, CCTAP_DIR: dir, CCTAP_CLAUDE_SETTINGS: settings };

    const r = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    const command = (JSON.parse(fs.readFileSync(settings, 'utf8')) as Settings).statusLine as { command: string };
    assert.ok(command.command.includes(shquote(join(dir, 'bin', 'cctap.mjs'))));

    const ran = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const sh = spawn('/bin/sh', ['-c', command.command], { env });
      let out = '';
      let err = '';
      sh.stdout.on('data', (c: Buffer) => (out += c.toString()));
      sh.stderr.on('data', (c: Buffer) => (err += c.toString()));
      sh.on('close', (code) => resolve({ code, out, err }));
    });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.err, '', 'the shell found both paths');
    assert.match(ran.out, /daemon not running/, 'and cctap itself answered, not the shell');
  });
});

describe('a misspelled flag is refused, not guessed at', () => {
  it('install-hooks exits 2 and writes nothing', async () => {
    const t = fresh();
    const o = ownTree(t);
    fs.writeFileSync(o.settings, '{}\n');
    const before = tree(t.dir);

    const r = await runNode(CLI, ['install-hooks', '--dry-rnu'], { env: o.env });
    assert.equal(r.code, 2, 'not a successful install');
    assert.match(r.stderr.toString(), /unknown option "--dry-rnu" for install-hooks/);
    assert.match(r.stderr.toString(), /--dry-run, --no-status-line/);
    assert.deepEqual(tree(t.dir), before, 'the real install did not happen');
  });

  it('uninstall-hooks exits 2 and keeps the tree', async () => {
    const t = fresh();
    const o = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: o.env });

    const r = await runNode(CLI, ['uninstall-hooks', '--purgee'], { env: o.env });
    assert.equal(r.code, 2);
    assert.match(r.stderr.toString(), /unknown option "--purgee" for uninstall-hooks/);
    assert.equal(fs.existsSync(join(o.dir, 'bin')), true, 'nothing was purged');
  });

  it('rejectUnknown names the first bad argument and lets the rest through', () => {
    assert.equal(rejectUnknown(['--dry-run'], ['--dry-run'], 'x'), undefined);
    assert.equal(rejectUnknown(['plain', '--dry-run'], ['--dry-run'], 'x'), undefined);
    assert.match(rejectUnknown(['--nope'], ['--dry-run'], 'x') ?? '', /unknown option "--nope" for x/);
    assert.equal(rejectUnknown(['--k=1'], ['--k'], 'x'), undefined, 'a value form is still the flag');
  });
});

describe('the way out of a broken socket path is not itself blocked', () => {
  /** A CCTAP_DIR whose socket path lands past the platform limit. */
  function overlong(): NodeJS.ProcessEnv {
    const t = fresh();
    const pad = SUN_PATH_MAX + 24 - t.dir.length - '/cctap.sock'.length;
    const dir = join(t.dir, 'd'.repeat(Math.max(pad, 1)));
    fs.mkdirSync(dir, { recursive: true });
    return { ...t.env, CCTAP_DIR: dir, CCTAP_CLAUDE_SETTINGS: join(t.dir, 'settings.json') };
  }

  it('lets uninstall-hooks, stop and notify run', async () => {
    const env = overlong();
    for (const args of [['uninstall-hooks'], ['stop'], ['notify']]) {
      const r = await runNode(CLI, args, { env });
      assert.equal(r.code, 0, `${args[0]}: ${r.stderr.toString()}`);
      assert.equal(r.stderr.toString().includes('byte limit'), false, `${args[0]} is not gated`);
    }
  });

  it('still refuses install-hooks, because that would install the problem', async () => {
    const env = overlong();
    const r = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr.toString(), /over the \d+ byte limit/);
  });
});

describe('a settings file that is a symlink is written through', () => {
  it('keeps the link, updates the target, backs up beside the real file', async () => {
    const t = fresh();
    const real = join(t.dir, 'real');
    fs.mkdirSync(real, { recursive: true });
    const target = join(real, 'settings.json');
    const link = join(t.dir, 'settings.json');
    fs.writeFileSync(target, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
    fs.symlinkSync(target, link);

    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: link } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a dotfiles repo keeps managing it');
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as Settings;
    assert.ok(written.hooks?.SessionStart, 'the real file got the hooks');
    assert.equal(written.model, 'opus');
    const backups = fs.readdirSync(real).filter((f) => f.includes('cctap-bak'));
    assert.equal(backups.length, 1, 'the backup landed beside the real file');
  });

  it('aborts rather than overwrite a change made while it was thinking', () => {
    const dir = tempDir('cctap-race-');
    const file = join(dir, 'settings.json');
    fs.writeFileSync(file, 'a\n');
    assert.equal(changedSince(file, 'a\n', true), false);
    assert.equal(changedSince(file, 'b\n', true), true);
    fs.unlinkSync(file);
    assert.equal(changedSince(file, '', false), false, 'still absent, as it was');
    assert.equal(changedSince(file, 'a\n', true), true, 'it was there and now is not');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('uninstall phases do not depend on each other', () => {
  /** With no settings file this printed "nothing to remove" and left daemon and tree. */
  it('purges even when there is no settings file to clean', async () => {
    const t = fresh();
    const o = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: o.env });
    fs.unlinkSync(o.settings);

    const r = await runNode(CLI, ['uninstall-hooks', '--purge'], { env: o.env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /does not exist/);
    assert.equal(fs.existsSync(o.dir), false, 'the tree still went');
  });

  /**
   * The record is the ownership answer for the next run, and the run that says "try
   * another CCTAP_DIR" is the worst possible moment to delete it.
   */
  it('keeps the install record on a run that removed nothing', async () => {
    const t = fresh();
    const a = ownTree(t);
    await runNode(CLI, ['install-hooks'], { env: a.env });
    const other = join(t.dir, 'elsewhere');
    const otherSettings = join(t.dir, 'other-settings.json');
    fs.writeFileSync(otherSettings, '{}\n');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(join(other, 'install.json'), '{"forwarderPath":"/nowhere/hook-forward.mjs"}\n');

    const r = await runNode(CLI, ['uninstall-hooks'], {
      env: { ...t.env, CCTAP_DIR: other, CCTAP_CLAUDE_SETTINGS: otherSettings },
    });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /run this again with that one set/);
    assert.equal(fs.existsSync(join(other, 'install.json')), true, 'the record the advice needs is still there');
  });
});
