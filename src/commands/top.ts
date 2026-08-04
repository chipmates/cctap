/**
 * `cctap top`: full-screen TUI over the socket. Off a TTY it prints one plain
 * snapshot and exits 0, which is how CI reads it.
 */

import { ansi, attrsEnabled, BEL, colorEnabled, paint, sgr } from '../ansi.js';
import { getState, subscribePersistent } from '../client.js';
import { loadConfig, motionEnabled } from '../config.js';
import { baseLabel, labelSessions } from '../core/labels.js';
import type { WireSession } from '../core/types.js';
import { paths } from '../paths.js';
import { HIGHLIGHT_MS } from '../proto.js';
import { buildRows, clampVisible, renderTable, renderTableLines, tableHeader } from '../render/table.js';
import { DAEMON_UNREACHABLE, shouldAnimate } from '../render/strip.js';
import { blinkEnabled, colorScopeFor, resolveTheme, sgrFor, type Theme } from '../render/theme.js';
import { performJump } from './jump.js';
import { resumeAfterStop, STALE_MARK } from './strip.js';
import { keyIntent } from '../terminal/keys.js';
import { VERSION } from '../version.js';

const FRAME_MS = 125;
/** Nothing is spinning: one tick a second keeps the age column honest. */
const IDLE_MS = 1000;
/** What an unsized stream gets. A guess that is too small only hides rows. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * A reported dimension counts only when it is positive: a PTY with no controlling
 * terminal reports 0x0, and clamping to a one-cell screen turns the whole surface
 * into a single letter. Zero is "unknown", so the env answers, then the default.
 */
function dimension(reported: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof reported === 'number' && reported > 0) return reported;
  const env = Number.parseInt(envValue ?? '', 10);
  return Number.isFinite(env) && env > 0 ? env : fallback;
}

export function terminalSize(
  out: { rows?: number; columns?: number },
  env: NodeJS.ProcessEnv = process.env,
): { rows: number; cols: number } {
  return {
    rows: dimension(out.rows, env.LINES, DEFAULT_ROWS),
    cols: dimension(out.columns, env.COLUMNS, DEFAULT_COLS),
  };
}

