# Private, foreground synthetic runtime

This is a bounded technical spike for official Secure MCP Tunnel. It accepts a
fixed synthetic fixture, returns dry-run proposals and has **no native execution
endpoint**. The native app's approved-action/receipt integration is still separate.

## Boundary and prerequisites

- One verified personal account, one private tunnel, exactly one associated
  Personal organization and one personal ChatGPT workspace. Do not use this
  single-principal stdio mode with a team/shared organization or shared workspace.
- The account membership must be checked before setup; do not add members or
  delegate tunnel access during this test. Metadata rechecks verify association
  and continued runtime access, not every possible organization role assignment.
- Node 24 and the official `tunnel-client` v0.0.15 binary, commit
  `a390c168ff1b2d14e73a95991c186c6aba3ff5a0`, verified from the release checksum.
- A user-owned **1-day** runtime key for the existing project, with **Restricted:
  Tunnels Read + Use only**. Every other API category stays None. No admin key.
- The user generates and copies the key directly into hidden Terminal input.
  Never send it through chat, source, command-line arguments, logs or a model.

The [official permission guide](https://github.com/openai/tunnel-client/blob/a390c168ff1b2d14e73a95991c186c6aba3ff5a0/docs/permissions.md)
documents `CONTROL_PLANE_API_KEY` and the read-only metadata lookup used here.

## Reproducible binary verification

Download the matching ZIP from
`https://github.com/openai/tunnel-client/releases/download/v0.0.15/`:

| ZIP | SHA256 |
|---|---|
| tunnel-client-v0.0.15-darwin-arm64.zip | b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff |
| tunnel-client-v0.0.15-darwin-amd64.zip | 9dcae1e2fb121287e73271edb7b853dda52aa86b7bfca1df91bc275371261bdb |
| tunnel-client-v0.0.15-linux-amd64.zip | 8c836dc5d68d68b663d9a5c5b28ff9fa780d9f7a3fffb1c306880b8f32fab5f1 |

Verify using `shasum -a 256`, then extract only `tunnel-client`. Nothing installs
a system service or changes firewall settings. Use paths without spaces for this
small stdio launcher; it fails closed on shell metacharacters.

## Before entering any real key

Run the credential-free local probes with the verified binary:

```sh
TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client npm run test:official-tunnel
TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client npm run test:private-runtime
```

The second probe uses the real server/SQLite/Unix socket behind the official local
dev proxy. Its access lease is an isolated fixture. It proves no hosted identity,
external callback, current-dot wake or native execution. A container without Unix
socket permission may fail EPERM; do not weaken the runtime's local IPC boundary.

## Approved setup and foreground run

The operator prepares a private JSON file, mode 0600, with these non-secret fields:

```json
{
  "mode": "exclusive_personal_synthetic",
  "tunnel_id": "<actual approved tunnel ID>",
  "organization_id": "<actual approved Personal organization ID>",
  "workspace_id": "<actual approved personal workspace ID>"
}
```

Open a user-visible Terminal and run:

```sh
/bin/bash /absolute/path/to/tunnel/launch.command /absolute/path/to/node /absolute/path/to/tunnel-client /absolute/path/to/approved-scope.json
```

The prompt uses Bash `read -s` from `/dev/tty`, with tracing disabled. Input is not
a shell command and is never in command history or argv. The launcher exports it
only to this test's runner/client processes and unsets it on exit. No API key file,
saved profile, login item or launch agent is created. The official stdio child
inherits the environment briefly and immediately removes API-key variables; the
runtime server never uses them. Processes owned by the same OS account remain in
the local trust boundary.

Startup checks the official client version and runs its authenticated read-only
`admin --json tunnels get` command. Exact tunnel/org/workspace associations are
mandatory; unexpected tenant scopes fail closed. A successful check creates a
90-second private access lease; it is refreshed every 30 seconds. Failed checks
stop the runtime. RPCs and callback attempts reject expired leases.

The official `doctor` check runs before the foreground client. The terminal prints
the private run directory, **not a ready claim**. Verify `/healthz` and `/readyz`
using the loopback URL from that directory's `health.url` before connecting the
private plugin. The tunnel connection uses official account/workspace access;
there is no public ingress and no invented user header. Application OAuth is
required instead of this single-account stdio assumption for any shared rollout.

## Synthetic local request and returned proposal

After the intended dot has successfully subscribed and verified the real callback:

```sh
node tunnel/client.mts <private-run-directory> diagnose
node tunnel/client.mts <private-run-directory> result <request-id>
node tunnel/client.mts <private-run-directory> cancel <request-id>
```

The Unix socket is inside an owner-only directory and has mode 0600. Its only
operations create the fixed fixture, retrieve a result or cancel it. No caller
can send metrics, paths, process IDs, shell commands or executable actions.

SQLite stores immutable requests/proposals, finite subscriptions and a bounded
delivery outbox. Subscription signing secrets remain in the private test directory
for the active test lifetime; they are never logged or returned as tools. Delivery
checks access and request state on each attempt. Repeats use the same event ID;
HTTP acknowledgement is distinct from analysis completion. A cancelled/in-flight
callback cannot be recalled, but subsequent reads/plans remain guarded.

Ctrl-C, access-check failure, or the **one-hour maximum** stops the foreground
client and removes temporary runtime state/subscription secrets. No real data is
uploaded. This test does not itself install the native app or fulfill its separate
local approval/execution/receipt acceptance step.
