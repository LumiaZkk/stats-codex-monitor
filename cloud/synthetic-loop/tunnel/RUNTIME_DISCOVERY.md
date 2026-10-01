# Native discovery for an existing foreground runtime

The native Diagnose button no longer needs a temporary folder picker. It discovers
an already-running approved foreground test. Discovery does not start a process,
store credentials, extend the one-hour runtime lifetime, add a background service,
or grant local execution. A proposal still needs explicit local approval.

## Nonsecret descriptor

The runtime uses the real OS user's home, captured before isolating the official
client's HOME. It publishes one file at:

`~/Library/Caches/stats-codex-monitor/runtime-v1/<instance_id>.json`

The app cache and runtime directories are owner-only (0700); files are 0600. The
publisher rejects symlinks, unsafe owners/modes and directory replacement. It scans
at most 32 entries in this one directory, permits at most 8 descriptor records and
serializes publication with a private short-lived lock. A fully written/fsynced
exclusive temporary file is installed using a no-overwrite hard link. A live UUID
collision never replaces another descriptor.

The exact descriptor fields are:

- `schema_version`:1 and `kind`:`stats_runtime_descriptor`
- `protocol_version`:2
- `instance_id`: lowercase UUIDv4, fresh for each server process
- `uid`, `runtime_pid`: the effective user and actual Node MCP server process
- `started_at`, `expires_at`: canonical UTC milliseconds; maximum one-hour lifetime
- `scope_hash`: SHA-256 of the verified immutable personal tunnel scope
- `socket_path`: absolute path to the already-listening private Unix socket

The file is at most 4096 UTF-8 bytes. It contains no API key, callback URL, signing
secret, raw organization/workspace/tunnel IDs, real metrics or executable input.
The UUID and scope hash are public binding metadata, not credentials or signatures.
Processes owned by the same OS account remain within the trust boundary.

Publication occurs only after lease validation, socket listen and 0600 permissions.
Normal stop and process exit remove only the descriptor whose bytes and inode
still match this publisher. After a crash, another startup may remove a strict,
matching same-user descriptor only when its expiry has passed or its PID is
confirmed absent (`ESRCH`); permission denial (`EPERM`) is never evidence of death.
An unsafe or replaced file fails closed. Empty cache directories may remain.

## Discovery and fresh handshake

The native app reads only the fixed directory's bounded UUID filenames. It checks
strict JSON/schema, ownership, modes, no symlinks, time bounds and the socket's
private directory/inode. It connects without an IP socket and verifies both the
kernel peer UID and PID before sending any request. It checks candidate liveness
with a fresh UUID nonce and one overall bounded discovery deadline.

The handshake command contains exactly:

```json
{"schema_version":2,"op":"hello_native","expected_instance_id":"<descriptor UUID>","nonce":"<fresh UUIDv4>"}
```

The response is `{ "result": ... }`, whose exact fields are `schema_version`:2,
`kind`:`stats_runtime_hello`, the descriptor identity fields `instance_id`,
`protocol_version`, `uid`, `runtime_pid`, `started_at`, `expires_at`, `scope_hash`,
and the same `nonce`. It contains no socket path. Access and expiry are checked
before returning it. A hello never creates a diagnostic or sends an event.

Exactly one validated live candidate can be selected automatically. Multiple live
candidates are ambiguous and must not silently pick the newest. A stale file,
changed identity, disappeared process or expired lease is not a usable runtime.
An active request remains bound to its original instance; rediscovery cannot move
that request or its approved proposal to a different process.

## Instance-bound commands

For discovery, each `diagnose_native`, `result_native` and `cancel_native` command
contains exactly `schema_version`:2, `op`, `expected_instance_id`, and the existing
complete `client_request` envelope. The server verifies instance identity and
lifetime before creation, cancellation or event delivery scheduling. It then uses
the unchanged strict native request contract. The status response and canonical
proposal bundle retain schema version 1.

The app rechecks the original descriptor bytes/inode and socket identity before
every exchange. The per-command expected UUID closes replacement between hello
and submission, even if an OS PID is reused. Legacy v1 and CLI commands remain
compatible for explicitly selected endpoints; the discovery flow never downgrades.
All traffic keeps the existing 16 KiB frame limit and five-second exchange deadline.

Shared fixtures `runtime-descriptor-v1.json` and `runtime-hello-v2.json` exercise
exact cross-language bytes. Unit tests cover publication, stale/unsafe/replaced
metadata, bounds, handshake/schema and per-command identity rejection. The
credential-free official-client CI probe verifies real descriptor publication,
hello, bound native transport and cleanup when the access watchdog exits.

This descriptor does not repair an event subscription. An active signed
subscription and current-dot event acceptance are separate readiness gates.
