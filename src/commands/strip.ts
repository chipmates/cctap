/**
 * `cctap strip`: the always-visible one-liner. Renders on state change plus a capped
 * spinner tick, and the tick stops entirely when nothing is working, which is how the
 * CPU budget is met.
 */

import { ansi, attrsEnabled, BEL, colorEnabled, cursorUp, sgr, visibleWidth } from '../ansi.js';
import { getState, subscribePersistent } from '../client.js';
import { baseLabel, labelSessions, sortSessions } from '../core/labels.js';
import { performJump } from './jump.js';
import { keyIntent } from '../terminal/keys.js';
import { hasEverJumped } from './jump.js';
import { loadConfig } from '../config.js';
import type { WireSession } from '../core/types.js';
import { cctapInvocation, paths } from '../paths.js';
import { HIGHLIGHT_MS } from '../proto.js';
import {
  DAEMON_UNREACHABLE,
  onboardingHint,
  padRows,
  renderStripLayout,
  shouldAnimate,
  spinnerFrameAt,
  type StripLayout,
} from '../render/strip.js';
import { blinkEnabled, resolveTheme } from '../render/theme.js';

/** 8 fps: fast enough to read as motion, slow enough to stay invisible in top. */
const FRAME_MS = 125;
const DEFAULT_WIDTH = 80;

function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols > 0) return cols;
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_WIDTH;
}

function parseRows(args: readonly string[]): number {
  const inline = args.find((a) => a.startsWith('--rows='));
  if (inline) return Number.parseInt(inline.slice('--rows='.length), 10) === 2 ? 2 : 1;
  const i = args.indexOf('--rows');
  if (i >= 0 && args[i + 1] === '2') return 2;
  return 1;
}

/** Bounded, quick and silent: a status line must render whatever arrives on stdin. */
const STDIN_WAIT_MS = 60;
const STDIN_MAX_CHARS = 64 * 1024;

function readPipedSessionId(): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(undefined);
      return;
    }
    let buf = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      try {
        const parsed = JSON.parse(buf) as { session_id?: unknown };
        const id = parsed?.session_id;
        resolve(typeof id === 'string' && id !== '' ? id : undefined);
      } catch {
        resolve(undefined);
      }
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > STDIN_MAX_CHARS) finish();
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    } catch {
      finish();
    }
  });
}

