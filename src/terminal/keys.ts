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
const ESC = '';

/**
 * A terminal in raw mode delivers one keypress; a pipe delivers a line. Both end up
 * here, and every match is against the whole chunk with a trailing newline taken off,
 * because a terminal sends far more than single characters: F5 is `ESC [ 1 5 ~`, a
 * bracketed paste opens with `ESC [ 2 0 0 ~`, a mouse report is a run of coordinates.
 * Looking for a digit anywhere inside those made half of them jump somewhere.
 */
export function keyIntent(raw: string): KeyIntent {
  const key = raw.replace(/[\r\n]+$/, '');
  if (key === '') return { kind: 'enter' };
  if (key === 'q' || key === CTRL_C) return { kind: 'quit' };
  if (key === 'j' || key === `${ESC}[B`) return { kind: 'down' };
  if (key === 'k' || key === `${ESC}[A`) return { kind: 'up' };
  // Anything else that opens with an escape is a sequence this pane has no meaning for,
  // and it must never fall through to the digit match on a number inside it.
  if (key.startsWith(ESC)) return undefined;
  if (/^[1-9]$/.test(key)) return { kind: 'slot', slot: Number.parseInt(key, 10) };
  return undefined;
}
