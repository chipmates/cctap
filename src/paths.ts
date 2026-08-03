/**
 * Every path cctap touches. `CCTAP_DIR` relocates the whole tree (tests use this).
 * I5: the directory is 0700, every file inside is 0600.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as fs from 'node:fs';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * The kernel copies a unix socket path into a fixed sun_path field and silently
 * truncates whatever does not fit, so two long directories can end up sharing one
 * socket. darwin gives 104 bytes, linux 108 with a NUL terminator.
 */
export const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 107;

export interface Paths {
  dir: string;
  bin: string;
  spoolDir: string;
  spool: string;
  sock: string;
  state: string;
  daemonInfo: string;
  lock: string;
  config: string;
  install: string;
  jump: string;
  keys: string;
  hookForward: string;
  daemonBin: string;
  cliBin: string;
}

export function cctapDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CCTAP_DIR;
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.cctap');
}

/** Recipes that name `~/.cctap` literally only describe an install that lives there. */
export function isDefaultDir(env: NodeJS.ProcessEnv = process.env): boolean {
  return cctapDir(env) === join(homedir(), '.cctap');
}

/**
 * The socket can be moved out of the tree, because its path is the one path here with
 * a hard kernel limit. Read raw rather than through loadConfig, which needs paths().
 */
export function socketPath(dir: string): string {
  const raw = readJsonFile<{ socket?: unknown }>(join(dir, 'config.json'))?.socket;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return resolve(raw.trim().replace(/^~(?=\/|$)/, homedir()));
  }
  return join(dir, 'cctap.sock');
}

/** The refusal message for a socket path the kernel would truncate. */
export function socketPathError(sock: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bytes = Buffer.byteLength(sock);
  if (bytes <= SUN_PATH_MAX) return undefined;
  return [
    `socket path is ${bytes} bytes, over the ${SUN_PATH_MAX} byte limit this platform puts on unix sockets:`,
    `  ${sock}`,
    '  the kernel truncates a longer path, and two truncated paths answer as one socket.',
    '  fix it by pointing CCTAP_DIR at a shorter directory, or by setting "socket" to a short',
    `  path in ${join(cctapDir(env), 'config.json')}`,
  ].join('\n');
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dir = cctapDir(env);
  const bin = join(dir, 'bin');
  const spoolDir = join(dir, 'spool');
  return {
    dir,
    bin,
    spoolDir,
    spool: join(spoolDir, 'events.ndjson'),
    sock: socketPath(dir),
    state: join(dir, 'state.json'),
    daemonInfo: join(dir, 'daemon.json'),
    lock: join(dir, 'daemon.lock'),
    config: join(dir, 'config.json'),
    install: join(dir, 'install.json'),
    jump: join(dir, 'jump.json'),
    keys: join(dir, 'keys.json'),
    hookForward: join(bin, 'hook-forward.mjs'),
    daemonBin: join(bin, 'daemon.mjs'),
    cliBin: join(bin, 'cctap.mjs'),
  };
}

/**
 * How to invoke cctap on THIS machine. Our own quick start is npx, which leaves
 * nothing on PATH, so teaching a bare `cctap` at the one moment someone is ready to try
 * it hands them a command-not-found. Plain fs checks, no spawning: this runs inside a
 * status line render.
 */
export function cctapInvocation(env: NodeJS.ProcessEnv = process.env): string {
  const parts = (env.PATH ?? '').split(':').filter((d) => d !== '');
  for (const dir of parts) {
    try {
      const candidate = join(dir, 'cctap');
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return 'cctap';
    } catch {
      /* not here, keep looking */
    }
  }
  return 'npx @chipmates/cctap';
}

/** The user's Claude Code settings file. Overridable so tests never touch the real one. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CCTAP_CLAUDE_SETTINGS;
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.claude', 'settings.json');
}

export function ensureDirs(p: Paths): void {
  for (const d of [p.dir, p.bin, p.spoolDir]) {
    fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });
    repairDirMode(d);
  }
}

export function repairDirMode(dir: string): void {
  try {
    const st = fs.statSync(dir);
    if ((st.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort */
  }
}

/** I5: the daemon verifies and repairs modes on start. */
export function repairAllModes(p: Paths): void {
  for (const d of [p.dir, p.bin, p.spoolDir]) repairDirMode(d);
  for (const f of [p.state, p.daemonInfo, p.lock, p.config, p.install, p.jump, p.keys, p.spool, p.sock]) {
    repairFileMode(f);
  }
  try {
    for (const name of fs.readdirSync(p.bin)) repairFileMode(join(p.bin, name));
    for (const name of fs.readdirSync(p.spoolDir)) repairFileMode(join(p.spoolDir, name));
  } catch {
    /* best effort */
  }
}

export function repairFileMode(file: string): void {
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o777) !== FILE_MODE) fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best effort */
  }
}

/** I8: tmp + rename, so a reader never sees half a file. */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  repairFileMode(file);
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
