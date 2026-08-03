/**
 * The install contract, spec/CONTRACTS.md section 4. Every run uses a temp
 * CCTAP_CLAUDE_SETTINGS file: the real ~/.claude is never touched.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  countOurs,
  HOOK_TIMEOUT_S,
  isOurs,
  listOurs,
  mergeHooks,
  removeHooks,
  REGISTRATIONS,
  type HookEntry,
  type Settings,
} from '../src/install/hooks.js';
import { isOurStatusLine, mergeStatusLine, removeStatusLine, statusLineFor } from '../src/install/statusline.js';
import { distDir, linkFakeCctap, runNode, tempEnv } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

const CLI = join(distDir(), 'cctap.mjs');

const FOREIGN: Settings = {
  model: 'opus',
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '/usr/bin/env', args: ['echo', 'foreign'], timeout: 3 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: '/bin/true', args: [] }] }],
  },
};

function settingsFile(dir: string, initial?: Settings): string {
  const file = join(dir, 'settings.json');
  if (initial) fs.writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`);
  return file;
}

describe('hook set matches the spec', () => {
  it('registers exactly the specified event set', () => {
    const names = REGISTRATIONS.map((r) => (r.matcher ? `${r.event}(${r.matcher})` : r.event));
    assert.deepEqual(names, [
      'SessionStart(*)',
      'UserPromptSubmit',
      'PreToolUse(*)',
      'PermissionDenied(*)',
      'Notification(permission_prompt)',
      'Notification(idle_prompt)',
      'Notification(agent_needs_input)',
      'Notification(agent_completed)',
      'Notification(elicitation_dialog)',
      'Notification(elicitation_response)',
      'Notification(elicitation_complete)',
      'Stop',
      'StopFailure(*)',
      'SubagentStart(*)',
      'SubagentStop(*)',
      'PreCompact(*)',
      'PostCompact(*)',
      'CwdChanged',
      'SessionEnd(*)',
    ]);
  });

  it('does not register the deliberately excluded events', () => {
    const events = new Set(REGISTRATIONS.map((r) => r.event));
    for (const excluded of ['PostToolUse', 'PermissionRequest', 'TeammateIdle', 'TaskCreated', 'TaskCompleted']) {
      assert.equal(events.has(excluded), false, `${excluded} must stay unregistered`);
    }
  });

  it('tags every Notification matcher in argv', () => {
    const notifs = REGISTRATIONS.filter((r) => r.event === 'Notification');
    assert.equal(notifs.length, 7);
    for (const reg of notifs) {
      assert.equal(reg.notif, reg.matcher, 'the notif tag mirrors the matcher');
    }
  });

  it('builds exec-form entries with async and a 5 s timeout', () => {
    const { settings } = mergeHooks({}, '/abs/node', '/home/u/.cctap/bin/hook-forward.mjs');
    const entry = settings.hooks?.Notification?.[0]?.hooks[0];
    assert.ok(entry);
    assert.equal(entry.type, 'command');
    assert.equal(entry.command, '/abs/node');
    assert.deepEqual(entry.args, [
      '/home/u/.cctap/bin/hook-forward.mjs',
      '--event=Notification',
      '--notif=permission_prompt',
    ]);
    assert.equal(entry.async, true);
    assert.equal(entry.timeout, 5);
  });

  it('registers every event async on the same timeout, UserPromptSubmit included', () => {
    const { settings } = mergeHooks({}, '/abs/node', '/home/u/.cctap/bin/hook-forward.mjs');
    // I2 leaves nothing for a hook decision to say, so no registration needs to be
    // synchronous and none may hold up a prompt.
    const prompt = settings.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    assert.ok(prompt);
    assert.equal(prompt.async, true);
    assert.equal(prompt.timeout, HOOK_TIMEOUT_S);
    assert.equal(prompt.timeout, 5);

    const all = Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks));
    assert.equal(all.length, REGISTRATIONS.length);
    assert.deepEqual([...new Set(all.map((h) => h.async))], [true], 'every registration is async');
    assert.deepEqual([...new Set(all.map((h) => h.timeout))], [HOOK_TIMEOUT_S], 'on one timeout');
  });
});

describe('merge logic', () => {
  const FWD = '/home/u/.cctap/bin/hook-forward.mjs';

  it('identifies our entries by the forwarder path, not the node path', () => {
    assert.equal(isOurs({ type: 'command', command: '/any/node', args: [FWD, '--event=Stop'] }, FWD), true);
    assert.equal(isOurs({ type: 'command', command: '/abs/node', args: ['/other.mjs'] }, FWD), false);
    assert.equal(isOurs({ type: 'other', args: [FWD] }, FWD), false);
    assert.equal(isOurs(null, FWD), false);
  });

  it('preserves foreign hooks byte-identically', () => {
    const before = JSON.stringify(FOREIGN);
    const { settings } = mergeHooks(FOREIGN, '/abs/node', FWD);
    assert.equal(JSON.stringify(FOREIGN), before, 'the input object is untouched');
    const bash = settings.hooks?.PreToolUse?.find((g) => g.matcher === 'Bash');
    assert.deepEqual(bash, FOREIGN.hooks?.PreToolUse?.[0], 'the foreign matcher group is unchanged');
    const stop = settings.hooks?.Stop?.[0];
    assert.equal(stop?.hooks[0]?.command, '/bin/true', 'the foreign Stop hook stays first');
    assert.equal(settings.model, 'opus', 'unrelated settings survive');
  });

  it('adds our entry to an existing matcherless group instead of duplicating it', () => {
    const { settings } = mergeHooks(FOREIGN, '/abs/node', FWD);
    assert.equal(settings.hooks?.Stop?.length, 1, 'one Stop group');
    assert.equal(settings.hooks?.Stop?.[0]?.hooks.length, 2, 'foreign plus ours');
  });

  it('is idempotent: merging twice changes nothing', () => {
    const once = mergeHooks(FOREIGN, '/abs/node', FWD);
    const twice = mergeHooks(once.settings, '/abs/node', FWD);
    assert.deepEqual(twice.settings, once.settings);
    assert.deepEqual(twice.added, []);
    assert.deepEqual(twice.replaced, []);
    assert.equal(twice.unchanged.length, REGISTRATIONS.length);
  });

  it('heals a changed node path by replacing, not duplicating', () => {
    const once = mergeHooks({}, '/old/node', FWD);
    const twice = mergeHooks(once.settings, '/new/node', FWD);
    assert.equal(countOurs(twice.settings, FWD), REGISTRATIONS.length);
    assert.equal(twice.replaced.length, REGISTRATIONS.length);
    assert.equal(twice.settings.hooks?.Stop?.[0]?.hooks[0]?.command, '/new/node');
  });

  it('heals an installed synchronous UserPromptSubmit entry back to async', () => {
    // A short-lived build registered this one synchronous with a 2 s cap. A re-install
    // is the only thing that takes it back off a prompt's critical path.
    const sync: Settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/abs/node', args: [FWD, '--event=UserPromptSubmit'], timeout: 2 }] },
        ],
      },
    };
    const { settings, replaced } = mergeHooks(sync, '/abs/node', FWD);
    assert.ok(replaced.includes('UserPromptSubmit'), 'reported as a replacement');
    const group = settings.hooks?.UserPromptSubmit?.[0];
    assert.equal(group?.hooks.length, 1, 'replaced in place, not duplicated');
    assert.equal((group?.hooks[0] as HookEntry).async, true, 'healed back to async');
    assert.equal((group?.hooks[0] as HookEntry).timeout, HOOK_TIMEOUT_S, 'and onto the 5 s timeout');
  });

  it('uninstall restores the original settings exactly', () => {
    const { settings } = mergeHooks(FOREIGN, '/abs/node', FWD);
    const { settings: back, removed } = removeHooks(settings, FWD);
    assert.equal(removed.length, REGISTRATIONS.length);
    assert.deepEqual(back, FOREIGN);
  });

  it('uninstall on empty settings leaves an empty object', () => {
    const { settings } = mergeHooks({}, '/abs/node', FWD);
    const { settings: back } = removeHooks(settings, FWD);
    assert.deepEqual(back, {});
  });

  it('uninstall leaves foreign entries in a shared group alone', () => {
    const { settings } = mergeHooks(FOREIGN, '/abs/node', FWD);
    const { settings: back } = removeHooks(settings, FWD);
    assert.equal(back.hooks?.Stop?.[0]?.hooks.length, 1);
    assert.equal(back.hooks?.Stop?.[0]?.hooks[0]?.command, '/bin/true');
  });
});

describe('status line merge logic', () => {
  const CLI_BIN = '/home/u/.cctap/bin/cctap.mjs';
  const CANONICAL = `CCTAP_COLOR=1 "/abs/node" "${CLI_BIN}" strip`;
  const UNQUOTED = `/abs/node ${CLI_BIN} strip`;
  /** What the first shipped status line ran, before the strip replaced the sentence. */
  const OLD_STATUS = `"/abs/node" "${CLI_BIN}" status`;
  const FOREIGN_LINE = { type: 'command', command: '/opt/mine/prompt.sh --fancy' };

  it('runs the coloured strip, with both paths quoted for the shell', () => {
    assert.deepEqual(statusLineFor('/abs/node', CLI_BIN), {
      type: 'command',
      command: CANONICAL,
      refreshInterval: 2,
    });
    const spaced = statusLineFor('/opt/node 22/bin/node', '/Users/a b/.cctap/bin/cctap.mjs');
    assert.equal(spaced.command, 'CCTAP_COLOR=1 "/opt/node 22/bin/node" "/Users/a b/.cctap/bin/cctap.mjs" strip');
  });

  it('recognizes every form it has ever written, quoted or not', () => {
    assert.equal(isOurStatusLine({ type: 'command', command: CANONICAL }, CLI_BIN), true);
    assert.equal(isOurStatusLine({ type: 'command', command: UNQUOTED }, CLI_BIN), true);
    assert.equal(isOurStatusLine({ type: 'command', command: OLD_STATUS }, CLI_BIN), true, 'the status form');
    // Ownership is by shape, the same rule the hooks use: any cctap.mjs, any directory.
    // The two answers must agree, or a run clears half an install and leaves the rest.
    const tilde = { type: 'command', command: 'node ~/.cctap/bin/cctap.mjs status' };
    assert.equal(isOurStatusLine(tilde, CLI_BIN), true, 'the hand-written tilde recipe');
    assert.equal(isOurStatusLine({ type: 'command', command: '"node" "~/.cctap/bin/cctap.mjs" status' }, CLI_BIN), true);
    assert.equal(isOurStatusLine({ type: 'command', command: 'node ~/.cctap/bin/cctap.mjs strip' }, CLI_BIN), true);
    assert.equal(
      isOurStatusLine({ type: 'command', command: 'node /somewhere/else/bin/cctap.mjs strip' }, CLI_BIN),
      true,
      'a relocated tree is still cctap',
    );
    assert.equal(isOurStatusLine(FOREIGN_LINE, CLI_BIN), false);
    assert.equal(isOurStatusLine({ type: 'command' }, CLI_BIN), false);
    assert.equal(isOurStatusLine(null, CLI_BIN), false);
    assert.equal(isOurStatusLine('a string', CLI_BIN), false);
  });

  it('heals the unquoted form earlier versions wrote', () => {
    const r = mergeStatusLine({ statusLine: { type: 'command', command: UNQUOTED } }, '/abs/node', CLI_BIN);
    assert.equal(r.outcome, 'updated');
    assert.deepEqual(r.settings.statusLine, { type: 'command', command: CANONICAL, refreshInterval: 2 });
  });

  it('keeps a refreshInterval the user tuned, like any other key of theirs', () => {
    const tuned = { type: 'command', command: OLD_STATUS, refreshInterval: 10, padding: 0 };
    const r = mergeStatusLine({ statusLine: tuned }, '/abs/node', CLI_BIN);
    assert.equal(r.outcome, 'updated');
    assert.deepEqual(r.settings.statusLine, {
      type: 'command',
      command: CANONICAL,
      refreshInterval: 10,
      padding: 0,
    });
  });

  it('heals the plain-sentence status form into the strip', () => {
    const r = mergeStatusLine({ statusLine: { type: 'command', command: OLD_STATUS } }, '/abs/node', CLI_BIN);
    assert.equal(r.outcome, 'updated', 'an earlier install is ours, not foreign');
    assert.deepEqual(r.settings.statusLine, { type: 'command', command: CANONICAL, refreshInterval: 2 });
  });

  it('adds ours when there is none', () => {
    const r = mergeStatusLine(FOREIGN, '/abs/node', CLI_BIN);
    assert.equal(r.outcome, 'added');
    assert.deepEqual(r.settings.statusLine, { type: 'command', command: CANONICAL, refreshInterval: 2 });
    assert.equal(FOREIGN.statusLine, undefined, 'the input object is untouched');
  });

  it('never rewrites a status line that is not ours', () => {
    const r = mergeStatusLine({ statusLine: FOREIGN_LINE }, '/abs/node', CLI_BIN);
    assert.equal(r.outcome, 'foreign');
    assert.deepEqual(r.settings.statusLine, FOREIGN_LINE);
    assert.equal(r.command, CANONICAL, 'the chaining hint still knows our command');
  });

  it('refreshes the tilde form to the absolute one and keeps extra keys', () => {
    const r = mergeStatusLine(
      { statusLine: { type: 'command', command: 'node ~/.cctap/bin/cctap.mjs status', padding: 0 } },
      '/abs/node',
      CLI_BIN,
    );
    assert.equal(r.outcome, 'updated');
    assert.deepEqual(r.settings.statusLine, { type: 'command', command: CANONICAL, padding: 0, refreshInterval: 2 });
  });

  it('is idempotent, and heals a changed node path', () => {
    const once = mergeStatusLine({}, '/abs/node', CLI_BIN);
    const twice = mergeStatusLine(once.settings, '/abs/node', CLI_BIN);
    assert.equal(twice.outcome, 'unchanged');
    assert.deepEqual(twice.settings, once.settings);
    const moved = mergeStatusLine(once.settings, '/new/node', CLI_BIN);
    assert.equal(moved.outcome, 'updated');
    assert.deepEqual(moved.settings.statusLine, {
      type: 'command',
      command: `CCTAP_COLOR=1 "/new/node" "${CLI_BIN}" strip`,
      refreshInterval: 2,
    });
  });

  it('removes only ours', () => {
    const ours = removeStatusLine({ statusLine: { type: 'command', command: CANONICAL, refreshInterval: 2 } }, CLI_BIN);
    assert.equal(ours.outcome, 'removed');
    assert.equal('statusLine' in ours.settings, false, 'the key is gone, not left as null');

    const theirs = removeStatusLine({ statusLine: FOREIGN_LINE }, CLI_BIN);
    assert.equal(theirs.outcome, 'kept');
    assert.deepEqual(theirs.settings.statusLine, FOREIGN_LINE);

    const none = removeStatusLine(FOREIGN, CLI_BIN);
    assert.equal(none.outcome, 'absent');
    assert.deepEqual(none.settings, FOREIGN);
  });
});

