/** Single `cctap` bin. Bare invocation is `jump` (D12). */

import { runDaemon } from './daemon/main.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdInstallHooks, cmdStop, cmdUninstallHooks } from './commands/install.js';
import { cmdJump } from './commands/jump.js';
import { cmdKeys } from './commands/keys.js';
import { cmdNotify } from './commands/notify.js';
import { cmdSimulate } from './commands/simulate.js';
import { cmdStatus } from './commands/status.js';
import { cmdStrip } from './commands/strip.js';
import { cmdTop } from './commands/top.js';
import { paths, socketPathError } from './paths.js';
import { VERSION } from './version.js';

const HELP = `cctap ${VERSION} - attention router for parallel Claude Code sessions

usage:
  cctap                     jump to the session that needs you (same as: cctap jump)
  cctap <n>                 jump to the session in slot n, the number in the strip
  cctap jump [n|prefix]     a number is always a slot, anything else is a prefix
  cctap jump --dry-run      print the exact command a jump would run, run nothing
  cctap strip [--rows 2]    live one-line glyph strip for a slim pane
  cctap status              one plain line for tmux status-right or a status line
  cctap top                 full-screen session list (plain snapshot when not a tty)
  cctap daemon              run the daemon in the foreground
  cctap stop                stop the running daemon
  cctap simulate            list the bundled scenarios
  cctap simulate <name>     replay one of them through the socket
  cctap install-hooks       register the hooks and the status line (--dry-run supported)
                            --no-status-line leaves the status line out
  cctap uninstall-hooks     remove them again (--dry-run, --purge to drop ~/.cctap)
                            --purge --force skips the keys-journal check
  cctap keys                every way to reach a session, and the lines to paste
  cctap keys setup [key]    set up a jump key. Inside tmux this binds prefix+key live,
                            --os skips straight to the OS-wide key instead
  cctap notify [on|off]     desktop banners, off by default (bare: print the state)
  cctap doctor              check hooks, daemon, socket, terminal adapter
  cctap --version           print the version

env:
  CCTAP_DIR                 relocate ~/.cctap (socket, state, spool, bin)
  CCTAP_CLAUDE_SETTINGS     override the Claude Code settings file
  CCTAP_THEME               unicode | ascii
  CCTAP_NOTIFY=off          no desktop banners and no bell
  CCTAP_NO_EXEC=1           never spawn an external command
  CCTAP_DEBUG=1             hook forwarder logs to stderr
`;

/**
 * `cctap status | head -1` and a closing tmux pane both hang up mid-write. A CLI
 * that stack-traces on that is a CLI that looks broken inside someone else's bar.
 */
function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
      throw err;
    });
  }
}

async function main(): Promise<number> {
  ignoreBrokenPipe();
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  // Refusing here beats reporting an empty world, or another instance's sessions, from a
  // path the kernel silently truncated. Only the commands that reach the socket though:
  // doctor is what explains this, and keys never opens one, so both must still run.
  if (cmd !== 'doctor' && cmd !== 'keys') {
    const tooLong = socketPathError(paths().sock);
    if (tooLong) {
      process.stderr.write(`cctap: ${tooLong}\n`);
      return 1;
    }
  }

  switch (cmd) {
    case undefined:
    case 'jump':
      return cmdJump(rest);
    case 'top':
      return cmdTop(rest);
    case 'daemon':
      await runDaemon();
      return 0;
    case 'stop':
      return cmdStop();
    case 'simulate':
      return cmdSimulate(rest);
    case 'install-hooks':
      return cmdInstallHooks(rest);
    case 'uninstall-hooks':
      return cmdUninstallHooks(rest);
    case 'keys':
      return cmdKeys(rest);
    case 'notify':
      return cmdNotify(rest);
    case 'doctor':
      return cmdDoctor();
    case 'strip':
      return cmdStrip(rest);
    case 'status':
      return cmdStatus();
    default:
      if (cmd.startsWith('-') || /^[0-9]+$/.test(cmd)) {
        // Bare flags and bare slot numbers belong to jump: `cctap 2` is the whole point.
        return cmdJump(argv);
      }
      process.stderr.write(`cctap: unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}

main()
  .then((code) => {
    // Commands that own the terminal (top, daemon) never resolve.
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`cctap: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
