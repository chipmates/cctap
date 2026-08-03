/** I7 and I12 enforced against the source tree and the shipped bundles. */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { VERSION } from '../src/version.js';
import { distDir, repoRoot } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(repoRoot(), 'src'));

describe('zero runtime dependencies (I7)', () => {
  it('package.json declares no dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(pkg.dependencies, {});
    assert.deepEqual(Object.keys(pkg.devDependencies as object).sort(), ['@types/node', 'esbuild', 'typescript']);
  });

  it('the version constant matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it('every runtime import is a relative path, a node: builtin or a bundled fixture', () => {
    const bad: string[] = [];
    for (const file of srcFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] as string;
        const ok = spec.startsWith('.') || spec.startsWith('node:');
        if (!ok) bad.push(`${relative(repoRoot(), file)}: ${spec}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe('no network egress (I12)', () => {
  /** Every module that could reach the network, and every binary that could be shelled to. */
  const FORBIDDEN_MODULES = ['http', 'https', 'http2', 'dns', 'dns/promises', 'tls', 'dgram', 'inspector'];
  const FORBIDDEN_BINARIES = ['curl', 'wget', 'nc', 'ncat', 'telnet', 'ssh', 'scp'];

  it('no source file reaches the network', () => {
    const hits: string[] = [];
    for (const file of srcFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const mod of FORBIDDEN_MODULES) {
        if (new RegExp(`['"]node:${mod.replace('/', '\\/')}['"]`).test(text)) {
          hits.push(`${relative(repoRoot(), file)}: node:${mod}`);
        }
      }
      for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/]) {
        if (re.test(text)) hits.push(`${relative(repoRoot(), file)}: ${re}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('the shipped bundles import no networking module at all', () => {
    for (const bin of ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs']) {
      const text = fs.readFileSync(join(distDir(), bin), 'utf8');
      for (const mod of FORBIDDEN_MODULES) {
        assert.equal(text.includes(`node:${mod}`), false, `${bin} references node:${mod}`);
      }
      assert.ok(text.includes('node:net'), `${bin} is expected to use the unix socket`);
    }
  });

  it('the shipped bundles never shell out to a network tool', () => {
    // Every argv[0] the code can build, checked against the tools an exfiltrator wants.
    for (const bin of ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs']) {
      const text = fs.readFileSync(join(distDir(), bin), 'utf8');
      for (const exe of FORBIDDEN_BINARIES) {
        assert.equal(new RegExp(`["']${exe}["']`).test(text), false, `${bin} names ${exe}`);
      }
    }
  });

  it('the bundles are self-contained ESM with a node shebang', () => {
    for (const bin of ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs']) {
      const text = fs.readFileSync(join(distDir(), bin), 'utf8');
      assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${bin} needs a shebang`);
      const externals = [...text.matchAll(/\bimport\s*(?:[\w*{}\s,$]+from\s*)?"([^"]+)"/g)].map((m) => m[1] as string);
      const nonBuiltin = externals.filter((s) => !s.startsWith('node:'));
      assert.deepEqual(nonBuiltin, [], `${bin} must bundle everything`);
    }
  });
});

describe('tests never fire a real notification', () => {
  it('the shared temp env silences the notifier', () => {
    const helpers = fs.readFileSync(join(repoRoot(), 'tests', 'helpers.ts'), 'utf8');
    assert.match(helpers, /CCTAP_NOTIFY: 'off'/, 'tempEnv must keep silencing desktop banners');
  });

  it('no test spawns a process with an env that is not derived from tempEnv', () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(join(repoRoot(), 'tests'))) {
      if (!name.endsWith('.test.ts')) continue;
      const text = fs.readFileSync(join(repoRoot(), 'tests', name), 'utf8');
      // Every name this file binds to a tempEnv(), so a spread of one is provably silenced.
      const roots = new Set(['env']);
      for (const d of text.matchAll(/const\s+(\w+)\s*=\s*tempEnv\(/g)) roots.add(`${d[1]}.env`);
      for (const d of text.matchAll(/const\s+\{?\s*(\w+)[^=]*=\s*overlongEnv\(/g)) roots.add(`${d[1]}.env`);
      for (const m of text.matchAll(/(?:startDaemon|runNode)\([^)]*env:\s*\{([^}]*)\}/g)) {
        const body = m[1] ?? '';
        const ok = [...roots].some((r) => body.includes(`...${r}`));
        if (!ok) offenders.push(`${name}: ${body.trim()}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('no personal names or absolute build paths leak into the bundles', () => {
  it('bundles carry no home directory paths from the build machine', () => {
    for (const bin of ['cctap.mjs', 'hook-forward.mjs', 'daemon.mjs']) {
      const text = fs.readFileSync(join(distDir(), bin), 'utf8');
      assert.equal(/\/Users\/[a-z]/i.test(text), false, `${bin} embeds a build path`);
    }
  });
});
