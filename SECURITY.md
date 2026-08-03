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

## Reporting a vulnerability

Report privately through GitHub security advisories:
https://github.com/chipmates/cctap/security/advisories/new

Please do not open a public issue for a security problem. A first response should arrive
within a week.

## Supported versions

The latest published release. cctap is small and has no runtime dependencies, so fixes
ship as a new release rather than as backports.
