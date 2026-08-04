/**
 * Every path cctap touches. `CCTAP_DIR` relocates the whole tree (tests use this).
 * I5: the directory is 0700, every file inside is 0600.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as fs from 'node:fs';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * The kernel copies a unix socket path into a fixed sun_path field and silently
 * truncates whatever does not fit, so two long directories can end up sharing one
 * socket. The field is 104 bytes on darwin and 108 on linux, and both counts include
 * the NUL terminator, so the longest usable path is one byte short of each.
 */
export const SUN_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

export interface Paths {
  dir: string;
  bin: string;
  spoolDir: string;
  spool: string;
  sim: string;
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

/**
 * `~` expands the way the config'd socket path already expands it. Past that the
 * override has to be absolute: a relative one resolves against each process's cwd, and
 * hooks run with the project's cwd, so an exported relative value quietly gives every
 * project its own tree and its own daemon with nothing anywhere saying so. Refusing is
 * the only answer that cannot be wrong: resolving once and persisting still leaves the
 * first process resolving somewhere else.
 */
export function cctapDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CCTAP_DIR;
  if (override === undefined || override.trim() === '') return join(homedir(), '.cctap');

  const expanded = override.trim().replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(expanded)) {
    throw new Error(
      `CCTAP_DIR must be an absolute path, and "${override}" is relative: it would resolve ` +
        'against whatever directory each process happens to start in.',
    );
  }
  const dir = resolve(expanded);
  // The purge and the mode repair both walk this directory, so a home directory and a
  // filesystem root are refused. On real paths, not on the spelling: a symlink, a
  // /private prefix and a bind mount all reach the same directory a string test misses.
  const real = realPath(dir);
  if (real === realPath('/') || real === realPath(homedir())) {
    const alias = real === dir ? '' : ` (it is "${real}")`;
    throw new Error(
      `CCTAP_DIR must be a directory of its own, and "${dir}" is not${alias}: cctap owns everything under it.`,
    );
  }
  return dir;
}

/**
 * The real path where one exists, the resolved literal where it does not: a path that
 * cannot be walked is also not the home directory or the root, which both always exist.
 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return resolve(p);
  }
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
    spool: join(spoolDir, SPOOL_FILE),
    sim: join(dir, 'sim'),
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

/** The bundled scripts the installer copies into `bin/`. */
export const BIN_FILES = ['hook-forward.mjs', 'daemon.mjs', 'cctap.mjs'] as const;

/** The live spool inside `spool/`. Rotated segments hang off this name. */
export const SPOOL_FILE = 'events.ndjson';

/**
 * `CCTAP_DIR` can name a directory that is already full of someone else's files, so
 * everything that walks `bin/` and `spool/` (the purge, the mode repair) asks these two
 * first and leaves every other name exactly as it found it.
 */
export function isOurBinFile(name: string): boolean {
  for (const bin of BIN_FILES) {
    if (name === bin) return true;
    // An install copies through `.<name>.tmp-<pid>`, and a crash before the rename leaves it.
    const tmp = `.${bin}.tmp-`;
    if (name.startsWith(tmp) && /^\d+$/.test(name.slice(tmp.length))) return true;
  }
  return false;
}

/**
 * The live spool and the `.replaying-<stamp>-<pid>` segments daemon/spool.ts renames it
 * into. Stricter than the spool's own glob on purpose: a segment this misses survives a
 * purge and keeps the directory alive, while a name matched too broadly is a file gone.
 */
export function isOurSpoolFile(name: string): boolean {
  if (name === SPOOL_FILE) return true;
  const claim = `${SPOOL_FILE}.replaying-`;
  return name.startsWith(claim) && /^\d+-\d+$/.test(name.slice(claim.length));
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
  // Only the names cctap writes. Chmodding every entry took the exec bit off every
  // program in the directory when CCTAP_DIR named one that was already someone's bin.
  try {
    for (const name of fs.readdirSync(p.bin)) if (isOurBinFile(name)) repairFileMode(join(p.bin, name));
  } catch {
    /* best effort */
  }
  try {
    for (const name of fs.readdirSync(p.spoolDir)) if (isOurSpoolFile(name)) repairFileMode(join(p.spoolDir, name));
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

/**
 * I8: tmp + rename, so a reader never sees half a file. `wx` refuses to write through
 * a temp name that already exists, and a write that throws takes its own leftovers with
 * it rather than leaving them beside the real file forever.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, { mode: FILE_MODE, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already renamed into place */
    }
    throw err;
  }
  repairFileMode(file);
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
