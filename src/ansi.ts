/** Raw ANSI, no color library (zero runtime deps). Colour disables itself off a TTY. */

const CSI = '\u001b[';

export const ansi = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  blink: `${CSI}5m`,
  reverse: `${CSI}7m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  cyan: `${CSI}36m`,
  grey: `${CSI}90m`,
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clear: `${CSI}2J${CSI}H`,
  home: `${CSI}H`,
  clearLine: `${CSI}2K`,
  clearBelow: `${CSI}0J`,
};

export function cursorUp(n: number): string {
  return n > 0 ? `${CSI}${n}A` : '';
}

export const BEL = '\u0007';

export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/** True when the terminal can render escape sequences at all. */
function escapesUsable(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
  if (env.CCTAP_COLOR === '0') return false;
  if (env.CCTAP_COLOR === '1') return true;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  }
  if (!stream.isTTY) return false;
  return env.TERM !== 'dumb';
}

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout, env = process.env): boolean {
  // NO_COLOR is about hue, not about escape sequences (no-color.org).
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '' && env.CCTAP_COLOR !== '1') return false;
  return escapesUsable(stream, env);
}

/**
 * Non-colour attributes: reverse video and bold. NO_COLOR must not delete these,
 * because reverse video is how a highlight reaches someone who cannot see hue.
 */
export function attrsEnabled(stream: NodeJS.WriteStream = process.stdout, env = process.env): boolean {
  return escapesUsable(stream, env);
}

export function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ansi.reset}` : text;
}

/** One SGR sequence for a whole attribute set, so no inner reset cuts it short. */
export function sgr(codes: readonly number[], text: string, enabled = true): string {
  if (!enabled || codes.length === 0) return text;
  return `${CSI}${codes.join(';')}m${text}${ansi.reset}`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** Visible width, ignoring escape sequences. Wide glyphs are out of scope for v1. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}
