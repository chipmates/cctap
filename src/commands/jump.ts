/**
 * `cctap jump [session-prefix]` (and bare `cctap`, per D12).
 * Success means the terminal moved. Everything else degrades to awareness:
 * a desktop notification plus a highlight broadcast to any strip or top.
 */

import * as fs from 'node:fs';
import { getState, sendHighlight } from '../client.js';
import { baseLabel, labelSessions, sortSessions, themedLabel } from '../core/labels.js';
import { loadConfig } from '../config.js';
import { resolveTheme } from '../render/theme.js';
import { findSession, isSlotQuery, pickJumpTarget } from '../core/priority.js';
import type { WireSession } from '../core/types.js';
import { bannersOn, desktopCommand, notifyText } from '../daemon/notify.js';
import { execBlocked, realExec } from '../exec.js';
import { paths, readJsonFile, writeFileAtomic, type Paths } from '../paths.js';
import {
  adapterFor,
  createAdapters,
  type AdapterRegistry,
  type Consent,
  type FocusResult,
  type TerminalAdapter,
} from '../terminal/adapter.js';

export interface JumpRecord {
  at: number;
  kind: string;
  ok: boolean;
  consent: Consent;
  detail: string;
  /** First jump that ever landed. Monotone: a later failure never clears it. */
  firstJumpAt?: number;
}

/**
 * True once any jump on this machine has landed. A file that exists but cannot be parsed
 * counts as jumped: the teaching hint is a one-time nudge, and re-teaching someone who
 * has already jumped is worse than staying quiet.
 */
export function hasEverJumped(p: Paths): boolean {
  const record = readJsonFile<JumpRecord>(p.jump);
  if (record?.firstJumpAt !== undefined) return true;
  return record === undefined && fs.existsSync(p.jump);
}

