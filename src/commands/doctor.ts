/**
 * `cctap doctor`: the diagnostics list. Warnings are states a user
 * can legitimately be in (not installed yet); failures are things that are broken.
 */

import * as fs from 'node:fs';
import { pingDaemon } from '../client.js';
import { usablePpid } from '../core/types.js';
import { pidAlive } from '../daemon/lock.js';
import { spoolBacklog, spoolDropped } from '../daemon/spool.js';
import { listOurs, REGISTRATIONS, type Settings } from '../install/hooks.js';
import { claudeSettingsPath, DIR_MODE, FILE_MODE, paths, readJsonFile, socketPathError } from '../paths.js';
import { loadSnapshot } from '../daemon/snapshot.js';
import { detectLocalAdapter } from '../terminal/adapter.js';
import { ownership, readInstallRecord } from './install.js';
import type { JumpRecord } from './jump.js';
import { bannersOn, notifyEnabled, NOTIFY_STATES, togglesFrom } from '../daemon/notify.js';
import { loadConfig } from '../config.js';
import { execBlocked, realExec, type Command, type Exec } from '../exec.js';
import { readJournal, statusAll, type JournalEntry } from './keys-journal.js';
import { VERSION } from '../version.js';

export type Level = 'ok' | 'info' | 'warn' | 'fail';

export interface Check {
  level: Level;
  title: string;
  detail?: string;
}

/**
 * K5: one drift line, and only when there is a journal to drift. Under CCTAP_NO_EXEC
 * nothing can be read back, so the line would be a guess and is left out entirely.
 */
export async function keysJournalCheck(o: {
  entries: JournalEntry[];
  exec: Exec;
  blocked?: boolean;
}): Promise<Check | undefined> {
  if (o.entries.length === 0 || (o.blocked ?? execBlocked())) return undefined;
  const statuses = await statusAll(o.entries, o.exec);
  const gone = statuses.filter((s) => s.state === 'gone').length;
  const changed = statuses.filter((s) => s.state === 'changed').length;
  const n = o.entries.length;
  if (gone + changed === 0) {
    return {
      level: 'ok',
      title: `${n} journaled key binding${n === 1 ? '' : 's'}, all still active`,
      detail: 'cctap keys status lists them',
    };
  }
  return {
    level: 'warn',
    title: `journaled key bindings drifted: ${gone} gone, ${changed} changed`,
    detail: 'run: cctap keys status',
  };
}

export function secureKeyboardEntryCommand(): Command {
  return { cmd: 'defaults', args: ['read', 'com.apple.Terminal', 'SecureKeyboardEntry'] };
}

/**
 * Secure Keyboard Entry swallows OS-level hotkeys aimed at terminal control, silently,
 * so a jump key that does nothing has no other symptom to go on.
 */
export async function secureKeyboardEntryCheck(o: {
  platform: string;
  exec: Exec;
  blocked?: boolean;
}): Promise<Check | undefined> {
  if (o.platform !== 'darwin' || (o.blocked ?? execBlocked())) return undefined;
  const res = await o.exec(secureKeyboardEntryCommand());
  if (res.code !== 0 || res.stdout.trim() !== '1') return undefined;
  return {
    level: 'warn',
    title: 'Terminal.app has Secure Keyboard Entry on',
    detail: 'turn it off in Terminal > Secure Keyboard Entry if the jump key does nothing',
  };
}

// info is for facts a healthy install legitimately reports; only warn and fail count.
const MARK: Record<Level, string> = { ok: 'ok  ', info: 'note', warn: 'warn', fail: 'FAIL' };

function modeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

