# Same-server diagnostic panel

The official MCP Apps panel uses the existing private Tunnel server for every
operation. It does not send a prompt to another ChatGPT conversation. A click
creates a fixed synthetic request, and the already configured signed event
subscription routes that request to its subscribed conversation. The panel reads
the immutable result for that request ID and hash.

This increment is a controlled synthetic proof. It has no real capture button,
approval button, local action endpoint or execution receipt. `receipt: null`
means no local execution receipt exists; receiving a proposal is not execution.
The existing real native contract and its mandatory local approval are unchanged.

## Availability and binding

- `open_diagnostic_panel` is a read-only global/thread entry. It reports the
  current runtime instance, foreground lease deadline and whether the fixed
  synthetic stream has an active subscription
- `panel_create_synthetic_request` requires that live instance, a UUID
  idempotency key and the active synthetic subscription. It accepts no metrics
- Each panel intent pins the sole eligible subscription internally before request
  creation. Later subscriptions cannot redirect or duplicate its deliveries.
  The destination's conversation is established by the platform subscription,
  not inferred from a UI host name or a model-supplied chat identifier
- `panel_get_synthetic_result` and `panel_cancel_synthetic_request` require the
  same instance, owner, request ID and immutable hash
- Browser validation independently checks the exact fixed fixture, canonical
  request/proposal hashes, expiry and the synthetic dry-run action allowlist
- Unknown create outcomes can only be retried explicitly with the same key
- Polling is bounded by the request and runtime deadlines. Offline/error,
  teardown and cancellation stop polling; late results cannot replace newer UI
- Cancellation cannot undo a callback already accepted by the platform. If a
  create reply is lost, server cancellation is not claimed without its binding

The runtime must be connected to open a fresh panel. An already opened panel
shows an explicit offline/expired state when its deadline passes. This does not
turn the foreground process into a persistent service or store its runtime key.

## Build and protocol

The browser uses pinned official MCP Apps SDK code, bundled into one inline HTML
resource with a SHA-256-derived URI. CSP has no external network or asset domains.
SDK packages and esbuild are development dependencies; the packaged runtime
continues to run with Node 24 and the separately installed official tunnel client.
Generated SDK output is excluded from Git. Source, lockfile, licenses and the
expected HTML/script SHA-256 manifest are committed; CI regenerates the exact
artifact before testing. Portable delivery archives include the generated file.

    npm ci --ignore-scripts
    npm run build:panel
    npm test
    npm run typecheck
    npm run check:panel

Intentional UI/dependency updates must review and update `ui/panel-build.json`
with `node scripts/build-panel.mjs --record`; normal builds verify that manifest.

The MCP 2026-07-28 response envelope includes `resultType: complete`; cacheable
discovery/resource replies use private, zero-TTL caching. Legacy requests retain
their existing response shape. These fields matter: validating only legacy SDK
schemas does not enforce modern wire requirements.

## Acceptance

Code tests cover the synthetic request/event/plan binding, instance/owner/hash
rejection, duplicate intent handling, cancellation, expiry and UI races. The
official SDK renderer and modern envelopes have rendered successfully in a
private ChatGPT Work reference deployment. That is not acceptance of this new
Tunnel panel.

Live acceptance requires a connected approved foreground runtime, the existing
signed synthetic subscription, one panel click, an event in the intended dot,
and the exact returned proposal in that panel. No native execution is part of
this synthetic acceptance. Real collection from the panel requires a separate
native capability and explicit consent before it is enabled.
