# Bound native socket protocol, version 1

This private transport accepts only the existing synthetic fixture envelope. It
adds no credential storage, telemetry input or execution operation. The app
discovers the active foreground runtime using the bounded descriptor and v2
instance binding in [RUNTIME_DISCOVERY.md](RUNTIME_DISCOVERY.md). Its verified
endpoint is still `native.sock`; there is no persistent pairing or auto launch.
The v1 commands below remain compatible with explicit CLI/manual integrations.

The app must check the directory is owner-only, the socket is mode 0600, neither
is a symlink, and the connected peer has the same effective UID. Other processes
owned by that OS account remain in the trust boundary. The runtime's verified
exclusive personal tunnel lease is still required for every operation.

## Framing and commands

One compact UTF-8 JSON request line with a newline; one response line with a
newline and EOF. Each whole wire frame, including newline, is at most 16,384 bytes.
The server enforces an absolute five-second connection deadline. Client I/O must
also use a total deadline, run off the UI thread and reject trailing frames,
duplicate JSON keys and unknown fields.

Every native command contains exactly these three fields:

```json
{
  "schema_version": 1,
  "op": "diagnose_native",
  "client_request": "<the complete stats_synthetic_request object>"
}
```

The `client_request` value is an object, not the illustrative string above. Its
exact schema and canonical hash are defined in `bridge/core.mts`,
`bridge/transfer.mts` and `fixtures/native-request-v1.json`. Supported operations:

- `diagnose_native`: import the fixed synthetic envelope idempotently. Retries
  must reuse the entire original envelope, including timestamps and hash.
- `result_native`: retrieve only the request bound to that exact client envelope.
- `cancel_native`: cancel that exact binding. An unknown unexpired binding leaves
  a durable, bounded cancellation marker before returning `not_found`; a delayed
  submission is then rejected with `request_cancelled`.

Only first-time creation requires an unexpired envelope. An existing exact
binding remains readable as `expired` or `cancelled`; reads never revive it.
Unknown expired requests cannot create rows or cancellation markers. Marker and
request retention is bounded to 24 hours after expiry, with at most 100 records
of each kind. All creation routes, including MCP import and the legacy CLI,
respect cancellation markers and owner/idempotency constraints.

## Responses and approval boundary

Success is `{ "result": <status object> }`. The status object always has exactly:

- `schema_version`: 1
- `kind`: `stats_native_socket_status`
- `client_request_id`, `client_request_hash`: the exact submitted client binding
- `request_id`, `request_hash`: immutable server request identity
- `status`: `requested`, `proposed`, `cancelled` or `expired`
- `bundle`: the existing `stats_synthetic_result` wrapper when proposed; otherwise null

The bundle's canonical JSON strings and SHA-256 hashes are the source of truth.
Its dry-run proposal stays inert. Hashes bind content; they are not a signature or
proof that its origin is trusted. The app pins the first server ID/hash, validates
all later responses against that binding, and uses its existing strict bundle
parser. The shared `fixtures/native-socket-status-v1.json` is generated from the
existing request/result vectors and tested as exact UTF-8 bytes in both languages.

A schema/state rejection is `{ "error": "<finite reason>" }` with no `result`.
Malformed, oversized or trailing input closes the socket. A first operation
already dispatched before later bytes arrive cannot be recalled. Error strings
are inert UI text, never commands. Existing CLI `diagnose`, `result` and `cancel`
shapes remain unchanged.

Local cancellation must commit before best-effort remote cancellation, including
while submission or polling is in flight. Discard late responses after local
cancellation. A callback already delivered cannot be recalled; later reads and
proposal writes enforce terminal state. A downloaded result cannot learn later
server cancellation. Before a local user-approved test starts, the native socket
flow should refresh and validate current status and hashes; this is not a remote
execution grant or a distributed atomic execution transaction.

Only the native app can offer a separate local confirmation and immutable local
manifest for opening Activity Monitor or bounded measurement. This runtime has
no approve or execute endpoint and never interprets plan summaries as actions.

## Verification

`tests/native-socket.test.mts` covers full binding, persistence, cancellation races,
all insertion paths, capacity limits, expiry, strict schema, hashes and golden
wire bytes. `scripts/probe-private-runtime.mts` exercises all three new operations
through the actual Unix socket and official local MCP dev proxy, alongside the
legacy CLI path. CI runs that credential-free probe. Its test lease is isolated;
it is not itself evidence of hosted event delivery or native action execution.
