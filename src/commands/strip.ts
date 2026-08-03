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
import { loadConfig, motionEnabled } from '../config.js';
import type { WireSession } from '../core/types.js';
import { cutToWidth } from '../core/width.js';
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
  type StripRender,
} from '../render/strip.js';
import { blinkEnabled, resolveTheme, type Theme } from '../render/theme.js';

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

/** What both live surfaces say when the daemon link is down. */
export const STALE_MARK = 'daemon down, state unknown';
/** The same fact for a pane too narrow to carry the sentence beside a board. */
const STALE_MARK_SHORT = 'daemon down';
/** Columns the board keeps for itself. Below this the marker yields, the board never does. */
const MIN_BOARD = 12;
const SEP = ' · ';

function staleMark(width: number): string | undefined {
  if (width >= STALE_MARK.length + SEP.length + MIN_BOARD) return STALE_MARK;
  if (width >= STALE_MARK_SHORT.length + SEP.length + MIN_BOARD) return STALE_MARK_SHORT;
  return undefined;
}

/** What the pane believes, and whether anything still confirms it. */
export interface PaneBoard {
  sessions: WireSession[];
  stale: boolean;
}

/**
 * A dropped link marks the board, it never empties it. A daemon that dies mid permission
 * prompt would otherwise repaint as an idle strip, which is the calm it is not (I19).
 */
export function linkChanged(board: PaneBoard, up: boolean): PaneBoard {
  return { sessions: board.sessions, stale: !up };
}

export interface PaneOptions {
  width: number;
  rows: number;
  theme: Theme;
  frame?: number;
  color?: boolean;
  attrs?: boolean;
  blink?: boolean;
  /** Off freezes the spinner, so consecutive frames are byte identical. */
  motion?: boolean;
  highlight?: string;
  /** Short-lived answer to a keypress, appended to row one. */
  notice?: string;
}

export interface PaneFrame {
  lines: string[];
  layout: StripLayout;
}