describe('install-hooks command', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('dry run writes absolutely nothing', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const before = fs.readFileSync(file, 'utf8');

    const r = await runNode(CLI, ['install-hooks', '--dry-run'], {
      env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file },
    });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /dry run: nothing written/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'settings untouched');
    assert.deepEqual(
      fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak')),
      [],
      'no backup written on a dry run',
    );
    assert.equal(fs.existsSync(join(t.dir, 'bin', 'hook-forward.mjs')), false, 'no binaries copied on a dry run');
  });

  it('installs, backs up, copies the binaries and stays idempotent', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };

    const first = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(first.code, 0, first.stderr.toString());
    assert.match(first.stdout.toString(), /installed 19\/19 hooks/);
    assert.match(first.stdout.toString(), /picks the change up live/);

    const backups = fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak'));
    assert.equal(backups.length, 1, 'exactly one backup');
    assert.equal(fs.readFileSync(join(t.dir, backups[0] as string), 'utf8'), `${JSON.stringify(FOREIGN, null, 2)}\n`);

    for (const bin of ['hook-forward.mjs', 'daemon.mjs', 'cctap.mjs']) {
      const p = join(t.dir, 'bin', bin);
      assert.ok(fs.existsSync(p), `${bin} copied to the stable path`);
      assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'I5 on bin files');
    }

    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
    assert.equal(countOurs(written, join(t.dir, 'bin', 'hook-forward.mjs')), REGISTRATIONS.length);
    assert.equal(written.model, 'opus');
    const entry = written.hooks?.SessionStart?.[0]?.hooks[0];
    assert.equal(entry?.command, process.execPath, 'absolute node path recorded');
    assert.equal(entry?.async, true);
    assert.equal(entry?.timeout, 5);

    const record = JSON.parse(fs.readFileSync(join(t.dir, 'install.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(record.nodePath, process.execPath);

    const second = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(second.code, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(written, null, 2) + '\n', 'second run is a no-op');
    assert.match(second.stdout.toString(), /19\/19 hooks in place, already up to date/);
  });

  it('takes no backup on a run that changes nothing', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });
    const afterFirst = fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak'));
    assert.equal(afterFirst.length, 1);

    const second = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(second.code, 0);
    assert.deepEqual(
      fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak')),
      afterFirst,
      'a no-op run keeps the backup that holds the pre-cctap file',
    );
    assert.equal(second.stdout.toString().includes('backup:'), false, 'and does not claim one');
  });

  it('uninstall writes nothing, and takes no backup, when nothing is ours', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const before = fs.readFileSync(file, 'utf8');
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };

    for (let i = 0; i < 6; i++) {
      const r = await runNode(CLI, ['uninstall-hooks'], { env });
      assert.equal(r.code, 0, r.stderr.toString());
      assert.equal(r.stdout.toString().includes('backup:'), false, 'a no-op claims no backup');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file was never rewritten');
    assert.deepEqual(
      fs.readdirSync(t.dir).filter((f) => f.includes('cctap-bak')),
      [],
      'six no-ops cannot rotate a genuine pre-install backup away',
    );
  });

  it('creates a settings file when none exists', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = join(t.dir, 'nested', 'settings.json');
    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.ok(fs.existsSync(file));
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
    assert.equal(countOurs(written, join(t.dir, 'bin', 'hook-forward.mjs')), REGISTRATIONS.length);
  });

  it('uninstall removes exactly ours and restores the original file', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    const original = fs.readFileSync(file, 'utf8');

    await runNode(CLI, ['install-hooks'], { env });
    const dry = await runNode(CLI, ['uninstall-hooks', '--dry-run'], { env });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout.toString(), /dry run: nothing written/);
    assert.notEqual(fs.readFileSync(file, 'utf8'), original, 'dry run did not undo the install');

    const r = await runNode(CLI, ['uninstall-hooks'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /removed 19 hooks/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'byte-identical restore');
    assert.equal(fs.existsSync(join(t.dir, 'install.json')), false, 'install record cleared');
  });

  it('re-running the installed cli does not truncate its own binaries', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });

    const installed = join(t.dir, 'bin', 'cctap.mjs');
    const sizes = ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs'].map((f) => fs.statSync(join(t.dir, 'bin', f)).size);
    const r = await runNode(installed, ['install-hooks'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    const after = ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs'].map((f) => fs.statSync(join(t.dir, 'bin', f)).size);
    assert.deepEqual(after, sizes, 'binaries survived a self-install');
    assert.ok(sizes.every((s) => s > 1000));
  });

  it('refuses to touch a settings file it cannot parse', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = join(t.dir, 'settings.json');
    fs.writeFileSync(file, '{ this is not json');
    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'left untouched');
    const err = r.stderr.toString();
    assert.match(err, /cannot parse .* as JSON/, 'the verdict, not a permissions hint');
    assert.match(err, /Nothing was changed/);
    assert.match(err, /no comments, no trailing commas/);
  });
});

