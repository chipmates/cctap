/**
 * `~/.cctap/config.json`. The only config surface there will ever be (non-goal 11).
 * Notification toggles are read here once notifications land in M2.
 *
 * One key widens that closed surface on purpose: `motion`. Blink was already opt-in for
 * photosensitive and vestibular readers, but the spinner ran regardless, and nothing
 * else in the product could turn it off. An accessibility escape hatch is not a feature
 * knob, so it is the exception rather than the precedent.
 */

import { paths, readJsonFile, type Paths } from './paths.js';

export interface Config {
  theme?: 'unicode' | 'ascii';
  /** Opt in to the blinking permission glyph. Off by default. */
  blink?: boolean;
  /** Set false to freeze the spinner and stop every ticker. On by default. */
  motion?: boolean;
  /** Move the socket out of the tree when the directory path is too long for sun_path. */
  socket?: string;
  notify?: {
    /** Desktop banners. Off unless this says otherwise: `cctap notify on` sets it. */
    enabled?: boolean;
    permission_wait?: boolean;
    failed?: boolean;
    your_turn?: boolean;
  };
}

export function loadConfig(p: Paths = paths()): Config {
  const raw = readJsonFile<Config>(p.config);
  if (!raw || typeof raw !== 'object') return {};
  const out: Config = {};
  if (raw.theme === 'unicode' || raw.theme === 'ascii') out.theme = raw.theme;
  if (typeof raw.blink === 'boolean') out.blink = raw.blink;
  if (typeof raw.motion === 'boolean') out.motion = raw.motion;
  if (typeof raw.socket === 'string' && raw.socket.trim() !== '') out.socket = raw.socket.trim();
  if (raw.notify && typeof raw.notify === 'object') out.notify = raw.notify;
  return out;
}

/**
 * Animation, off through either door. The env var wins so a reader can kill the motion
 * for one terminal without editing a file, and so `prefers-reduced-motion` wiring in a
 * shell profile is a one-liner.
 */
export function motionEnabled(env: NodeJS.ProcessEnv = process.env, configMotion?: boolean): boolean {
  if (env.CCTAP_MOTION === '0') return false;
  if (env.CCTAP_MOTION === '1') return true;
  return configMotion !== false;
}
