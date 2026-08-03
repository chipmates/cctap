/** Glyphs and colours per state. ASCII fallback for plain terminals. */

import type { DisplayState } from '../core/types.js';

export const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/**
 * The rotating bar, minus its vertical frame: a single `*` left working looking as
 * static as ended, and `|` is the ascii group separator, so a spinner cannot borrow it.
 */
export const SPINNER_ASCII = ['/', '-', '\\'];

export type ThemeName = 'unicode' | 'ascii';

export interface Theme {
  name: ThemeName;
  spinner: string[];
  glyph: Record<Exclude<DisplayState, 'working'>, string>;
  separator: string;
  collisionSep: string;
  ellipsis: string;
  /** Subagent count prefix: the multiplication sign is not 7-bit. */
  times: string;
}

const UNICODE_THEME: Theme = {
  name: 'unicode',
  spinner: SPINNER_UNICODE,
  glyph: {
    permission_wait: '!!',
    your_turn: '▲',
    failed: '✗',
    compacting: '◌',
    ended: '·',
  },
  separator: '│',
  collisionSep: '/',
  ellipsis: '…',
  times: '×',
};

const ASCII_THEME: Theme = {
  name: 'ascii',
  spinner: SPINNER_ASCII,
  glyph: {
    permission_wait: '!',
    your_turn: '^',
    // Capital X, because lowercase x is the subagent multiplier: "x x2" read as one word.
    failed: 'X',
    compacting: 'o',
    ended: '.',
  },
  separator: '|',
  collisionSep: '/',
  ellipsis: '~',
  times: 'x',
};

export function resolveTheme(env: NodeJS.ProcessEnv = process.env, configTheme?: string): Theme {
  const want = env.CCTAP_THEME ?? configTheme;
  if (want === 'ascii') return ASCII_THEME;
  if (want === 'unicode') return UNICODE_THEME;
  const term = env.TERM ?? '';
  if (term === '' || term === 'dumb' || term === 'vt100' || term === 'vt102') return ASCII_THEME;
  // A locale that names an encoding other than UTF-8 cannot render braille.
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (locale !== '' && !/utf-?8/i.test(locale)) return ASCII_THEME;
  // CJK locales render ambiguous-width characters two cells wide, which breaks the
  // fit math. Font support is not detectable, so the locale is the best signal there is.
  if (/^(ja|ko|zh)([_.-]|$)/i.test(locale)) return ASCII_THEME;
  return UNICODE_THEME;
}

/**
 * Traffic light, 16-colour safe, one SGR sequence per span so nothing resets early.
 * The hierarchy is bright red bold (someone is blocked), plain red (something failed),
 * yellow (your turn), then the calm states. Blink is off by default: it is painful for
 * vestibular and photosensitive readers, many terminals ignore it, and red plus bold
 * already reads louder.
 */
export function sgrFor(state: DisplayState, blink = false): number[] {
  switch (state) {
    case 'permission_wait':
      return blink ? [91, 1, 5] : [91, 1];
    case 'failed':
      return [31];
    case 'your_turn':
      return [33];
    case 'working':
      return [32];
    case 'compacting':
      return [36];
    case 'ended':
      return [2];
    default:
      return [];
  }
}

export type ColorScope = 'entry' | 'glyph';

/**
 * The traffic light lives on the names themselves: every state a session can actually be
 * in paints its whole entry, so the board reads as colour at a glance. Compacting is the
 * exception, a transient system chore rather than a state of the work, so it tints its
 * glyph and leaves the name neutral.
 */
export function colorScopeFor(state: DisplayState): ColorScope {
  return state === 'compacting' ? 'glyph' : 'entry';
}

export function blinkEnabled(env: NodeJS.ProcessEnv = process.env, configBlink?: boolean): boolean {
  if (env.CCTAP_BLINK === '1') return true;
  return configBlink === true;
}

/**
 * With motion off the spinner freezes on one frame rather than disappearing: working
 * still has to be tellable from ended, and the strip is the only place that says so.
 */
export function glyphFor(theme: Theme, state: DisplayState, frame = 0, motion = true): string {
  if (state === 'working') {
    const s = theme.spinner;
    if (!motion) return s[0] ?? '*';
    return s[((frame % s.length) + s.length) % s.length] ?? s[0] ?? '*';
  }
  return theme.glyph[state];
}