/**
 * Hooks match on the forwarder path, the status line on the cli path. Let those two
 * disagree and a run against the wrong CCTAP_DIR takes half the install with it.
 */
describe('one ownership answer for hooks and the status line', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  it('clears cctap out of the file whichever tree it was installed from', async () => {
    const installed = tempEnv();
    const other = tempEnv();
    envs.push(installed, other);
    const file = join(installed.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);

    await runNode(CLI, ['install-hooks'], { env: { ...installed.env, CCTAP_CLAUDE_SETTINGS: file } });
    const withTilde = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
    withTilde.statusLine = { type: 'command', command: 'node ~/.cctap/bin/cctap.mjs status' };
    fs.writeFileSync(file, `${JSON.stringify(withTilde, null, 2)}\n`);

    // Uninstalling from a different CCTAP_DIR still clears cctap: a registration that
    // runs a hook-forward.mjs is ours wherever it points, and leaving it behind means
    // 19 dead hooks firing on every event with no cctap-side cure.
    const r = await runNode(CLI, ['uninstall-hooks'], { env: { ...other.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /removed 19 hooks and the status line/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
    assert.equal('statusLine' in after, false, 'the status line went with them');
    assert.equal(countOurs(after, join(installed.dir, 'bin', 'hook-forward.mjs')), 0, 'no cctap hooks left');
    assert.deepEqual(after.hooks?.PreToolUse?.[0], FOREIGN.hooks?.PreToolUse?.[0], 'foreign hooks untouched');
  });

  it('the matching CCTAP_DIR still removes both', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = join(t.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });

    const r = await runNode(CLI, ['uninstall-hooks'], { env });
    assert.match(r.stdout.toString(), /removed 19 hooks and the status line/);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(FOREIGN, null, 2)}\n`);
  });

  it('a relocated install still recognizes its own quoted status line', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = join(t.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });
    const second = await runNode(CLI, ['install-hooks'], { env });
    assert.match(second.stdout.toString(), /^ {2}= statusLine$/m, 'ours, not foreign, under a custom dir');
  });
});

/**
 * The orphan repro: install into one tree, point CCTAP_DIR at another, re-install. The
 * old exact-path rule added 19 more registrations beside the 19 dead ones, doctor called
 * that a healthy 38, uninstall refused them, and every hook event forked 19 failures.
 */
describe('a moved install is adopted, never duplicated', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  const readBack = (file: string): Settings => JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;

  it('re-installing from a new CCTAP_DIR rewrites the old registrations in place', async () => {
    const a = tempEnv();
    const b = tempEnv();
    envs.push(a, b);
    // Settings live outside both trees, the way ~/.claude does.
    const file = join(b.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);

    await runNode(CLI, ['install-hooks'], { env: { ...a.env, CCTAP_CLAUDE_SETTINGS: file } });
    const oldForwarder = join(a.dir, 'bin', 'hook-forward.mjs');
    assert.equal(countOurs(readBack(file), oldForwarder), REGISTRATIONS.length, 'installed into A');

    // The tree moves. Nothing rewrites settings.json on its own.
    fs.rmSync(a.dir, { recursive: true, force: true });
    const second = await runNode(CLI, ['install-hooks'], { env: { ...b.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(second.code, 0, second.stderr.toString());

    const after = readBack(file);
    const newForwarder = join(b.dir, 'bin', 'hook-forward.mjs');
    assert.equal(countOurs(after, newForwarder), REGISTRATIONS.length, 'exactly 19, adopted onto B');
    const all = listOurs(after, newForwarder);
    assert.equal(all.length, REGISTRATIONS.length, 'and no parallel set left behind');
    assert.deepEqual(
      [...new Set(all.map((o) => o.entry.args[0]))],
      [newForwarder],
      'every registration points at the live forwarder',
    );
    assert.match(second.stdout.toString(), /~ SessionStart\(\*\) \(updated\)/, 'reported as updates, not adds');
    assert.deepEqual(after.hooks?.PreToolUse?.[0], FOREIGN.hooks?.PreToolUse?.[0], 'the foreign hook is untouched');
  });

  it('doctor fails on registrations whose forwarder is gone, and names the cure', async () => {
    const a = tempEnv();
    const b = tempEnv();
    envs.push(a, b);
    const file = join(b.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);
    await runNode(CLI, ['install-hooks'], { env: { ...a.env, CCTAP_CLAUDE_SETTINGS: file } });
    fs.rmSync(a.dir, { recursive: true, force: true });

    const doc = await runNode(CLI, ['doctor'], { env: { ...b.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(doc.code, 1, 'a failure, not a warning');
    assert.match(doc.stdout.toString(), /point at a forwarder that is gone/);
    assert.match(doc.stdout.toString(), /adopts them onto this install/);

    // And after the adopt, doctor is clean about the hooks.
    await runNode(CLI, ['install-hooks'], { env: { ...b.env, CCTAP_CLAUDE_SETTINGS: file } });
    const healed = await runNode(CLI, ['doctor'], { env: { ...b.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.match(healed.stdout.toString(), /hooks installed \(19\/19\)/);
    assert.equal(healed.stdout.toString().includes('forwarder that is gone'), false);
  });

  it('uninstall clears an orphaned set that no longer matches this dir', async () => {
    const a = tempEnv();
    const b = tempEnv();
    envs.push(a, b);
    const file = join(b.dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify(FOREIGN, null, 2)}\n`);
    await runNode(CLI, ['install-hooks'], { env: { ...a.env, CCTAP_CLAUDE_SETTINGS: file } });
    fs.rmSync(a.dir, { recursive: true, force: true });

    const r = await runNode(CLI, ['uninstall-hooks'], { env: { ...b.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /removed 19 hooks/);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(FOREIGN, null, 2)}\n`, 'back to the original file');
  });
});

describe('the status line install-hooks writes', () => {
  const envs: { cleanup(): void }[] = [];
  after(() => envs.forEach((e) => e.cleanup()));

  const THEIRS = { type: 'command', command: '/opt/mine/prompt.sh --fancy' };

  function canonical(dir: string): string {
    return `CCTAP_COLOR=1 "${process.execPath}" "${join(dir, 'bin', 'cctap.mjs')}" strip`;
  }

  function readBack(file: string): Settings {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  }

  it('adds it when there is none, then reports no change on a second run', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    // With cctap on PATH the epilogue teaches the short command; the npx branch has
    // its own test below.
    linkFakeCctap(t);

    const first = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(first.code, 0, first.stderr.toString());
    assert.match(first.stdout.toString(), /\+ statusLine/);
    // The epilogue tells one story: the strip is already there, the key is how you reach
    // it without waiting on anything. It never sends anyone off to set up a second thing.
    const epilogue = first.stdout.toString();
    assert.match(epilogue, /done\. The strip now shows at the bottom of every Claude Code session/);
    assert.match(
      epilogue,
      /^ {2}cctap keys setup +give the jump its key\. The instant path, full screen included$/m,
    );
    assert.match(epilogue, /^ {2}cctap 2 +jump to the session holding number 2, from any shell$/m);
    assert.match(epilogue, /^ {2}cctap +jump to whatever needs you$/m);
    assert.match(epilogue, /^ {2}banners off +by default\. Turn them on with: cctap notify on$/m);
    assert.equal(epilogue.includes('park a strip'), false, 'no step two');
    assert.equal(/^ {2}cctap strip/m.test(epilogue), false, 'the pane is not the headline act');
    assert.deepEqual(readBack(file).statusLine, { type: 'command', command: canonical(t.dir), refreshInterval: 2 });

    const second = await runNode(CLI, ['install-hooks'], { env });
    assert.equal(second.code, 0);
    assert.match(second.stdout.toString(), /^ {2}= statusLine$/m);
    assert.match(second.stdout.toString(), /19\/19 hooks in place, already up to date/);
    assert.deepEqual(readBack(file).statusLine, { type: 'command', command: canonical(t.dir), refreshInterval: 2 });
  });

  it('leaves a status line that is not ours alone and prints how to chain', async () => {
    const t = tempEnv();
    envs.push(t);
    linkFakeCctap(t);
    const file = settingsFile(t.dir, { ...FOREIGN, statusLine: THEIRS });
    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    const out = r.stdout.toString();
    assert.match(out, /= statusLine \(not ours, left untouched\)/);
    assert.match(out, /you already have a status line/);
    assert.ok(out.includes(`to show both, print your own line and then run: ${canonical(t.dir)}`));
    // A foreign status line means the strip has no home, so the epilogue says so
    // instead of claiming it is already at the bottom of every session.
    assert.equal(out.includes('The strip now shows at the bottom'), false, 'no promise it will show');
    assert.match(out, /Your own status line was left alone/);
    assert.match(out, /park one where you can see it with cctap strip/);
    assert.deepEqual(readBack(file).statusLine, THEIRS);
  });

  it('re-quotes the unquoted form an earlier install wrote', async () => {
    const t = tempEnv();
    envs.push(t);
    const legacy = { type: 'command', command: `${process.execPath} ${join(t.dir, 'bin', 'cctap.mjs')} strip` };
    const file = settingsFile(t.dir, { ...FOREIGN, statusLine: legacy });
    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /~ statusLine \(updated\)/);
    assert.deepEqual(readBack(file).statusLine, { type: 'command', command: canonical(t.dir), refreshInterval: 2 });
  });

  it('adopts a hand-written tilde form even when this install lives elsewhere', async () => {
    const t = tempEnv();
    envs.push(t);
    // Any cctap.mjs status line is cctap's, so a relocated install adopts it rather than
    // leaving a second one behind. Extra keys survive, as with any refresh.
    const manual = { type: 'command', command: 'node ~/.cctap/bin/cctap.mjs status', padding: 0 };
    const file = settingsFile(t.dir, { ...FOREIGN, statusLine: manual });
    const r = await runNode(CLI, ['install-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /~ statusLine \(updated\)/);
    assert.deepEqual(readBack(file).statusLine, {
      type: 'command',
      command: canonical(t.dir),
      padding: 0,
      refreshInterval: 2,
    });
  });

  it('shows the change in a dry run without writing it', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const before = fs.readFileSync(file, 'utf8');
    const r = await runNode(CLI, ['install-hooks', '--dry-run'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /\+ statusLine/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'settings untouched');
  });

  it('uninstall removes ours and says so', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });
    assert.ok(readBack(file).statusLine, 'installed first');

    const r = await runNode(CLI, ['uninstall-hooks'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /^ {2}- statusLine$/m);
    assert.match(r.stdout.toString(), /removed 19 hooks and the status line/);
    assert.equal('statusLine' in readBack(file), false);
  });

  it('uninstall keeps a status line that is not ours', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, { ...FOREIGN, statusLine: THEIRS });
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    await runNode(CLI, ['install-hooks'], { env });

    const r = await runNode(CLI, ['uninstall-hooks'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.match(r.stdout.toString(), /= statusLine that is not ours, left untouched/);
    assert.deepEqual(readBack(file).statusLine, THEIRS);
  });

  it('teaches the epilogue commands in the form that works on this machine', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };

    // Nothing named cctap on PATH: teaching a bare `cctap keys setup` here would hand
    // someone a command-not-found in the same breath as telling them the install is done.
    const npx = await runNode(CLI, ['install-hooks'], { env });
    assert.match(npx.stdout.toString(), /^ {2}npx @chipmates\/cctap keys setup +give the jump its key/m);
    assert.match(npx.stdout.toString(), /^ {2}npx @chipmates\/cctap 2 +jump to the session/m);
    assert.match(npx.stdout.toString(), /Turn them on with: npx @chipmates\/cctap notify on/);
    assert.equal(/^ {2}cctap /m.test(npx.stdout.toString()), false, 'never the bare form');
  });

  it('is left out entirely by --no-status-line', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const env = { ...t.env, CCTAP_CLAUDE_SETTINGS: file };
    const r = await runNode(CLI, ['install-hooks', '--no-status-line'], { env });
    assert.equal(r.code, 0, r.stderr.toString());
    const out = r.stdout.toString();
    assert.match(out, /= statusLine \(skipped, --no-status-line\)/);
    assert.match(out, /has the one-line JSON/, 'it says where the manual recipe lives');
    assert.equal('statusLine' in readBack(file), false, 'nothing written');
    assert.equal(countOurs(readBack(file), join(t.dir, 'bin', 'hook-forward.mjs')), REGISTRATIONS.length);
  });

  it('uninstall says nothing about a status line that was never there', async () => {
    const t = tempEnv();
    envs.push(t);
    const file = settingsFile(t.dir, FOREIGN);
    const before = fs.readFileSync(file, 'utf8');
    const r = await runNode(CLI, ['uninstall-hooks'], { env: { ...t.env, CCTAP_CLAUDE_SETTINGS: file } });
    assert.equal(r.code, 0, r.stderr.toString());
    assert.equal(r.stdout.toString().includes('statusLine'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing to change');
  });
});
