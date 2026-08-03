/**
 * `~/.cctap/config.json`. The only config surface there will ever be (non-goal 11).
 * Notification toggles are read here once notifications land in M2.
 */

import { paths, readJsonFile, type Paths } from './paths.js';

export interface Config {
  theme?: 'unicode' | 'ascii';
  /** Opt in to the blinking permission glyph. Off by default. */
  blink?: boolean;
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
  if (typeof raw.socket === 'string' && raw.socket.trim() !== '') out.socket = raw.socket.trim();
  if (raw.notify && typeof raw.notify === 'object') out.notify = raw.notify;
  return out;
}