export async function cmdDoctor(): Promise<number> {
  const p = paths();
  const checks: Check[] = [];
  const settingsFile = claudeSettingsPath();

  // 1. hooks installed, pointing at files that exist
  const settings = readJsonFile<Settings>(settingsFile);
  if (!settings) {
    checks.push({ level: 'warn', title: 'hooks not installed', detail: `no readable ${settingsFile}` });
  } else {
    const own = ownership(p);
    const ours = listOurs(settings, own.forwarder);
    // Registrations that run a cctap forwarder somewhere else: a moved CCTAP_DIR, or an
    // install that was retargeted. They still fire on every event, so they are counted
    // apart from the ones this install owns.
    const strays = ours.filter((o) => o.entry.args[0] !== own.forwarder);
    const current = ours.filter((o) => o.entry.args[0] === own.forwarder);

    if (current.length === 0) {
      checks.push({ level: 'warn', title: 'hooks not installed', detail: 'run: cctap install-hooks' });
    } else if (current.length < REGISTRATIONS.length) {
      checks.push({
        level: 'warn',
        title: `hooks partially installed (${current.length}/${REGISTRATIONS.length})`,
        detail: 'run: cctap install-hooks',
      });
    } else {
      checks.push({
        level: 'ok',
        title: `hooks installed (${current.length}/${REGISTRATIONS.length})`,
        detail: settingsFile,
      });
    }

    const deadStrays = strays.filter((o) => !fs.existsSync(o.entry.args[0] ?? ''));
    if (deadStrays.length > 0) {
      checks.push({
        level: 'fail',
        title: `${deadStrays.length} hook registration${deadStrays.length === 1 ? '' : 's'} point at a forwarder that is gone`,
        detail:
          `${deadStrays[0]?.entry.args[0]} does not exist, so every hook event forks a failing process. ` +
          'Run: cctap install-hooks, which adopts them onto this install',
      });
    } else if (strays.length > 0) {
      checks.push({
        level: 'warn',
        title: `${strays.length} hook registration${strays.length === 1 ? '' : 's'} belong to another cctap tree`,
        detail: `${strays[0]?.entry.args[0]}. Run: cctap install-hooks to adopt them, or uninstall-hooks to clear them`,
      });
    }

    const badTarget = current.filter((o) => !fs.existsSync(o.entry.args[0] ?? ''));
    if (badTarget.length > 0) {
      checks.push({
        level: 'fail',
        title: 'hook target missing',
        detail: `${badTarget[0]?.entry.args[0]} does not exist. Run: cctap install-hooks`,
      });
    }
    const badNode = [...new Set(current.map((o) => o.entry.command))].filter((c) => !fs.existsSync(c));
    if (badNode.length > 0) {
      checks.push({
        level: 'fail',
        title: 'recorded node path missing',
        detail: `${badNode.join(', ')}. Run: cctap install-hooks to heal it`,
      });
    } else if (current.length > 0) {
      checks.push({ level: 'ok', title: 'node path valid', detail: current[0]?.entry.command });
    }
  }

  // 2. install record
  const record = readInstallRecord(p);
  if (record && record.version !== VERSION) {
    checks.push({
      level: 'warn',
      title: `installed bin is ${record.version}, cli is ${VERSION}`,
      detail: 'run: cctap install-hooks',
    });
  }

  // 3. daemon alive and version-matched. A real round trip, not a stat: a socket file
  // can exist with nobody serving it, and a truncated path answers as someone else.
  const info = readJsonFile<{ pid?: number; version?: string; startedAt?: number }>(p.daemonInfo);
  const sockTooLong = socketPathError(p.sock);
  const up = sockTooLong ? false : await pingDaemon(p);
  if (up && info?.pid && pidAlive(info.pid)) {
    checks.push({ level: 'ok', title: `daemon running (pid ${info.pid})`, detail: `version ${info.version ?? '?'}` });
    if (info.version && info.version !== VERSION) {
      checks.push({
        level: 'warn',
        title: `daemon version ${info.version} differs from cli ${VERSION}`,
        detail: 'restart the daemon to pick up this build',
      });
    }
  } else if (up) {
    checks.push({
      level: 'warn',
      title: 'daemon answers but daemon.json is stale',
      detail: 'harmless; the next daemon start rewrites it',
    });
  } else if (info?.pid && pidAlive(info.pid)) {
    checks.push({
      level: 'fail',
      title: 'daemon pid alive but socket is not answering',
      detail: `kill ${info.pid}, then run any cctap command to start a fresh daemon`,
    });
  } else {
    checks.push({ level: 'warn', title: 'daemon not running', detail: 'it starts on the next hook event' });
  }

  // 4. socket and directory permissions (I5)
  const dirMode = modeOf(p.dir);
  if (dirMode === undefined) {
    checks.push({ level: 'warn', title: 'cctap dir missing', detail: p.dir });
  } else if (dirMode !== DIR_MODE) {
    checks.push({
      level: 'fail',
      title: `cctap dir mode ${dirMode.toString(8)}, want 700`,
      detail: `chmod 700 ${p.dir}`,
    });
  } else {
    checks.push({ level: 'ok', title: 'cctap dir 0700', detail: p.dir });
  }
  const sockMode = modeOf(p.sock);
  if (sockTooLong) {
    checks.push({ level: 'fail', title: 'socket path too long', detail: sockTooLong });
  } else if (sockMode !== undefined && sockMode !== FILE_MODE) {
    checks.push({
      level: 'fail',
      title: `socket mode ${sockMode.toString(8)}, want 600`,
      detail: `chmod 600 ${p.sock}, or restart the daemon which repairs modes on start`,
    });
  } else if (up) {
    checks.push({ level: 'ok', title: 'socket answers a round trip, mode 0600', detail: p.sock });
  } else if (sockMode === undefined) {
    checks.push({ level: 'warn', title: 'no socket yet', detail: p.sock });
  } else {
    checks.push({
      level: 'fail',
      title: 'socket file exists but nothing answers on it',
      detail: `rm ${p.sock}, then run any cctap command to start a fresh daemon`,
    });
  }

  // 5. terminal adapter for this shell
  const adapter = detectLocalAdapter();
  checks.push(
    adapter.kind === 'fallback'
      ? { level: 'warn', title: 'no jumpable terminal detected here', detail: 'awareness only (notification + highlight)' }
      : {
          level: adapter.liveVerified ? 'ok' : 'warn',
          title: `terminal adapter: ${adapter.label}`,
          detail: adapter.liveVerified ? undefined : 'implemented but not verified against a live terminal yet',
        },
  );

  // 5b. The exact command a global hotkey should run, quoted and absolute, so the
  // README recipe is a paste rather than an assembly job.
  const jumpLine = `"${record?.nodePath ?? process.execPath}" "${p.cliBin}" jump`;
  checks.push(
    fs.existsSync(p.cliBin)
      ? {
          level: 'ok',
          title:
            process.platform === 'darwin'
              ? 'global jump key: paste this into a Shortcuts "Run Shell Script" action'
              : 'global jump key: bind this command',
          detail: jumpLine,
        }
      : {
          level: 'warn',
          title: 'no installed cli to bind a jump key to',
          detail: `run: cctap install-hooks, which puts cctap.mjs at ${p.cliBin}`,
        },
  );

  // 5c. K5: what keys setup bound, and whether it is still bound.
  const drift = await keysJournalCheck({ entries: readJournal(p), exec: realExec });
  if (drift) checks.push(drift);

  // 6. macOS Automation consent, read from the last real jump. Probing it any other
  // way means sending an Apple event, which is the very thing that pops the dialog.
  if (process.platform === 'darwin') {
    const jump = readJsonFile<JumpRecord>(p.jump);
    if (!jump) {
      checks.push({
        level: 'warn',
        title: 'Automation consent unknown',
        detail: 'the first cctap jump asks for it once, then this line reports the answer',
      });
    } else if (jump.consent === 'denied') {
      checks.push({
        level: 'fail',
        title: 'Automation consent denied',
        detail:
          'System Settings > Privacy & Security > Automation: allow your terminal to control ' +
          `${jump.kind === 'iterm2' ? 'iTerm2' : 'Terminal'}, then jump again`,
      });
    } else if (jump.consent === 'granted') {
      checks.push({ level: 'ok', title: 'Automation consent granted', detail: `last jump: ${jump.detail}` });
    } else {
      checks.push({ level: 'warn', title: 'Automation consent unknown', detail: jump.detail });
    }
  }

  const secure = await secureKeyboardEntryCheck({ platform: process.platform, exec: realExec });
  if (secure) checks.push(secure);

  // 6a. The blanket switch, and exactly what it costs, since it is easy to leave set.
  if (execBlocked()) {
    checks.push({
      level: 'info',
      title: 'external commands blocked (CCTAP_NO_EXEC)',
      detail: 'no git branch, no tty lookup and no jump: labels fall back to the directory name',
    });
  }

  // 6b. notifications: state plus the attribution question every user asks
  const cfg = loadConfig(p);
  if (!notifyEnabled()) {
    checks.push({
      level: 'info',
      title: 'desktop banners off (CCTAP_NOTIFY)',
      detail: 'the env wins over the setting; unset it to get banners back',
    });
  } else if (!bannersOn(cfg.notify)) {
    checks.push({
      level: 'info',
      title: 'desktop banners off (the default)',
      detail: 'cctap notify on, if you want a banner as well as the strip',
    });
  } else {
    const off = NOTIFY_STATES.filter((st) => !togglesFrom(cfg.notify)[st]);
    checks.push({
      level: 'ok',
      title:
        off.length === 0
          ? 'desktop banners on for permission_wait, failed and your_turn'
          : `desktop banners on, except for: ${off.join(', ')}`,
      detail:
        process.platform === 'darwin'
          ? 'macOS attributes them to "Script Editor": that is osascript, not another app'
          : undefined,
    });
  }

  if (process.platform === 'linux' && bannersOn(cfg.notify)) {
    const found = ['/usr/bin/notify-send', '/usr/local/bin/notify-send', '/bin/notify-send'].some((c) =>
      fs.existsSync(c),
    );
    checks.push(
      found
        ? { level: 'ok', title: 'notify-send found' }
        : {
            level: 'warn',
            title: 'notify-send not found',
            detail: 'install libnotify-bin for desktop banners; until then cctap rings the terminal bell',
          },
    );
  }

  const wantTheme = process.env.CCTAP_THEME;
  if (wantTheme !== undefined && wantTheme !== 'unicode' && wantTheme !== 'ascii') {
    checks.push({
      level: 'warn',
      title: `CCTAP_THEME="${wantTheme}" is not a theme name`,
      detail: 'the two valid values are unicode and ascii; the theme is being auto-detected instead',
    });
  }

  // 7. spool backlog
  const dropped = spoolDropped(p.spool);
  if (dropped > 0) {
    checks.push({
      level: 'warn',
      title: `spool dropped ${dropped} event${dropped === 1 ? '' : 's'}`,
      detail: 'the daemon was away long enough to fill the spool; the newest were kept',
    });
  }
  const backlog = spoolBacklog(p.spool);
  if (backlog.lines === 0) {
    checks.push({ level: 'ok', title: 'spool empty' });
  } else {
    checks.push({
      level: 'warn',
      title: `spool backlog: ${backlog.lines} event${backlog.lines === 1 ? '' : 's'}`,
      detail: `${backlog.bytes} bytes in ${backlog.files} ${backlog.files === 1 ? 'file' : 'files'}, replayed on the next daemon start`,
    });
  }

  // 8. what the hooks have actually delivered, which the docs do not promise
  const snap = loadSnapshot(p.state);
  if (!snap) {
    checks.push({ level: 'warn', title: 'no events observed yet', detail: 'start a Claude Code session' });
  } else {
    // The parent pid drives liveness, so a wrong one would prune live sessions.
    const list = Object.values(snap.model.sessions);
    if (list.length > 0) {
      const alive = list.filter((s) => usablePpid(s.ppid) && pidAlive(s.ppid)).length;
      const noPpid = list.filter((s) => !usablePpid(s.ppid)).length;
      checks.push({
        level: noPpid > 0 ? 'warn' : 'ok',
        title: `${list.length} session${list.length === 1 ? '' : 's'} tracked, ${alive} with a live parent pid`,
        detail: noPpid > 0 ? `${noPpid} without a parent pid, they age out on the liveness sweep` : undefined,
      });
    }
    checks.push({
      level: snap.observed.subagentEvents ? 'ok' : 'warn',
      title: snap.observed.subagentEvents
        ? 'subagent-tagged events observed'
        : 'no subagent-tagged events observed yet',
      detail: snap.observed.subagentEvents ? undefined : 'run a session that spawns a subagent to confirm',
    });
    const env = snap.observed.envKeys;
    checks.push({
      level: env.length > 0 ? 'ok' : 'warn',
      title: env.length > 0 ? `hook env captured: ${env.join(', ')}` : 'no terminal env captured yet',
    });

    // The live-file figure above disappears with the spool the moment it is replayed.
    // This is the same number after the fact, which is when someone actually asks.
    const carried = snap.observed.spoolDropped ?? 0;
    if (carried > 0) {
      checks.push({
        level: 'warn',
        title: `${carried} event${carried === 1 ? '' : 's'} dropped by the spool since this state file was created`,
        detail: 'the daemon was away long enough to fill the spool; the newest were kept',
      });
    }

    // A subagent tree that outlived its bound was cleared so the session could read as
    // your turn again. Saying so is the difference between a fixed symptom and a fixed bug.
    const cleared = Object.values(snap.model.sessions).filter((s) => s.subagentsClearedAt !== undefined);
    if (cleared.length > 0) {
      checks.push({
        level: 'warn',
        title: `${cleared.length} session${cleared.length === 1 ? '' : 's'} had a stalled subagent count cleared`,
        detail:
          'subagent start and stop events did not pair up, so the count was released on the sweep. A Claude Code update may have changed how they are tagged',
      });
    }

    // A Claude Code update can rename or drop an event. This is how you find out.
    const seen = snap.observed.firstSeen ?? {};
    const never = REGISTRATIONS.map((r) => (r.notif ? `${r.event}(${r.notif})` : r.event)).filter(
      (name) => seen[name] === undefined,
    );
    if (never.length === 0) {
      checks.push({ level: 'ok', title: `all ${REGISTRATIONS.length} registrations have fired at least once` });
    } else {
      checks.push({
        level: 'info',
        title: `never observed: ${never.join(', ')}`,
        detail:
          'normal on a fresh install. If one of these used to fire, a Claude Code update may have changed it',
      });
    }
  }

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const oks = checks.filter((c) => c.level === 'ok').length;
  // A detail can be several lines (the socket path refusal is), and all of them indent.
  const indent = (text: string): string =>
    text
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n');
  const out = checks.map((c) => `${MARK[c.level]}  ${c.title}${c.detail ? `\n${indent(c.detail)}` : ''}`);
  out.push('');
  out.push(`${oks} ok, ${warns} warning${warns === 1 ? '' : 's'}, ${fails} failure${fails === 1 ? '' : 's'}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return fails > 0 ? 1 : 0;
}
