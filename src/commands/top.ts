/**
 * `cctap top`: full-screen TUI over the socket. Off a TTY it prints one plain
 * snapshot and exits 0, which is how CI reads it.
 */

import { ansi, attrsEnabled, BEL, colorEnabled, paint, sgr } from '../ansi.js';
import { getState, subscribePersistent } from '../client.js';
import { loadConfig } from '../config.js';
import { baseLabel, labelSessions } from '../core/labels.js';
import type { WireSession } from '../core/types.js';
import { paths } from '../paths.js';
import { HIGHLIGHT_MS } from '../proto.js';
import { buildRows, renderTable, renderTableLines, tableHeader } from '../render/table.js';
import { DAEMON_UNREACHABLE, shouldAnimate } from '../render/strip.js';
import { blinkEnabled, colorScopeFor, resolveTheme, sgrFor } from '../render/theme.js';
import { performJump } from './jump.js';
import { keyIntent } from '../terminal/keys.js';
import { VERSION } from '../version.js';

const FRAME_MS = 125;
/** Nothing is spinning: one tick a second keeps the age column honest. */
const IDLE_MS = 1000;

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

export async function cmdTop(args: string[] = []): Promise<number> {
  if (!process.stdout.isTTY) return printSnapshot();

  const p = paths();
  const cfg = loadConfig(p);
  const theme = resolveTheme(process.env, cfg.theme);
  const noColorFlag = args.includes('--no-color');
  const color = !noColorFlag && colorEnabled();
  const attrs = !noColorFlag && attrsEnabled();
  const blink = blinkEnabled(process.env, cfg.blink);
  let sessions: WireSession[] = (await getState(p)) ?? [];
  let selected = 0;
  let frame = 0;
  let status = '';
  let running = true;
  let highlight: string | undefined;
  let highlightTimer: NodeJS.Timeout | undefined;

  const out = process.stdout;

  const cleanup = (): void => {
    if (!running) return;
    running = false;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
    out.write(ansi.showCursor + ansi.altScreenOff);
  };

  // The alternate screen must never outlive us, however we die.
  process.on('exit', cleanup);
  process.on('uncaughtException', (err) => {
    cleanup();
    process.stderr.write(`cctap top: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  out.write(ansi.altScreenOn + ansi.hideCursor + ansi.clear);

  const draw = (): void => {
    if (!running) return;
    const now = Date.now();
    const rows = buildRows(sessions, now, theme, frame);
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    const lines: string[] = [];
    lines.push(paint(color, ansi.bold, `cctap ${VERSION}`) + `  ${rows.length} session${rows.length === 1 ? '' : 's'}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('  no sessions');
    } else {
      lines.push(paint(color, ansi.dim, `  ${tableHeader(rows)}`));
      renderTableLines(rows).forEach((line, i) => {
        const row = rows[i];
        const selectedRow = i === selected;
        // '>' is the cursor, '*' says this row was highlighted from outside.
        const marker = selectedRow ? '>' : highlight && row && highlight === row.sessionId ? '*' : ' ';
        const state = row && color ? sgrFor(row.state, blink) : [];
        const glyphOnly = row !== undefined && state.length > 0 && colorScopeFor(row.state) === 'glyph';
        // Colour stops at the label: the state, age and tool columns stay steady, which
        // is easier to read down a column than a wall of tinted rows. The calm states
        // stop at the glyph. A selected row is painted whole, so the reverse video holds.
        const selectionOnly = attrs && selectedRow;
        const head =
          glyphOnly && !selectionOnly
            ? `${sgr([2], line.slot)}  ${sgr(state, line.glyph)}  ${line.label}`
            : sgr(selectionOnly ? [...state, 7] : state, line.head, state.length > 0 || selectionOnly);
        lines.push(`${marker} ${head}  ${line.tail}`.trimEnd());
      });
    }
    lines.push('');
    lines.push(paint(color, ansi.dim, '1-9 jump   j/k or arrows select   Enter jump   q quit'));
    if (status) lines.push(paint(color, ansi.dim, status));
    // Repaint in place: a full clear every frame flickers.
    out.write(ansi.home + lines.map((l) => ansi.clearLine + l).join('\r\n') + ansi.clearBelow);
  };

  const link = subscribePersistent(p, {
    onState: (next) => {
      sessions = next;
      if (status.startsWith('no daemon')) status = '';
      syncTicker();
      draw();
    },
    onLink: (up) => {
      if (!up) {
        status = 'no daemon running';
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

  // Spin at 8 fps only while something is working. Otherwise tick once a second,
  // which is all the age column needs.
  let ticker: NodeJS.Timeout | undefined;
  let tickMs = 0;
  const syncTicker = (): void => {
    const want = shouldAnimate(sessions) ? FRAME_MS : IDLE_MS;
    if (tickMs === want && ticker) return;
    if (ticker) clearInterval(ticker);
    tickMs = want;
    ticker = setInterval(() => {
      frame += 1;
      draw();
    }, want);
    ticker.unref();
  };

  const quit = (code: number): void => {
    if (ticker) clearInterval(ticker);
    if (highlightTimer) clearTimeout(highlightTimer);
    link.close();
    cleanup();
    process.exit(code);
  };

  const jumpToRow = async (index: number): Promise<void> => {
    const rows = buildRows(sessions, Date.now(), theme, frame);
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
    const rows = buildRows(sessions, Date.now(), theme, frame);
    const index = rows.findIndex((r) => r.session.slot === slot);
    if (index < 0) {
      status = `no session in slot ${slot}`;
      draw();
      return;
    }
    await jumpToRow(index);
  };

  {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
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
  }

  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  syncTicker();
  draw();
  return new Promise<number>(() => {
    /* runs until quit */
  });
}
