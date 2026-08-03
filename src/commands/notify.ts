/**
 * `cctap notify [on|off]`. Desktop banners are the one thing cctap does outside the
 * terminal, so they are opt in and the switch is a command rather than a doc snippet.
 */

import * as fs from 'node:fs';
import { loadConfig } from '../config.js';
import { notifyEnabled } from '../daemon/notify.js';
import { ensureDirs, paths, readJsonFile, writeFileAtomic, type Paths } from '../paths.js';

/** Rewrites one key and leaves every other key in the file exactly as it was. */
export class ConfigUnreadable extends Error {}

export function setBannersInConfig(p: Paths, on: boolean): void {
  const raw = readJsonFile<Record<string, unknown>>(p.config);
  // Rewriting a file we cannot read would throw away whatever else is in it, including
  // the socket escape hatch someone needed to make cctap work at all.
  if (raw === undefined && fs.existsSync(p.config)) throw new ConfigUnreadable(p.config);
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const before = root.notify;
  const notify = before && typeof before === 'object' && !Array.isArray(before) ? { ...before } : {};
  (notify as Record<string, unknown>).enabled = on;
  root.notify = notify;
  ensureDirs(p);
  writeFileAtomic(p.config, `${JSON.stringify(root, null, 2)}\n`);
}

export async function cmdNotify(args: string[]): Promise<number> {
  const p = paths();
  const want = args.find((a) => !a.startsWith('-'));
  const forcedOff = !notifyEnabled();
  // The SETTING, not the setting combined with the env. Comparing against the combined
  // value made `notify off` a silent no-op whenever CCTAP_NOTIFY=off was exported, and
  // `notify on` never able to say it was already on.
  const on = loadConfig(p).notify?.enabled === true;

  if (want === undefined) {
    process.stdout.write(`desktop banners are ${on ? 'on' : 'off'}\n`);
    if (forcedOff) process.stdout.write('  CCTAP_NOTIFY is set to off, which wins over this setting\n');
    process.stdout.write(`  turn them ${on ? 'off' : 'on'} with: cctap notify ${on ? 'off' : 'on'}\n`);
    return 0;
  }
  if (want !== 'on' && want !== 'off') {
    process.stderr.write(`cctap: notify takes on or off, not "${want}"\n`);
    return 1;
  }

  const next = want === 'on';
  if (next === on && fs.existsSync(p.config)) {
    process.stdout.write(`desktop banners were already ${want}\n`);
    return 0;
  }
  try {
    setBannersInConfig(p, next);
  } catch (err) {
    if (!(err instanceof ConfigUnreadable)) throw err;
    process.stderr.write(
      `cctap: cannot parse ${p.config} as JSON. Nothing was changed.\n` +
        '  Fix the file by hand, or delete it to start from defaults.\n',
    );
    return 1;
  }
  process.stdout.write(`desktop banners ${want}\n  ${p.config}\n`);
  if (next && forcedOff) process.stdout.write('  CCTAP_NOTIFY is set to off, so nothing shows until you unset it\n');
  process.stdout.write('  the running daemon picks this up when it restarts: cctap stop\n');
  return 0;
}
