/**
 * Every field that reaches a terminal surface passes through here first.
 *
 * Directory names, branch names and hook text are all attacker-writable in the sense
 * that matters: a colleague's branch, a cloned repo, a tool name echoed back. An ESC
 * left in any of them repaints the screen from inside a status line, and a CR rewrites
 * the row the strip just drew. Stripping is the only safe answer, because a renderer
 * cannot tell a decorative sequence from a destructive one.
 */

/** Tab, newline and return mean "some space here", so they become exactly that. */
const TO_SPACE = /[\t\n\r]/g;

/**
 * The rest of C0, DEL, and C1. C1 matters as much as C0: a terminal in 8-bit mode reads
 * U+009B as a control sequence introducer, so dropping ESC alone would not be enough.
 */
const DROP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Idempotent: nothing it emits belongs to either class. */
export function sanitizeText(s: string): string {
  return s.replace(TO_SPACE, ' ').replace(DROP, '');
}
