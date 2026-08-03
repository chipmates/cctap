/**
 * Terminal columns, not UTF-16 units. A CJK project name that counts as nine units
 * draws eighteen cells, so a strip fitted on units overflows the line it was meant to
 * fit and wraps the status bar it lives in.
 *
 * Pure and zero-dep: `Intl.Segmenter` is part of the runtime.
 */

/** Printable ASCII is one cell per unit, which is the overwhelming common case. */
const ASCII_ONLY = /^[\x20-\x7E]*$/;

const VS16 = '\u{FE0F}';
const ZWJ = '\u{200D}';

/** A grapheme made only of combining marks or format characters occupies no cell. */
const ZERO_ONLY = /^[\p{M}\p{Cf}]+$/u;
/** Default-emoji presentation: the pictographic blocks a terminal draws two cells wide. */
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/**
 * East Asian Wide and Fullwidth as explicit ranges: ECMAScript property escapes do not
 * expose `East_Asian_Width`. Ambiguous characters stay one cell on purpose. They are
 * only drawn wide under CJK locales, and there the ascii theme already takes over, so
 * widening them here would mis-measure every other terminal.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic space and punctuation
  [0x3041, 0x33ff], // kana, Hangul compatibility jamo, CJK squared abbreviations
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility and small forms
  [0xff00, 0xff60], // fullwidth ASCII
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7], // Tangut
  [0x18800, 0x18cd5],
  [0x1b000, 0x1b152], // kana supplement
  [0x1b164, 0x1b2fb],
  [0x20000, 0x3fffd], // CJK extensions B and beyond
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true;
  return false;
}

let segmenter: Intl.Segmenter | undefined;

/** One segmenter for the process: building one per call costs more than the walk. */
function graphemes(s: string): string[] {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

function graphemeWidth(g: string): number {
  if (ZERO_ONLY.test(g)) return 0;
  const points = Array.from(g);
  const base = points[0];
  if (base === undefined) return 0;
  // The emoji variation selector is a request for the two-cell picture form.
  if (g.includes(VS16)) return 2;
  // A joined sequence draws as one picture, and a picture is two cells.
  if (g.includes(ZWJ) && PICTOGRAPHIC.test(base)) return 2;
  // A flag is a pair of regional indicators fused into a single glyph.
  if (points.length > 1 && REGIONAL.test(base) && REGIONAL.test(points[1] ?? '')) return 2;
  if (EMOJI_WIDE.test(base)) return 2;
  return isWide(base.codePointAt(0) ?? 0) ? 2 : 1;
}

/** Columns the string occupies. Escape sequences are the caller's problem (see ansi.ts). */
export function stringWidth(s: string): number {
  if (s === '') return 0;
  if (ASCII_ONLY.test(s)) return s.length;
  let w = 0;
  for (const g of graphemes(s)) w += graphemeWidth(g);
  return w;
}

/**
 * Longest prefix that fits `max` columns, cut on grapheme boundaries. A cut inside a
 * surrogate pair or a combining sequence puts a replacement character on the terminal,
 * and a wide glyph that only half fits is dropped rather than allowed to straddle.
 */
export function cutToWidth(s: string, max: number): string {
  if (max <= 0 || s === '') return '';
  if (ASCII_ONLY.test(s)) return s.length <= max ? s : s.slice(0, max);
  let w = 0;
  let out = '';
  for (const g of graphemes(s)) {
    const gw = graphemeWidth(g);
    if (w + gw > max) break;
    out += g;
    w += gw;
  }
  return out;
}
