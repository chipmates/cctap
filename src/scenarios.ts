/**
 * Scripted demo material for `cctap simulate`. The fixture ends at ts 16000; the
 * continuation carries the busy-day scenario to ~30 s and ends on an attention state,
 * which is the frame worth capturing.
 */

import type { NormalizedEvent } from './core/types.js';

/** Fixture cwd to a real throwaway repo, so project and branch labels are real. */
export const SIM_PROJECTS: Record<string, { project: string; branch: string }> = {
  '/repos/authsvc': { project: 'authsvc', branch: 'main' },
  '/repos/blog': { project: 'blog', branch: 'draft' },
  '/repos/infra': { project: 'infra', branch: 'tf' },
};

export const BUSY_DAY_CONTINUATION: NormalizedEvent[] = [
  { ts: 17000, sessionId: 's1', event: 'UserPromptSubmit' },
  { ts: 18000, sessionId: 's1', event: 'PreToolUse', toolName: 'Read' },
  { ts: 19000, sessionId: 's3', event: 'UserPromptSubmit' },
  { ts: 20000, sessionId: 's3', event: 'PreToolUse', toolName: 'Task' },
  { ts: 20500, sessionId: 's3', event: 'SubagentStart', agentId: 'a1' },
  { ts: 21000, sessionId: 's3', event: 'SubagentStart', agentId: 'a2' },
  {
    ts: 22000,
    sessionId: 's3',
    event: 'Notification',
    notif: 'permission_prompt',
    agentId: 'a1',
    message: 'Subagent needs permission to use Bash',
  },
  {
    ts: 23000,
    sessionId: 's1',
    event: 'Notification',
    notif: 'permission_prompt',
    message: 'Claude needs your permission to use Write',
  },
  { ts: 24000, sessionId: 's1', event: 'PreToolUse', toolName: 'Write' },
  { ts: 25000, sessionId: 's3', event: 'PreToolUse', agentId: 'a1', toolName: 'Bash' },
  { ts: 26000, sessionId: 's3', event: 'SubagentStop', agentId: 'a1' },
  { ts: 27000, sessionId: 's3', event: 'SubagentStop', agentId: 'a2' },
  { ts: 28000, sessionId: 's3', event: 'Stop' },
  {
    ts: 29000,
    sessionId: 's1',
    event: 'Notification',
    notif: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  },
  { ts: 30000, sessionId: 's2', event: 'SessionStart', source: 'resume', cwd: '/repos/blog' },
];
