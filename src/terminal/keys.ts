/**
 * What a keypress means in a live pane. Pure, so the mapping is testable without a
 * terminal: the panes only supply the actions.
 */

export type KeyIntent =
  | { kind: 'quit' }
  | { kind: 'slot'; slot: number }
  | { kind: 'down' }
  | { kind: 'up' }
  | { kind: 'enter' }
  | undefined;

const CTRL_C = '';

/**
 * A terminal in raw mode delivers one keypress; a pipe delivers a line. Both end up
 * here, so the digit is taken out of whatever arrived rather than matched whole.
 */
export function keyIntent(raw: string): KeyIntent {
  if (raw.includes(CTRL_C)) return { kind: 'quit' };
  const key = raw.replace(/[\r\n]/g, '');
  if (key === 'q') return { kind: 'quit' };
  if (key === 'j' || key === '[B') return { kind: 'down' };
  if (key === 'k' || key === '[A') return { kind: 'up' };
  if (raw === '\r' || raw === '\n' || key === '') return { kind: 'enter' };
  const digit = /[1-9]/.exec(key);
  if (digit) return { kind: 'slot', slot: Number.parseInt(digit[0], 10) };
  return undefined;
}
