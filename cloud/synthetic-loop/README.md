# Synthetic same-dot roundtrip spike

This is a protocol prototype, not a completed monitor integration. No telemetry is accepted and no Mac action can execute.

## Current state

- Local signed mock-event roundtrip passes: create fixed request → verified mock callback → read tool → strict proposal write → client result.
- The private Site is a discovery/read/proposal probe. Its `events/subscribe` returns MCP `Unsupported` (-32014), feature `callbackTransport`, reason `callback_transport_unverified`. It does not accept, store or use callback secrets.
- Live plugin/event-source discovery and a manual same-dot tool roundtrip were verified on 2026-09-30. Automatic event delivery remains unverified and disabled.
- The next increment adds explicit signed-in browser file transfer for native synthetic requests; see `TRANSFER.md` for its manual steps and unsigned-file boundary.
- There is no native pairing, telemetry upload, persistent Mac agent, model-provider credential, server execute endpoint or shell field. Native offline import/export and separately approved local checks are developed independently.

## Contract and security

`create_synthetic_request` accepts only a UUID idempotency key and the `high-cpu-v1` fixture selector. All numbers come from the server fixture. Requests have a server UUID, stable event ID, immutable canonical SHA-256 hash and 30-minute expiry. D1 owns request/proposal state; reads and compare-and-set proposal writes are scoped by the trusted Sites-authenticated principal. Request creation and duplicate proposal writes are idempotent. A second different proposal is rejected. Cancellation and expiry hide/invalidate proposals. HTTP bodies are bounded at 16 KiB.

`get_diagnostic_request`, `get_diagnostic_result`, and `get_bridge_status` are read-only tools. `create_synthetic_request` and `submit_diagnostic_plan` are correctly marked mutating. Plans must reference the exact request hash and expire no later than it. Their only action variants are dry-run `open_activity_monitor` targeting `current_device` and dry-run `observe_metrics` with fixed metric names and 60–120 seconds. Unknown properties, commands, PID targets and non-dry-run plans fail validation. Human-readable summaries are inert data and are never interpreted as instructions to execute.

The hosted app trusts only the platform's `oai-authenticated-user-id` header behind the private Sites boundary. It has no user-identity fallback, fake user, custom credential or direct public backend. Local tests inject identities only into isolated test objects. Never expose this application behind a proxy that does not strip and authenticate that header.

## Official MCP Events mapping

Verified against [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) on 2026-09-30:

- MCP 2.0 discovery is `server/discover`, version `2026-07-28`, capabilities `tools` and `events`
- Methods: `events/list`, `events/subscribe`, `events/unsubscribe`
- Event name is this application's `diagnostic.requested`, filtered by `stream_id: synthetic-smoke-v1`
- Envelope: `eventId`, `name`, `timestamp`, `data`, `cursor: null`
- Subscription identity hashes authenticated principal + canonical arguments + event name + callback URL
- Signed callback verification precedes activation; Standard Webhooks HMAC covers ID, timestamp and exact serialized body
- Delivery IDs survive retries; signing timestamps refresh; 410/413 do not retry; 2xx means receipt, never analysis completion

`bridge/events.mts` implements this contract behind an injected subscription store, access check and hardened transport. Only isolated tests wire it up. The test store is in memory and is not a production persistence implementation. `bridge/node-https.mts` is a portable Node adapter with DNS validation, a pinned connection address, original-host TLS verification, no redirect following, timeouts and response bounds. Its conservative IP policy rejects all IPv6 and special IPv4 ranges. It is excluded from the Workers app and is not a deployed Node service.

## Verified hosting gap

OpenAI requires callback address validation at connection time and connecting to that address while verifying TLS for the original hostname. The normal Workers [HTTP implementation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) does not support the `lookup` option and wraps fetch. The ordinary Node adapter must not be replaced with fetch.

Workers sockets expose `expectedServerHostname` in type definitions, but the current [Cloudflare implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sockets.c%2B%2B) explicitly marks that option unsupported and can reject it. [Issue 6903](https://github.com/cloudflare/workerd/issues/6903) documents local/production differences. No actual ChatGPT callback destination has been observed or assumed to be on a blocked IP range. A production-verified, hostname-preserving egress path is required before enabling subscriptions. Neither bypassing TLS checks nor implementing TLS in userland is in this spike.

Production event enablement also needs durable subscription/outbox storage and access-revocation integration. No secrets should be stored in public source. The present deployment deliberately does not provision these until the transport and actual dot event support are established.

## Run and verification

Node 24 (Node 22.18+ supports the TypeScript stripping used by the pure contract tests):

    node --test tests/*.test.mts
    npm ci --ignore-scripts
    npm run typecheck

`tests/roundtrip.test.mts`: full isolated mock roundtrip, hashes, allowlist, idempotency, owner isolation, cancellation, expiry, protocol gate and SSRF address classification.
`tests/events.test.mts`: subscription identity/refresh, verification, invalid secrets/URLs, retries, filtering, revocation, termination responses and expiry. Reconstructs an event service over the same test store; this is not a durable process-restart test.
`tests/storage.test.mts`: executes generated D1-compatible SQL in Node SQLite, closes and reopens the database, and verifies request/proposal persistence and compare-and-set guards.

## Live acceptance gates, in order

1. Connect the private Site plugin through the platform approval UI. From the intended dot conversation, call `get_bridge_status` successfully. Do not treat plugin installation as a verified connection.
2. Confirm this plugin appears in the intended dot's supported event-source list. Discover its event schema there. If missing or unsupported, stop; do not substitute another chat or polling.
3. Provide a verified callback transport plus durable subscription/outbox and access-revocation integration. Obtain the user's event-subscription authorization and use the actual platform-generated subscription. Do not manufacture callbacks, signing credentials, agent IDs or chat IDs.
4. Confirm authenticated `server/discover`, `events/list`, real `events/subscribe`, successful signed challenge and persisted subscription. Create exactly one fixed synthetic request.
5. Establish the same intended dot received the exact event ID, retrieved the exact request/hash and submitted a schema-valid plan; then the test client must receive the identical plan/hash while unexpired.
6. Test duplicate delivery, owner isolation, cancellation, expiry and unsubscribe against the live path. Keep the final state dry-run. Only now can the synthetic same-dot roundtrip be called verified.

## Public repository boundary

Publish only generic contract, tests, migration schema and this documentation. Site runtime IDs, owner IDs, callback URLs, signing secrets, auth state and private source credentials must not be committed to the public monitor repository. The native diagnostics PR and installed build remain unchanged.

## Minimal-dependency continuation

The selected continuation uses explicit manual invocation in the existing dot conversation and signed-in browser import/export. It does not require a new callback host. Automatic event delivery remains out of scope for this increment. See `TRANSFER.md`.

The public package contains runtime-dependency-free contracts, fixtures, tests and generic Sites adapters under `site/`. Type definitions are development-only dependencies. Dedicated Synthetic bridge CI covers Node tests/type-checks; the existing macOS archive job does not substitute for those checks.
