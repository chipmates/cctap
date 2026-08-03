/** `cctap status`: one plain line for tmux status-right or a Claude Code status line. */

import { getState } from '../client.js';
import { paths } from '../paths.js';
import { DAEMON_UNREACHABLE, statusText } from '../render/strip.js';

export async function cmdStatus(): Promise<number> {
  const sessions = await getState(paths());
  // Plain text only, never ANSI: this string ends up inside someone else's bar.
  // `undefined` means the socket did not answer, which is not the same as no sessions.
  process.stdout.write(`${sessions === undefined ? DAEMON_UNREACHABLE : statusText(sessions)}\n`);
  return 0;
}