/** doctor reads this: it is the only honest signal about Automation consent. */
export function writeJumpRecord(p: Paths, record: JumpRecord): void {
  try {
    const before = readJsonFile<JumpRecord>(p.jump);
    // An unreadable previous record still proves a jump happened if it named one, and we
    // cannot tell, so a failed rewrite must not be the thing that clears the marker.
    const hadOne = before === undefined && fs.existsSync(p.jump);
    const firstJumpAt = before?.firstJumpAt ?? (record.ok || hadOne ? record.at : undefined);
    const next: JumpRecord = firstJumpAt === undefined ? record : { ...record, firstJumpAt };
    writeFileAtomic(p.jump, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* diagnostics only */
  }
}

/** Shell-ish quoting for the dry run readout only. Nothing is ever run through a shell. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The fallback adapter has no name that reads as a subject, so it gets its own sentence. */
export function cannotFocus(adapter: TerminalAdapter, target: WireSession): string {
  const where = adapter.describeTarget(target);
  return adapter.kind === 'fallback'
    ? `no terminal here that cctap can focus (${where})`
    : `${adapter.label} could not focus it (${where})`;
}

export function reasonFor(s: WireSession): string {
  if (s.displayState === 'permission_wait') {
    if (s.subagents.blocked.length > 0 && s.state !== 'permission_wait') {
      return `subagent needs permission (${s.subagents.blocked.length})`;
    }
    switch (s.attentionKind) {
      case 'elicitation':
        return 'question waiting';
      case 'agent_needs_input':
        return 'agent needs input';
      default:
        return 'needs permission';
    }
  }
  if (s.displayState === 'failed') return s.lastMessage ? `failed (${s.lastMessage})` : 'failed';
  if (s.displayState === 'your_turn') return 'your turn';
  return s.displayState;
}

async function awarenessFallback(p: Paths, target: WireSession, label: string): Promise<void> {
  await sendHighlight(p, target.sessionId);
  // Banners are opt-in (cctap notify on). A failed jump highlights the strip and says
  // so on stdout, it never gets to pop something up the user did not ask for.
  if (!bannersOn(loadConfig(p).notify)) return;
  const cmd = desktopCommand(process.platform, notifyText(label, target));
  if (cmd) await realExec(cmd);
}

export interface JumpOutcome {
  ok: boolean;
  adapter: TerminalAdapter;
  result: FocusResult;
  /** One line fit for a status bar; the CLI prints a longer form. */
  summary: string;
}

/**
 * WezTerm's activate-pane moves focus inside the window and leaves the window where it
 * was, so a bare "jumped to" in a status bar would claim more than happened.
 */
export function jumpSummary(label: string, adapter: TerminalAdapter): string {
  return `jumped to ${label}${adapter.kind === 'wezterm' ? ' (window not raised)' : ''}`;
}

/** The CLI readout for a landing: the headline, and under it the caveat WezTerm earns. */
export function jumpSuccessOutput(label: string, adapter: TerminalAdapter, result: FocusResult): string {
  return `jumped to ${label}\n${adapter.kind === 'wezterm' ? `  ${result.detail}\n` : ''}`;
}

/**
 * The one jump path, shared by `cctap jump` and Enter inside `top`, so the two
 * can never drift on consent handling or the awareness fallback.
 */
export async function performJump(
  p: Paths,
  target: WireSession,
  label: string,
  registry: AdapterRegistry = createAdapters(),
): Promise<JumpOutcome> {
  const adapter: TerminalAdapter = adapterFor(target, registry);
  const result: FocusResult = await adapter.focus(target);

  if (adapter.kind === 'apple-terminal' || adapter.kind === 'iterm2') {
    writeJumpRecord(p, {
      at: Date.now(),
      kind: adapter.kind,
      ok: result.ok,
      consent: result.consent ?? 'unknown',
      detail: result.detail,
    });
  }

  if (result.ok) {
    // Every adapter records a landing, not just the AppleScript ones: the onboarding
    // hint retires on the first jump that worked, whatever terminal it worked in.
    if (adapter.kind !== 'apple-terminal' && adapter.kind !== 'iterm2') {
      writeJumpRecord(p, {
        at: Date.now(),
        kind: adapter.kind,
        ok: true,
        consent: result.consent ?? 'unknown',
        detail: result.detail,
      });
    }
    return { ok: true, adapter, result, summary: jumpSummary(label, adapter) };
  }

  await awarenessFallback(p, target, label);
  return { ok: false, adapter, result, summary: `${label}: ${reasonFor(target)} (${cannotFocus(adapter, target)})` };
}

/**
 * The exit codes here are a contract, and they are deliberately not "did the terminal
 * move".
 *
 * 0 covers a landing, an all-clear board, no daemon at all, and a jump that could not
 * focus anything and fell back to awareness (highlight, plus a banner when banners are
 * on). tmux `run-shell` prints a "returned N" box over the pane on any nonzero exit, so
 * a failed jump exiting nonzero would cover the screen with an error about a fallback
 * that already spoke. Silence there is the product working.
 *
 * 1 is reserved for a named target that does not exist. A script asking "is slot 3 live"
 * needs that answer, and a dead slot key saying so is correct.
 */
export async function cmdJump(args: string[]): Promise<number> {
  const p = paths();
  const sessions = await getState(p);
  if (!sessions) {
    // No socket at all is a different fact from no sessions, and doctor says it the same way.
    process.stdout.write(
      'no daemon running. It starts on the first hook event.\n' +
        '  if the hooks are not installed yet, run: cctap install-hooks\n' +
        '  cctap doctor says which of the two it is\n',
    );
    return 0;
  }
  if (sessions.length === 0) {
    process.stdout.write('all clear\n');
    return 0;
  }

  const ordered = sortSessions(sessions);
  const labels = labelSessions(ordered);
  const query = args.find((a) => !a.startsWith('-'));

  const target = query
    ? findSession(ordered, query, (s) => labels.get(s.sessionId) ?? baseLabel(s))
    : pickJumpTarget(ordered);

  if (!target) {
    if (!query) {
      process.stdout.write('all clear\n');
      return 0;
    }
    // A number is a slot, so a miss should show which numbers do exist.
    const theme = resolveTheme(process.env, loadConfig(p).theme);
    const list = ordered
      .map((s) => `  ${s.slot}  ${themedLabel(labels.get(s.sessionId) ?? baseLabel(s), theme.collisionSep)}`)
      .join('\n');
    process.stdout.write(
      isSlotQuery(query)
        ? `no session in slot ${query}\n${list}\n`
        : `no session matches "${query}"\n${list}\n`,
    );
    return 1;
  }

  const label = labels.get(target.sessionId) ?? baseLabel(target);

  if (args.includes('--dry-run')) {
    // Show the exact command without sending it: the safe pre-flight before the
    // first jump, which is also the one that asks for Automation consent.
    const adapter = adapterFor(target);
    const plan = adapter.plan(target);
    // One line per fact: an awareness-only target does not need the same sentence twice.
    process.stdout.write(
      plan.length === 0
        ? `${label}: ${reasonFor(target)}\n  ${cannotFocus(adapter, target)}, so this would notify and highlight instead\n`
        : `${label}: ${reasonFor(target)}\n  via ${adapter.label} (${adapter.describeTarget(target)})\n` +
            plan.map((c) => `  would run: ${c.cmd} ${c.args.map(quote).join(' ')}\n`).join(''),
    );
    return 0;
  }

  const { ok, adapter, result } = await performJump(p, target, label);

  if (ok) {
    process.stdout.write(jumpSuccessOutput(label, adapter, result));
    return 0;
  }

  const tool = target.currentTool ? ` [${target.currentTool}]` : '';
  const blocked = execBlocked()
    ? '  external commands disabled by CCTAP_NO_EXEC, so nothing was run\n'
    : '';
  // With no jumpable terminal, the adapter detail and reason only restate the headline.
  const why =
    adapter.kind === 'fallback' ? '' : `  ${result.detail}${result.reason ? `\n  ${result.reason}` : ''}\n`;
  const fell = adapter.kind === 'fallback' ? ', so it notified and highlighted instead' : '';
  process.stdout.write(
    `${label}: ${reasonFor(target)}${tool}\n` + `  ${cannotFocus(adapter, target)}${fell}\n` + blocked + why,
  );
  return 0;
}
