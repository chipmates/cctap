/**
 * POSIX single-quoting, the one form that makes a string inert to every shell layer
 * cctap writes into. Double quotes leave `$`, backtick and `\` special, and the status
 * line is shell-parsed every two seconds, so a `$` in a home directory silently yields
 * a dead strip and a backtick runs path-derived text. Dependency-free and tiny on
 * purpose: the tmux and keys surfaces quote through this same function.
 */

/** Wraps s so a shell reads it as one literal word, whatever it contains. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