/** One live-pane frame. Pure, so the pane's rules are testable without a terminal. */
export function livePaneFrame(board: PaneBoard, opts: PaneOptions, previous?: StripLayout): PaneFrame {
  const width = Math.max(1, opts.width);
  const attrs = opts.attrs === true;
  const dim = (text: string): string => (attrs ? sgr([2], text) : text);
  const layout = (w: number): StripRender =>
    renderStripLayout(
      board.sessions,
      {
        width: w,
        rows: opts.rows,
        theme: opts.theme,
        frame: opts.frame,
        color: opts.color,
        attrs: opts.attrs,
        blink: opts.blink,
        motion: opts.motion,
        highlight: opts.highlight,
      },
      previous,
    );
  let render = layout(width);
  let mark: string | undefined;
  if (board.stale) {
    // Slack on the line is the marker's first choice, and it costs the board nothing.
    const slack = width - visibleWidth(render.lines[0] ?? '') - SEP.length;
    if (slack >= STALE_MARK.length) mark = STALE_MARK;
    else {
      // Otherwise the board cedes the room, one step down its own fitting ladder rather
      // than a wrapped line.
      mark = staleMark(width);
      if (mark && slack < mark.length) render = layout(Math.max(1, width - mark.length - SEP.length));
    }
  }
  const lines = padRows(render.lines, opts.rows);
  if (board.sessions.length === 0) {
    // A blank strip is indistinguishable from a broken one, so it says what it waits for,
    // and nothing known is not the same fact as nothing running.
    lines[0] = dim(cutToWidth(board.stale ? `cctap: ${STALE_MARK}` : 'cctap: waiting for sessions', width));
  } else if (mark) {
    lines[0] = `${lines[0] ?? ''}${SEP}${dim(mark)}`;
  }
  if (opts.notice) {
    const room = width - visibleWidth(lines[0] ?? '') - SEP.length;
    if (room > 0) lines[0] = `${lines[0] ?? ''}${SEP}${dim(cutToWidth(opts.notice, room))}`;
  }
  return { lines, layout: render.layout };
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
  const motion = motionEnabled(process.env, cfg.motion);

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
      motion,
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

  // A daemon that is already down at startup is an unknown board, not an empty one.
  const known = await getState(p);
  let board: PaneBoard = { sessions: known ?? [], stale: known === undefined };
  let frame = 0;
  let highlight: string | undefined;
  let highlightTimer: NodeJS.Timeout | undefined;
  // Carried across repaints so projects keep their row (the stability rule).
  let layout: StripLayout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let firstFrame = true;
  /** True until the pane takes the terminal, and again the moment it hands it back. */
  let restored = true;
  const out = process.stdout;

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
    // A timer that fires while the pane is handed back must not write over the shell.
    if (restored) return;
    const render = livePaneFrame(
      board,
      { width: terminalWidth(), rows, theme, frame, color, attrs, blink, motion, highlight, notice },
      layout,
    );
    layout = render.layout;
    let text = firstFrame || rows === 1 ? '' : cursorUp(rows - 1);
    text += '\r';
    text += render.lines.map((l) => ansi.clearLine + l).join('\r\n');
    out.write(text);
    firstFrame = false;
  };

  // A stale board never spins: motion there would claim a liveness the link cannot back.
  const syncTicker = (): void => {
    const animate = !restored && shouldAnimate(board.sessions, motion && !board.stale);
    if (animate && !ticker) {
      ticker = setInterval(() => {
        frame += 1;
        draw();
      }, FRAME_MS);
      ticker.unref();
    } else if (!animate && ticker) {
      // Nothing is spinning, so stop burning wakeups.
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const link = subscribePersistent(p, {
    onState: (next) => {
      board = { sessions: next, stale: false };
      syncTicker();
      draw();
    },
    onLink: (up) => {
      board = linkChanged(board, up);
      syncTicker();
      draw();
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

  /** Hands the pane back: raw mode off, cursor visible, no ticker left running. */
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* already gone */
    }
    process.stdin.pause();
    try {
      out.write(`${ansi.showCursor}\n`);
    } catch {
      /* SIGHUP is the terminal itself leaving, so the write can fail */
    }
  };

  /** Take the pane. Also the way back in after a stop handed it to the shell. */
  const enter = (): void => {
    restored = false;
    // Keys come off stdin whatever it is. A terminal gives them instantly through raw
    // mode; anything else delivers them a line at a time, which is enough to drive.
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch {
      // A pane with no usable stdin still renders; it just has no keys.
    }
    process.stdin.resume();
    try {
      out.write(ansi.hideCursor);
    } catch {
      /* ignore */
    }
    // The shell wrote over the pane while we were stopped, so start from where we are.
    firstFrame = true;
    syncTicker();
    draw();
  };

  const quit = (code: number): void => {
    if (highlightTimer) clearTimeout(highlightTimer);
    if (noticeTimer) clearTimeout(noticeTimer);
    link.close();
    restore();
    process.exit(code);
  };

  // The pane must never outlive the raw mode and the hidden cursor it took.
  process.on('exit', restore);
  process.on('uncaughtException', (err) => {
    restore();
    process.stderr.write(`cctap strip: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  /**
   * The number under the glyph is the jump handle, so in a live pane it is also the key.
   * The pane keeps rendering afterwards: focus moves to the session, this strip stays.
   */
  const jumpToSlot = async (slot: number): Promise<void> => {
    const target = board.sessions.find((x) => x.slot === slot);
    if (!target) {
      say(`no session ${slot}`);
      return;
    }
    const label = labelSessions(sortSessions(board.sessions)).get(target.sessionId) ?? baseLabel(target);
    say(`jumping to ${label}...`, 10_000);
    const outcome = await performJump(p, target, label);
    say(outcome.summary);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    const intent = keyIntent(chunk);
    if (intent?.kind === 'quit') quit(0);
    else if (intent?.kind === 'slot') void jumpToSlot(intent.slot);
  });

  process.stdout.on('resize', draw);

  /** Ctrl-Z has to leave a usable shell behind, then actually stop us. */
  const stop = (): void => {
    restore();
    process.removeListener('SIGTSTP', stop);
    process.kill(process.pid, 'SIGTSTP');
  };
  process.on('SIGTSTP', stop);
  process.on('SIGCONT', () => {
    process.on('SIGTSTP', stop);
    enter();
  });
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('SIGQUIT', () => quit(0));

  enter();
  return new Promise<number>(() => {
    /* runs until the pane closes */
  });
}
