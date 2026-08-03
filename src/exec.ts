/**
 * The one seam through which cctap runs an external command. Everything above it
 * builds argv purely, so command construction is unit-testable without ever
 * touching osascript, notify-send or tmux.
 */

import { execFile } from 'node:child_process';

export interface Command {
  cmd: string;
  args: string[];
  /** Written to the child's stdin and closed. Some tools only take input that way. */
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: Command, opts?: { timeoutMs?: number }) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Hard stop for tests, CI and anyone who wants cctap to touch nothing: with
 * `CCTAP_NO_EXEC=1` no external command is ever spawned, from any code path.
 */
export function execBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CCTAP_NO_EXEC;
  return v !== undefined && v !== '' && v !== '0';
}

/** Never rejects: a missing binary is a result with a non-zero code, not a crash. */
export const realExec: Exec = (command, opts = {}) =>
  new Promise((resolve) => {
    if (execBlocked()) {
      resolve({ code: 127, stdout: '', stderr: 'cctap: CCTAP_NO_EXEC is set, command not run' });
      return;
    }
    try {
      const child = execFile(
        command.cmd,
        command.args,
        { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
        },
      );
      if (command.input !== undefined) child.stdin?.end(command.input);
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err) });
    }
  });

/** Records calls and answers from a script. Tests only. */
export function recordingExec(
  answers: (command: Command) => ExecResult = () => ({ code: 0, stdout: '', stderr: '' }),
): Exec & { calls: Command[] } {
  const calls: Command[] = [];
  const fn = (command: Command): Promise<ExecResult> => {
    calls.push({ cmd: command.cmd, args: [...command.args], ...(command.input === undefined ? {} : { input: command.input }) });
    return Promise.resolve(answers(command));
  };
  return Object.assign(fn, { calls });
}