export async function cmdStrip(args: string[]): Promise<number> {
  const p = paths();
  const rows = parseRows(args);
  const cfg = loadConfig(p);
  const theme = resolveTheme(process.env, cfg.theme);
  const noColorFlag = args.includes('--no-color');
  const color = !noColorFlag && colorEnabled();
  const attrs = !noColorFlag && attrsEnabled();
  const blink = blinkEnabled(process.env, cfg.blink);

  if (!process.stdout.isTTY) {
    // Claude Code pipes its session JSON into a status line command, which is how the
    // strip knows which entry is the reader's own. A tmux bar pipes nothing, and that
    // is fine: no stdin, no marker, byte-identical output.
    const [state, current] = await Promise.all([getState(p), readPipedSessionId()]);
    // A silent socket is not a calm board: persisted state may hold blocked sessions,
    // and nothing revives the daemon until a hook event arrives or a human acts.
    if (state === undefined) {
      process.stdout.write(`${padRows([DAEMON_UNREACHABLE], rows).join('\n')}\n`);
      return 0;
    }
    const sessions = state;
    // An empty snapshot used to be a blank line, which reads as broken rather than idle.
    if (sessions.length === 0) {
      const said = ['no sessions yet', 'hooks are picked up live, and cctap doctor checks hooks, daemon and socket'];
      // A snapshot owns exactly `rows` lines: embedding recipes count them.
      process.stdout.write(`${padRows(rows === 1 ? [said.join('. ')] : said, rows).join('\n')}\n`);
      return 0;
    }
    // Piped output stays plain, but a forced colour env means someone is embedding this
    // where escapes render: a Claude Code status line, or a bar that asks for them.
    // Snapshot mode still writes exactly `rows` lines: embedding recipes count them.
    const { lines } = renderStripLayout(sessions, {
      width: terminalWidth(),
      rows,
      theme,
      // No ticker here, so the clock carries the spin: a status line that re-runs every
      // couple of seconds animates instead of freezing on one frame.
      frame: spinnerFrameAt(Date.now()),
      color,
      attrs,
      current,
    });
    const out = padRows(lines, rows);
    // Taught once, on the surface a new user actually looks at, and only while something
    // is waiting on them. It retires for good the first time a jump lands.
    if (!hasEverJumped(p)) {
      const hint = onboardingHint(sessions, cctapInvocation());
      const first = out[0] ?? '';
      if (hint && visibleWidth(first) + hint.length + 3 <= terminalWidth()) {
        out[0] = `${first} · ${attrs ? sgr([2], hint) : hint}`;
      }
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }

  let sessions: WireSession[] = (await getState(p)) ?? [];
  let frame = 0;
  let highlight: string | undefined;
  let highlightTimer: NodeJS.Timeout | undefined;
  // Carried across repaints so projects keep their row (the stability rule).
  let layout: StripLayout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let firstFrame = true;
  const out = process.stdout;

  out.write(ansi.hideCursor);

  // A blank strip is indistinguishable from a broken one, so it says what it waits for.
  const idleLine = (): string => {
    const text = 'cctap: waiting for sessions'.slice(0, Math.max(terminalWidth(), 1));
    return attrs ? `${ansi.dim}${text}${ansi.reset}` : text;
  };

  // Short-lived text appended to the strip: the answer to a keypress, shown where the
  // eyes already are rather than in a scrollback nobody is watching.
  let notice: string | undefined;
  let noticeTimer: NodeJS.Timeout | undefined;
  const say = (text: string, ms = 2500): void => {
    notice = text;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = undefined;
      draw();
    }, ms);
    noticeTimer.unref();
    draw();
  };

  const draw = (): void => {
    const render = renderStripLayout(
      sessions,
      { width: terminalWidth(), rows, theme, frame, color, attrs, blink, highlight },
      layout,
    );
    layout = render.layout;
    const lines = padRows(render.lines, rows);
    if (sessions.length === 0) lines[0] = idleLine();
    if (notice) {
      const room = terminalWidth() - visibleWidth(lines[0] ?? '') - 3;
      if (room > 0) {
        const text = notice.slice(0, room);
        lines[0] = `${lines[0] ?? ''} · ${attrs ? sgr([2], text) : text}`;
      }
    }
    let text = firstFrame || rows === 1 ? '' : cursorUp(rows - 1);
    text += '\r';
    text += lines.map((l) => ansi.clearLine + l).join('\r\n');
    out.write(text);
    firstFrame = false;
  };

  const syncTicker = (): void => {
    if (shouldAnimate(sessions) && !ticker) {
      ticker = setInterval(() => {
        frame += 1;
        draw();
      }, FRAME_MS);
      ticker.unref();
    } else if (!shouldAnimate(sessions) && ticker) {
      // Nothing is spinning, so stop burning wakeups.
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const link = subscribePersistent(p, {
    onState: (next) => {
      sessions = next;
      syncTicker();
      draw();
    },
    onLink: (up) => {
      if (!up) {
        sessions = [];
        syncTicker();
        draw();
      }
    },
    onMessage: (msg) => {
      if (msg.kind === 'highlight' && typeof msg.sessionId === 'string') {
        highlight = msg.sessionId;
        if (highlightTimer) clearTimeout(highlightTimer);
        highlightTimer = setTimeout(
          () => {
            highlight = undefined;
            draw();
          },
          typeof msg.ms === 'number' ? msg.ms : HIGHLIGHT_MS,
        );
        highlightTimer.unref();
        draw();
      } else if (msg.kind === 'bell') {
        out.write(BEL);
      }
    },
  });

  const quit = (code: number): void => {
    if (ticker) clearInterval(ticker);
    if (highlightTimer) clearTimeout(highlightTimer);
    if (noticeTimer) clearTimeout(noticeTimer);
    link.close();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* already gone */
      }
    }
    process.stdin.pause();
    out.write(`${ansi.showCursor}\n`);
    process.exit(code);
  };

  /**
   * The number under the glyph is the jump handle, so in a live pane it is also the key.
   * The pane keeps rendering afterwards: focus moves to the session, this strip stays.
   */
  const jumpToSlot = async (slot: number): Promise<void> => {
    const target = sessions.find((x) => x.slot === slot);
    if (!target) {
      say(`no session ${slot}`);
      return;
    }
    const label = labelSessions(sortSessions(sessions)).get(target.sessionId) ?? baseLabel(target);
    say(`jumping to ${label}...`, 10_000);
    const outcome = await performJump(p, target, label);
    say(outcome.summary);
  };

  // Keys come off stdin whatever it is. A terminal gives them instantly through raw
  // mode; anything else delivers them a line at a time, which is enough to drive.
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      const intent = keyIntent(chunk);
      if (intent?.kind === 'quit') quit(0);
      else if (intent?.kind === 'slot') void jumpToSlot(intent.slot);
    });
  } catch {
    // A pane with no usable stdin still renders; it just has no keys.
  }

  process.stdout.on('resize', draw);
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));

  syncTicker();
  draw();
  return new Promise<number>(() => {
    /* runs until the pane closes */
  });
}
