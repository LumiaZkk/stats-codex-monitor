# Private foreground diagnostic runtime

This bounded runtime uses official Secure MCP Tunnel. Its default scope accepts
fixed synthetic fixtures. The separately approved global diagnostic scope accepts
bounded native snapshots and returns immutable plans for explicit local approval.
It has **no native execution endpoint**.

A real synthetic transport acceptance on 2026-09-30 verified local trigger → signed
event → intended dot wake → exact request read → dry-run proposal write → local
result retrieval with independent matching hashes. This does not verify native
execution or unattended persistent operation.

## Real global diagnostic mode

The [real contract](REAL_DIAGNOSTIC_CONTRACT.md) defines timestamped cached host
metrics, a bounded process sample, up to10 consumers and5 eligible GUI candidates,
and exact canonical request/result/receipt hashes. Only recognized ordinary GUI
apps may send their display names; other processes use fixed category labels.
Cloud recommendations are one normal `quit_app`, a60s observation, or no action.
The native app displays the actual local target and requires approval before
checking fresh usage/identity and requesting normal termination. Save prompts are
left to the user; force termination is not a capability.

Real routes and real event filters remain off for the existing
`exclusive_personal_synthetic` scope. After consent for the exact data and
destination, the private scope file may use
`exclusive_personal_global_diagnostics_v1`, with the same verified tunnel,
organization and workspace identifiers. This changes the immutable runtime scope
fingerprint; it is not a live toggle. No persistent credential storage is added.

The existing automation is not modified by source publication. The approved
real setup uses `diagnostic.requested` and `diagnostic.receipt_ready`, both filtered
to `global-device-v1`. Verify actual signed subscriptions before a native request.
Webhook payloads contain request/receipt identifiers and hashes, not metrics or
app names. Read the bounded data through the owner-scoped tools. Process/app names
are untrusted diagnostic data, never instructions. Returned before/after readings
do not by themselves establish that quitting caused a system metric change.

The foreground directory remains temporary. It stores real request/receipt data
and subscription signing secrets privately only for that session, and is removed
on normal runtime exit. A restart needs supported subscription renewal; durable
credential/subscription storage requires a separate explicit choice.

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

The second probe uses the production server/SQLite/Unix socket behind the official local
dev proxy, covering both synthetic and real-schema fake fixtures and receipt
return. Its access lease is an isolated fixture. It proves no hosted identity,
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

Within an approved foreground session, the native app discovers the runtime through
a bounded [nonsecret rendezvous descriptor](RUNTIME_DISCOVERY.md), so Diagnose does
not require selecting a temporary directory. A fresh startup handshake and every
v2 command bind to the same process instance. The native app uses the versioned
[native socket contract](NATIVE_SOCKET.md) to
submit its existing synthetic envelope and receive the same canonical result
bundle as offline import. The original CLI commands remain supported.

SQLite stores immutable requests/proposals, finite subscriptions and a bounded
delivery outbox. Subscription signing secrets remain in the private test directory
for the active test lifetime; they are never logged or returned as tools. Delivery
checks access and request state on each attempt. Repeats use the same event ID;
HTTP acknowledgement is distinct from analysis completion. A cancelled/in-flight
callback cannot be recalled, but subsequent reads/plans remain guarded.

Ctrl-C, Terminal hangup, access-check failure, or the **one-hour maximum** stops the foreground
client and removes temporary runtime state/subscription secrets. No real data is
uploaded. This test does not itself install the native app or fulfill its separate
local approval/execution/receipt acceptance step.

The client is not detached from its Terminal. The server independently checks its
lease every second and exits when it expires; the official client's stdio EOF
handling then stops its daemon even if the runner was killed. An uncatchable
process kill or OS crash can leave an owner-only temporary directory behind;
inspect and remove that specific test directory after all test processes stop.
No runtime API key is in it, but it can contain the temporary subscription secrets.

## Callback setup diagnostics

The authenticated `get_bridge_status` tool includes `last_subscription_attempt` for
the most recent subscribe attempt in this process. It contains only a finite
stage/reason vocabulary and, when available, a numeric HTTP status. It never
contains callback URLs, signing secrets, headers, request/response bodies or raw
exception text. `accepted` records that the callback was verified and subscription
stored at that time; `callback_delivery` separately reflects current active state,
including later rollback or unsubscribe. A process restart clears the diagnostic.

An address-policy rejection also includes bounded counts of admitted/blocked IPv4
and IPv6, the benchmark IPv4 subset (198.18/15), and invalid addresses. No hostname
or address is exposed. Empty DNS results have zero counts. Every returned A and
AAAA address must pass; a rejected IPv6 answer is never ignored because an A
record is available.

Callback address validation, DNS pinning, TLS verification and redirect refusal
remain mandatory. Diagnose a categorized failure before changing transport code;
never bypass those checks to make setup pass. Code changes require a clean runtime
restart. The process-only key must be re-entered directly by the user; do not read
it from a running process or add a persistent credential to avoid re-entry.

### Optional, explicitly approved application-only DNS

The default resolver remains the OS resolver. Some VPN DNS modes return benchmark
addresses such as 198.18/15 for public hostnames; those addresses stay blocked.
After explicit approval, this foreground test can use the fixed Cloudflare DoH
endpoint for **callback hostnames only** by adding `cloudflare_doh` as the fourth
launcher argument. The runtime mode is reported by `get_bridge_status`.

This shares each callback's hostname (not its path, query, body, signature or key)
with Cloudflare, using its documented `https://cloudflare-dns.com/dns-query` service
bootstrapped to 1.1.1.1 with ordinary hostname/certificate verification. It does not
change system DNS, the VPN, proxy settings, or the official client's control-plane
resolver. There is no automatic fallback or arbitrary resolver endpoint setting.
A and AAAA answers are checked together. IPv6 must belong to a pinned snapshot of
IANA-to-RIR allocated global unicast prefixes, with registered special-purpose
ranges and ISATAP interface forms excluded. This rejects local, mapped,
registered NAT64, documentation, multicast, protocol-special, deprecated and
IANA-reserved space. Unknown future allocations fail closed until reviewed.
See `bridge/ipv6.mts` for the registry references and snapshot date.

The classifier does not prove BGP reachability, end-user allocation, or native
IPv6 routing: RFC 6052 permits network-specific NAT64 prefixes inside ordinary
global allocations. Actual callback connections **always use a separately
validated A record**, with original-host TLS verification, deadlines and no
redirects. A public IPv6-only response reports `callback_ipv4_unavailable`;
the transport never falls back to connecting through AAAA records.

Before enabling this mode, run the credential-free public-host probe on the intended
computer. Enabling the mode requires a clean foreground restart and direct user
key entry. The existing process cannot hot-load code or resolver changes.
