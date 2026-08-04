#!/usr/bin/env node
/** esbuild bundles: three self-contained ESM binaries plus the test bundles. */

import { build } from 'esbuild';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const distTests = join(dist, 'tests');

const SHEBANG = '#!/usr/bin/env node';

const BINARIES = [
  { in: 'src/cli.ts', out: 'cctap.mjs', exec: true },
  { in: 'src/forwarder.ts', out: 'hook-forward.mjs', exec: false },
  { in: 'src/daemon-entry.ts', out: 'daemon.mjs', exec: false },
];

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  legalComments: 'none',
};

async function main() {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  mkdirSync(distTests, { recursive: true });

  for (const b of BINARIES) {
    await build({
      ...common,
      entryPoints: [join(root, b.in)],
      outfile: join(dist, b.out),
      banner: { js: SHEBANG },
    });
    if (b.exec) chmodSync(join(dist, b.out), 0o755);
  }

  const testDir = join(root, 'tests');
  const tests = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith('.test.ts')) : [];
  if (tests.length > 0) {
    await build({
      ...common,
      entryPoints: tests.map((f) => join(testDir, f)),
      outdir: distTests,
      outExtension: { '.js': '.mjs' },
    });
  }

  // stderr: this is diagnostic output, and `npm pack` reads stdout as data.
  process.stderr.write(`built ${BINARIES.length} binaries and ${tests.length} test bundles\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});
