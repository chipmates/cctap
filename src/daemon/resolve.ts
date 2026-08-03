/**
 * Daemon-side side effects: branch, project label, controlling tty.
 * Resolved here and never in the forwarder, which has a 100 ms budget.
 */

import { basename } from 'node:path';
import { sanitizeText } from '../core/sanitize.js';
import { realExec, type Exec } from '../exec.js';

export const BRANCH_TTL_MS = 60 * 1000;
const EXEC_TIMEOUT_MS = 2000;

/**
 * Every command here goes through the one exec seam, so `CCTAP_NO_EXEC=1` really does
 * mean nothing is spawned. Calling execFile directly made that promise a lie: git and
 * ps ran anyway, from the daemon, on every new session.
 */
async function run(exec: Exec, cmd: string, args: string[]): Promise<string | undefined> {
  const res = await exec({ cmd, args }, { timeoutMs: EXEC_TIMEOUT_MS });
  if (res.code !== 0) return undefined;
  const out = res.stdout.trim();
  return out === '' ? undefined : out;
}

export interface RepoInfo {
  branch: string;
  root: string;
}

interface CacheEntry {
  at: number;
  info: RepoInfo;
}

export class RepoResolver {
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * One git pair in flight per cwd. Several sessions in the same directory start within
   * milliseconds of each other, and without this each one spawned its own pair.
   */
  private readonly inFlight = new Map<string, Promise<RepoInfo>>();

  constructor(
    private readonly exec: Exec = realExec,
    private readonly ttlMs = BRANCH_TTL_MS,
  ) {}

  cached(cwd: string, now: number): RepoInfo | undefined {
    const hit = this.cache.get(cwd);
    if (hit && now - hit.at < this.ttlMs) return hit.info;
    return undefined;
  }

  invalidate(cwd: string): void {
    this.cache.delete(cwd);
    // A resolve already running answers the question as it stood before the change, so
    // it must neither be joined by a later caller nor allowed to write the cache.
    this.inFlight.delete(cwd);
  }

  private async gitPair(cwd: string): Promise<RepoInfo> {
    const [branch, root] = await Promise.all([
      run(this.exec, 'git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
      run(this.exec, 'git', ['-C', cwd, 'rev-parse', '--show-toplevel']),
    ]);
    const name = sanitizeText(branch ?? '');
    return {
      // `rev-parse --abbrev-ref` prints the literal word HEAD on a detached checkout,
      // which reads on the strip as a branch someone named HEAD.
      branch: name === 'HEAD' ? 'detached' : name,
      root: sanitizeText(root ?? ''),
    };
  }

  /** `git -C <cwd> rev-parse --abbrev-ref HEAD`, cached; empty branch when not a repo. */
  async resolve(cwd: string, now: number, force = false): Promise<RepoInfo> {
    if (force) {
      this.inFlight.delete(cwd);
    } else {
      const hit = this.cached(cwd, now);
      if (hit) return hit;
      const running = this.inFlight.get(cwd);
      if (running) return running;
    }
    const pending = this.gitPair(cwd);
    this.inFlight.set(cwd, pending);
    try {
      const info = await pending;
      // Only the newest resolve owns the cache. A slow one landing after a forced
      // re-resolve used to overwrite it, and the wrong branch then showed for a TTL.
      if (this.inFlight.get(cwd) === pending) this.cache.set(cwd, { at: now, info });
      return info;
    } finally {
      if (this.inFlight.get(cwd) === pending) this.inFlight.delete(cwd);
    }
  }
}

/** basename of CLAUDE_PROJECT_DIR, else the git root, else the cwd. */
export function projectLabel(projectDir: string | undefined, repoRoot: string, cwd: string): string {
  const pick = (projectDir && projectDir !== '' ? projectDir : '') || repoRoot || cwd;
  return pick ? sanitizeText(basename(pick)) : '';
}

/**
 * Controlling tty of the Claude process, used by the macOS jump adapters.
 * macOS prints the short form (`s003`); Linux prints `pts/3`; `??` means none.
 */
export async function resolveTty(pid: number, exec: Exec = realExec): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const out = await run(exec, 'ps', ['-o', 'tty=', '-p', String(pid)]);
  return normalizeTty(out);
}

export function normalizeTty(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = sanitizeText(raw).trim();
  if (v === '' || v === '??' || v === '?' || v === '-') return undefined;
  if (/^s\d+$/.test(v)) return `tty${v}`;
  return v;
}
