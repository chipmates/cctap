# Security

## Design

cctap makes no network calls. There is no `http`, `https`, `http2`, `dns`, `tls`, `dgram`
or `inspector` import anywhere in the shipped bundles, and it never shells out to `curl`,
`wget` or `nc`. A test asserts all of that against the built files on every run.

The only socket is a unix socket at `~/.cctap/cctap.sock`, with the directory at 0700 and
every file at 0600.

The hook forwarder copies exactly ten fields out of each hook payload: `session_id`,
`hook_event_name`, `agent_id`, `agent_type`, `tool_name`, `source`, `cwd`, `message`,
`reason`, `transcript_path`. Prompts, tool inputs and tool responses are dropped by name
before anything is written, so they reach neither the socket nor the spool on disk.

cctap never types into a Claude Code session. It has no way to approve a permission
prompt on your behalf.

## Threat model

What cctap defends against is untrusted input arriving on the paths it does not control:
hook payloads handed to it by Claude Code, and anything a local process writes to its
socket. Fields are taken by whitelist and bounded in size, and text is stripped of
terminal control sequences before it is rendered, so a hostile directory or branch name
cannot move your cursor, repaint your prompt or hide what the strip is telling you.

What it does not defend against is a process already running as your user. The socket at
0600 and the directory at 0700 are the whole boundary: anything running as you can read
the state file, write to the socket or replace the binaries, and cctap has no way to
tell that apart from you doing it. It also trusts Claude Code itself, so a compromised
Claude Code can tell it whatever it likes. And it cannot promise delivery to a daemon
that is stopped rather than gone. A write the kernel accepted looks exactly like a write
the daemon read, so events buffered for a suspended daemon can be lost. The spool covers
a daemon that is unreachable, not one that is frozen.

## Reporting a vulnerability

Report privately through GitHub security advisories:
https://github.com/chipmates/cctap/security/advisories/new

Please do not open a public issue for a security problem. A first response should arrive
within a week.

## Supported versions

The latest published release. cctap is small and has no runtime dependencies, so fixes
ship as a new release rather than as backports.
