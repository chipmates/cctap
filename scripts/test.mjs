#!/usr/bin/env node
/**
 * Runs the built test bundles with a deadline on every test, and one on the whole run.
 * Node's runner waits forever by default: a socket test that wedges on a slow CI box
 * hangs the job instead of failing it, which is how a 20 minute ubuntu run happened.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Generous: the whole suite normally finishes in about three seconds. */
const PER_TEST_MS = 30_000;
const WHOLE_RUN_MS = 5 * 60_000;

/** The same dial the tests use, so a slow machine does not trip the caps either. */
const slackRaw = Number.parseFloat(process.env.CCTAP_TEST_SLACK ?? '');
const SLACK = Number.isFinite(slackRaw) && slackRaw >= 1 ? slackRaw : 1;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distTests = join(root, 'dist', 'tests');

/** `--test-timeout` landed in 20.11.0 and 21.2.0; older runners get the outer watchdog. */
function supportsTestTimeout() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 21) return true;
  if (major === 21) return minor >= 2;
  if (major === 20) return minor >= 11;
  return false;
}

if (!existsSync(distTests)) {
  process.stderr.write('no dist/tests: run the build first\n');
  process.exit(1);
}
const files = readdirSync(distTests)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(distTests, f));
if (files.length === 0) {
  process.stderr.write('no test bundles in dist/tests\n');
  process.exit(1);
}

const args = ['--test'];
if (supportsTestTimeout()) args.push(`--test-timeout=${Math.round(PER_TEST_MS * SLACK)}`);
args.push(...files);

const child = spawn(process.execPath, args, { stdio: 'inherit' });

const wholeRunMs = Math.round(WHOLE_RUN_MS * SLACK);
const watchdog = setTimeout(() => {
  process.stderr.write(`\ntest run exceeded ${wholeRunMs / 1000}s, killing it\n`);
  child.kill('SIGKILL');
  process.exit(1);
}, wholeRunMs);

child.on('error', (err) => {
  clearTimeout(watchdog);
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  clearTimeout(watchdog);
  process.exit(signal ? 1 : (code ?? 1));
});