export function snapshotText(
  sessions: readonly WireSession[],
  now: number,
  env = process.env,
  configTheme?: string,
): string {
  const theme = resolveTheme(env, configTheme);
  const rows = buildRows(sessions, now, theme, 0);
  const head = `cctap ${VERSION}  ${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  return [head, ...renderTable(rows)].join('\n');
}

async function printSnapshot(): Promise<number> {
  const p = paths();
  const sessions = await getState(p);
  if (sessions === undefined) {
    process.stdout.write(`${DAEMON_UNREACHABLE}\n`);
    return 0;
  }
  process.stdout.write(`${snapshotText(sessions, Date.now(), process.env, loadConfig(p).theme)}\n`);
  return 0;
}

export interface TopFrameOptions {
  now: number;
  /**
   * Terminal geometry. The frame never exceeds it: one line too many scrolls the
   * alternate screen, and after a scroll the home cursor no longer addresses the header,
   * so every repaint scrolls again.
   */
  rows: number;
  cols: number;
  theme: Theme;
  frame?: number;
  color?: boolean;
  attrs?: boolean;
  blink?: boolean;
  /** Off freezes the spinner, so consecutive frames are byte identical. */
  motion?: boolean;
  selected?: number;
  highlight?: string;
  status?: string;
  /** The daemon link is down: the rows stay, marked unknown. */
  stale?: boolean;
}

/** Keeps the selection on screen without a scroll position to carry between frames. */
function windowStart(total: number, capacity: number, selected: number): number {
  if (capacity <= 0 || capacity >= total) return 0;
  const half = Math.floor((capacity - 1) / 2);
  return Math.min(Math.max(0, selected - half), total - capacity);
}

/** One full screen. Pure, so the viewport rules are testable without a terminal. */
export function topFrame(sessions: readonly WireSession[], opts: TopFrameOptions): string[] {
  const cols = Math.max(1, opts.cols);
  const height = Math.max(1, opts.rows);
  const color = opts.color === true;
  const attrs = opts.attrs === true;
  const rows = buildRows(sessions, opts.now, opts.theme, opts.frame ?? 0, opts.motion !== false);
  const selected = Math.min(Math.max(0, opts.selected ?? 0), Math.max(0, rows.length - 1));

  const lines: string[] = [];
  lines.push(paint(color, ansi.bold, `cctap ${VERSION}`) + `  ${rows.length} session${rows.length === 1 ? '' : 's'}`);
  lines.push('');

  // What the footer owes the reader. The keys are learnable once; a jump result and a
  // dead daemon are news, so they outrank the legend and the rows both.
  const news: string[] = [];
  if (opts.status) news.push(paint(color, ansi.dim, opts.status));
  // Same words the live strip appends, so one daemon loss reads the same on both surfaces.
  if (opts.stale) news.push(paint(color, ansi.dim, STALE_MARK));
  // Held back before the board is laid out and appended after it is trimmed, so nothing
  // above can grow into the reserve and push a dead daemon off the screen (I19).
  const budget = Math.max(0, height - news.length);
  let help = true;

  if (rows.length === 0) {
    lines.push('  no sessions');
  } else {
    lines.push(paint(color, ansi.dim, `  ${tableHeader(rows)}`));
    // Widths come from every row, not just the visible ones, so the columns hold still
    // while the window moves.
    const table = renderTableLines(rows);
    const free = (reserve: number): number => Math.max(0, budget - lines.length - reserve);
    // A row and the line saying what was cut are worth more than the key legend.
    let room = free(2);
    if (room < Math.min(rows.length, 2)) {
      help = false;
      room = free(0);
    }
    // The count of what was cut is kept inside the room, never spent past it: rows on
    // screen with no count is a lie about how many there are.
    const shown = room >= rows.length ? rows.length : Math.max(0, room - 1);
    const start = windowStart(rows.length, shown, selected);
    for (let i = start; i < start + shown; i++) {
      const row = rows[i];
      const line = table[i];
      if (!row || !line) continue;
      const selectedRow = i === selected;
      // '>' is the cursor, '*' says this row was highlighted from outside.
      const marker = selectedRow ? '>' : opts.highlight && opts.highlight === row.sessionId ? '*' : ' ';
      const state = color ? sgrFor(row.state, opts.blink === true) : [];
      const glyphOnly = state.length > 0 && colorScopeFor(row.state) === 'glyph';
      // Colour stops at the label: the state, age and tool columns stay steady, which
      // is easier to read down a column than a wall of tinted rows. The calm states
      // stop at the glyph. A selected row is painted whole, so the reverse video holds.
      const selectionOnly = attrs && selectedRow;
      const head =
        glyphOnly && !selectionOnly
          ? `${sgr([2], line.slot)}  ${sgr(state, line.glyph)}  ${line.label}`
          : sgr(selectionOnly ? [...state, 7] : state, line.head, state.length > 0 || selectionOnly);
      lines.push(`${marker} ${head}  ${line.tail}`.trimEnd());
    }
    // One line for everything that did not fit. A pager would be a second mode to learn.
    if (shown < rows.length) lines.push(paint(color, ansi.dim, `  +${rows.length - shown} more`));
  }

  if (help) {
    lines.push('');
    lines.push(paint(color, ansi.dim, '1-9 jump   j/k or arrows select   Enter jump   q quit'));
  }
  const frame = lines.slice(0, budget);
  frame.push(...news);
  // The clamp is the guarantee: nothing wider than the terminal, nothing taller.
  return frame.slice(0, height).map((l) => clampVisible(l, cols));
}

export async function cmdTop(args: string[] = []): Promise<number> {
  if (!process.stdout.isTTY) return printSnapshot();

  const p = paths();
  const cfg = loadConfig(p);
  const theme = resolveTheme(process.env, cfg.theme);
  const noColorFlag = args.includes('--no-color');
  const color = !noColorFlag && colorEnabled();
  const attrs = !noColorFlag && attrsEnabled();
  const blink = blinkEnabled(process.env, cfg.blink);
  const motion = motionEnabled(process.env, cfg.motion);
  // A daemon that is already down at startup is an unknown board, not an empty one. The
  // link callback cannot say so: it only fires on a change, and nothing has changed yet.
  const known = await getState(p);
  let sessions: WireSession[] = known ?? [];
  let selected = 0;
  let frame = 0;
  let status = '';
  let running = false;
  /** The link is down and the rows on screen are the last ones we were told about. */
  let stale = known === undefined;
  let highlight: string | undefined;
  let highlightTimer: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let tickMs = 0;

  const out = process.stdout;

  const restore = (): void => {
    if (!running) return;
    running = false;
    if (ticker) {
      clearInterval(ticker);
      ticker = undefined;
      tickMs = 0;
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
    try {
      out.write(ansi.showCursor + ansi.altScreenOff);
    } catch {
      /* SIGHUP is the terminal itself leaving, so the write can fail */
    }
  };

  const draw = (): void => {
    if (!running) return;
    if (selected >= sessions.length) selected = Math.max(0, sessions.length - 1);
    const size = terminalSize(out);
    const lines = topFrame(sessions, {
      now: Date.now(),
      rows: size.rows,
      cols: size.cols,
      theme,
      frame,
      color,
      attrs,
      blink,
      motion,
      selected,
      highlight,
      status,
      stale,
    });
    // Repaint in place: a full clear every frame flickers.
    out.write(ansi.home + lines.map((l) => ansi.clearLine + l).join('\r\n') + ansi.clearBelow);
  };

  // Spin at 8 fps only while something is working. Otherwise tick once a second,
  // which is all the age column needs. A stale board never spins: motion there would
  // claim a liveness the link cannot back.
  const syncTicker = (): void => {
    if (!running) return;
    const want = shouldAnimate(sessions, motion && !stale) ? FRAME_MS : IDLE_MS;
    if (tickMs === want && ticker) return;
    if (ticker) clearInterval(ticker);
    tickMs = want;
    ticker = setInterval(() => {
      frame += 1;
      draw();
    }, want);
    ticker.unref();
  };

  /** Take the screen. Also the way back in after a stop handed it to the shell. */
  const enter = (): void => {
    running = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch {
      /* a pane with no usable stdin still renders */
    }
    process.stdin.resume();
    try {
      out.write(ansi.altScreenOn + ansi.hideCursor + ansi.clear);
    } catch {
      /* ignore */
    }
    syncTicker();
    draw();
  };

  // The alternate screen must never outlive us, however we die.
  process.on('exit', restore);
  process.on('uncaughtException', (err) => {
    restore();
    process.stderr.write(`cctap top: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  const link = subscribePersistent(p, {
    onState: (next) => {
      sessions = next;
      stale = false;
      syncTicker();
      draw();
    },
    onLink: (up) => {
      // The rows stay. A board that empties on a dropped link reads as calm, and calm
      // is exactly what a daemon that died mid permission prompt is not.
      stale = !up;
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

  const quit = (code: number): void => {
    if (highlightTimer) clearTimeout(highlightTimer);
    link.close();
    restore();
    process.exit(code);
  };

  const jumpToRow = async (index: number): Promise<void> => {
    const rows = buildRows(sessions, Date.now(), theme, frame, motion);
    const row = rows[index];
    if (!row) return;
    selected = index;
    const labels = labelSessions(sessions);
    const label = labels.get(row.sessionId) ?? baseLabel(row.session);
    status = 'jumping...';
    draw();
    status = (await performJump(p, row.session, label)).summary;
    draw();
  };

  /** A digit is the same jump as selecting that row and pressing Enter. */
  const jumpToSlot = async (slot: number): Promise<void> => {
    const rows = buildRows(sessions, Date.now(), theme, frame, motion);
    const index = rows.findIndex((r) => r.session.slot === slot);
    if (index < 0) {
      status = `no session in slot ${slot}`;
      draw();
      return;
    }
    await jumpToRow(index);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (raw: string) => {
    const intent = keyIntent(raw);
    if (intent?.kind === 'quit') quit(0);
    else if (intent?.kind === 'down') selected = Math.min(selected + 1, Math.max(0, sessions.length - 1));
    else if (intent?.kind === 'up') selected = Math.max(selected - 1, 0);
    else if (intent?.kind === 'enter') void jumpToRow(selected);
    else if (intent?.kind === 'slot') void jumpToSlot(intent.slot);
    draw();
  });

  // A resized terminal invalidates every line on screen, so repaint the lot.
  out.on('resize', () => {
    try {
      out.write(ansi.clear);
    } catch {
      /* ignore */
    }
    draw();
  });

  /** Ctrl-Z has to leave a usable shell behind, then actually stop us. */
  const stop = (): void => {
    restore();
    process.removeListener('SIGTSTP', stop);
    process.kill(process.pid, 'SIGTSTP');
  };
  process.on('SIGTSTP', stop);
  process.on('SIGCONT', () => {
    const act = resumeAfterStop({ restored: !running, armed: process.listeners('SIGTSTP').includes(stop) });
    if (act.arm) process.on('SIGTSTP', stop);
    if (act.enter) enter();
  });
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('SIGQUIT', () => quit(0));

  enter();
  return new Promise<number>(() => {
    /* runs until quit */
  });
}
