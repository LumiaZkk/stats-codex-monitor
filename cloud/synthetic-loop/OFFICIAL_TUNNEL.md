# Official Secure MCP Tunnel gate

This directory's deployed Site remains a synthetic, manually invoked test bridge.
The official tunnel probe below is a **local integration test**, not an operational
tunnel or evidence that a dot has been woken automatically.

## Verified without credentials

On 2026-09-30, official `openai/tunnel-client` release v0.0.15
(`a390c168ff1b2d14e73a95991c186c6aba3ff5a0`) was downloaded from its release page
and its published SHA256 matched. The Linux amd64 archive hash was
`8c836dc5d68d68b663d9a5c5b28ff9fa780d9f7a3fffb1c306880b8f32fab5f1`.

Its supported `dev proxy` mode uses a local in-memory control plane and needs no
OpenAI credentials. Against our isolated synthetic stdio fixture it passed:

- `server/discover`, `events/list`, `events/subscribe`, `events/unsubscribe`
- Synthetic request create/read and hash-bound dry-run proposal return
- Duplicate subscription/request/proposal and unsubscribe idempotency

Use Node 24 and a separately verified official binary:

```sh
TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client node scripts/probe-official-tunnel.mts
```

The test starts only bounded local processes, clears its environment of API keys,
uses an ephemeral state directory, and stops the proxy on completion. No real
callback is sent. `fixture.invalid` is handled solely by an in-memory test adapter.
The stdio fixture refuses to start unless the test-only environment marker is set;
it must never be connected to a hosted tunnel or used as production authentication.

The MCP 2.0 stdio forwarding path requires these keys in each request's
`params._meta`, not just the HTTP `MCP-Protocol-Version` header:

- `io.modelcontextprotocol/protocolVersion`: `2026-07-28`
- `io.modelcontextprotocol/clientCapabilities`: `{}`

See the exact-release [configuration contract](https://github.com/openai/tunnel-client/blob/a390c168ff1b2d14e73a95991c186c6aba3ff5a0/docs/configuration.md#L559-L564).

## Authentication remains a deployment gate

The runtime API key authenticates the tunnel client to OpenAI. It does not prove
which end user owns an MCP request. A named stdio profile is not user isolation:
the official client uses a shared child per channel, and does not inject forwarded
HTTP Authorization into the JSON-RPC request.

A shared deployment must use an HTTP MCP endpoint that validates forwarded bearer
identity and enforces owner isolation. An exclusive personal prototype may use a
single-owner boundary only after the tunnel's account, workspace associations,
and access grants have been verified to allow that owner alone. Never invent user
headers, copy browser session cookies, reuse a Site-wide credential as user auth,
or treat a local test principal as authenticated production identity.

## Required live acceptance sequence

1. Inspect the intended Platform organization and target ChatGPT workspace, tunnel
   roles and associations. Reuse an appropriate existing tunnel if available.
2. Create or configure a restricted tunnel and runtime credential only through the
   approved setup flow. Do not place keys in chat, Git, fixtures or public logs.
3. Run the official client under supported supervision, validate `doctor`, and
   confirm healthy/ready status. Keep operator surfaces loopback-only.
4. Connect the private MCP through ChatGPT's Tunnel option. Discover the actual
   event in the target dot, then subscribe with bounded synthetic-only instructions.
5. Verify the signed callback challenge using the real supplied URL, persistent
   subscription state and connection-time validated/pinned HTTPS.
6. Create one synthetic request locally. Confirm the event wakes the **same dot**,
   which reads that exact request/hash and returns a schema-valid proposal.
7. Deliver the proposal back to the native app; require the existing explicit
   local manifest approval. Record the bounded action and before/after receipt.

Only step 7 completes the product loop. Discovery, local tests, or callback HTTP
2xx do not establish automatic wake or completed analysis. The official tunnel is
transport for MCP requests; MCP Events still require the server to send a separate
signed outbound HTTPS callback. Current-dot event support must be established live.

The [official setup guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
requires a tunnel ID, runtime key, Platform Tunnels Read/Use permissions and the
appropriate ChatGPT developer-mode/workspace access. Creating or editing a tunnel
also requires Manage. It supports private connections and currently excludes
public plugin distribution. Public generic source code may still be distributed;
each deployment needs its own approved private setup.

Protocol source: [MCP Events](https://developers.openai.com/plugins/build/mcp-events).
Management: [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
Binary source: [official latest release](https://github.com/openai/tunnel-client/releases/latest).
