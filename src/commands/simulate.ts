/**
 * `cctap simulate <scenario>`: replays a bundled fixture through the real socket at
 * accelerated wall-clock. Dev tool, end-to-end test and README capture in one.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import busyDay from '../../spec/fixtures/busy-day.json';
import delegatedTurn from '../../spec/fixtures/delegated-turn.json';
import elicitation from '../../spec/fixtures/elicitation.json';
import idleUpgrade from '../../spec/fixtures/idle-upgrade-only.json';
import subagentBookkeeping from '../../spec/fixtures/subagent-bookkeeping.json';
import subagentPermission from '../../spec/fixtures/subagent-permission.json';
import { connect, ensureDaemon } from '../client.js';
import type { NormalizedEvent } from '../core/types.js';
import { realExec } from '../exec.js';
import { paths } from '../paths.js';
import { encodeLine, PROTOCOL_VERSION } from '../proto.js';
import { BUSY_DAY_CONTINUATION, SIM_PROJECTS } from '../scenarios.js';



export interface Fixture {
  name: string;
  description?: string;
  events: NormalizedEvent[];
  expect?: Record<string, string>[];
}

export const FIXTURES: Record<string, Fixture> = {
  'busy-day': busyDay as unknown as Fixture,
  'delegated-turn': delegatedTurn as unknown as Fixture,
  elicitation: elicitation as unknown as Fixture,
  'idle-upgrade-only': idleUpgrade as unknown as Fixture,
  'subagent-bookkeeping': subagentBookkeeping as unknown as Fixture,
  'subagent-permission': subagentPermission as unknown as Fixture,
};

/** Fixture cwds are fictional; the demo gets real ones so branch resolution is real. */
async function materializeRepos(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const [fixtureCwd, spec] of Object.entries(SIM_PROJECTS)) {
    const dir = join(root, spec.project);
    map.set(fixtureCwd, dir);
    if (fs.existsSync(join(dir, '.git'))) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Through the seam like everything else, so CCTAP_NO_EXEC really spawns nothing.
      await realExec({ cmd: 'git', args: ['-C', dir, 'init', '-q', '-b', spec.branch] });
      await realExec({
        cmd: 'git',
        args: [
          '-C', dir,
          '-c', 'user.email=cctap@localhost',
          '-c', 'user.name=cctap',
          'commit', '-q', '--allow-empty', '-m', 'init',
        ],
      });
    } catch {
      // No git here: labels degrade to the project name, the demo still runs.
    }
  }
  return map;
}

function hookPayload(ev: NormalizedEvent, cwd: string, projectDir: string): Record<string, unknown> {
  const hook: Record<string, unknown> = {
    session_id: ev.sessionId,
    hook_event_name: ev.event,
    cwd,
    transcript_path: join(projectDir, '.transcript.jsonl'),
    permission_mode: 'default',
  };
  if (ev.agentId) hook.agent_id = ev.agentId;
  if (ev.toolName) hook.tool_name = ev.toolName;
  if (ev.source) hook.source = ev.source;
  if (ev.message) hook.message = ev.message;
  if (ev.reason) hook.reason = ev.reason;
  return hook;
}

export async function cmdSimulate(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith('-'));
  const speedArg = args.find((a) => a.startsWith('--speed='));
  const speed = speedArg ? Math.max(0.01, Number.parseFloat(speedArg.slice('--speed='.length))) : 1;
  const quiet = args.includes('--quiet');

  // Bare `cctap simulate` used to start busy-day silently, which reads as a hang.
  if (name === undefined) {
    // Names and sizes only: the fixture descriptions are spec prose, not user copy.
    const list = Object.entries(FIXTURES).map(([key, f]) => `  ${key.padEnd(21)}${f.events.length} events`);
    process.stdout.write(
      ['scenarios you can replay:', ...list, '', 'pick one, for example: cctap simulate busy-day'].join('\n') + '\n',
    );
    return 0;
  }

  const fixture = FIXTURES[name];
  if (!fixture) {
    process.stderr.write(`cctap: unknown scenario "${name}". Known: ${Object.keys(FIXTURES).join(', ')}\n`);
    return 1;
  }

  const p = paths();
  if (!(await ensureDaemon(p))) {
    process.stderr.write('cctap: could not reach or start the daemon\n');
    return 1;
  }

  const events: NormalizedEvent[] =
    name === 'busy-day' ? [...fixture.events, ...BUSY_DAY_CONTINUATION] : [...fixture.events];

  const repos = await materializeRepos(join(p.dir, 'sim'));
  const sock = await connect(p.sock);
  // A daemon that dies mid-replay leaves the rest of the events in the void, so the
  // socket's fate is watched rather than assumed.
  let socketError: Error | undefined;
  sock.on('error', (err: Error) => (socketError ??= err));
  sock.on('close', () => (socketError ??= new Error('the daemon closed the connection')));
  if (!quiet) process.stdout.write(`replaying ${name}, watch it with: cctap strip\n\n`);

  const first = events[0]?.ts ?? 0;
  const cwdBySession = new Map<string, string>();
  const started = Date.now();
  let sent = 0;

  for (const ev of events) {
    const wait = Math.max(0, (ev.ts - first) / speed - (Date.now() - started));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    if (ev.cwd) cwdBySession.set(ev.sessionId, repos.get(ev.cwd) ?? ev.cwd);
    const cwd = cwdBySession.get(ev.sessionId) ?? '';
    const tag: { event: string; notif?: string } = { event: ev.event };
    if (ev.notif) tag.notif = ev.notif;

    if (socketError) {
      process.stderr.write(`cctap: the daemon stopped listening after ${sent} events: ${socketError.message}\n`);
      return 1;
    }
    sock.write(
      encodeLine({
        v: PROTOCOL_VERSION,
        kind: 'event',
        ts: Date.now(),
        tag,
        hook: hookPayload(ev, cwd, cwd),
        env: { CLAUDE_PROJECT_DIR: cwd, TERM_PROGRAM: process.env.TERM_PROGRAM ?? '' },
        ppid: process.pid,
      }),
    );
    sent += 1;
    if (!quiet) {
      const suffix = ev.notif ? `(${ev.notif})` : ev.toolName ? `(${ev.toolName})` : '';
      process.stdout.write(`${ev.sessionId}  ${ev.event} ${suffix}\n`);
    }
  }

  // Let the daemon drain before the socket closes.
  await new Promise((r) => setTimeout(r, 100));
  if (socketError) {
    process.stderr.write(`cctap: the daemon stopped listening after ${sent} events: ${socketError.message}\n`);
    return 1;
  }
  sock.end();
  if (!quiet) process.stdout.write(`\nreplayed ${sent} events from "${name}"\n`);
  return 0;
}
