# One-shot native global collection

This extension is enabled only by the verified foreground
`exclusive_personal_global_diagnostics_v1` scope. It adds metadata-only collection
intents; no collection, upload, approval, target selection or execution occurs in
the MCP tool handler. The native application must show explicit one-shot consent
before collecting and uploading. Local action approval remains a separate step.

## Panel and chat tools

`open_diagnostic_panel` returns the exact object:
`{schema_version:2,kind:"stats_tunnel_panel",synthetic,connection,subscription_ready,real_enabled,real_subscription_ready,native_collection_available}`.
`synthetic` is the inverse of `real_enabled`; `subscription_ready` describes the
legacy synthetic stream. `connection` is
`{state:"online",instance_id,expires_at}`. Native availability means a valid
metadata poll was seen in the last 15 seconds, not a guarantee of future consent.

Both the panel and a chat may invoke:

- `panel_request_global_diagnostic({expected_instance_id,idempotency_key})`
- `panel_get_global_diagnostic({expected_instance_id,intent_id,intent_hash})`
- `panel_cancel_global_diagnostic({expected_instance_id,intent_id,intent_hash})`

Every input object is exact. IDs are UUIDv4; hashes are lowercase SHA-256.
The immutable intent is exactly
`{schema_version:1,kind:"stats_global_collection_intent",intent_id,created_at,expires_at,consent_scope:"global_diagnostics_v1"}`.
Times use UTC milliseconds. Its hash covers canonical sorted-key JSON. Lifetime
is at most 600 seconds, bounded by the runtime lease. One unfinished intent may
exist per owner; retry uses the same idempotency key. At most 100 intent records
are retained, with normal temporary retention through 24 hours after expiry.
The creating runtime instance is also persisted internally. A replacement server
process cannot claim, read, cancel, submit or adopt a prior instance's intent,
including through a repeated idempotency key. Pre-binding database records remain
inert after migration. This does not add a public protocol field.

Tools return
`{schema_version:1,kind:"stats_global_panel_result",synthetic:false,connection,intent,intent_hash,status,data,result_bundle}`.
Status is `awaiting_native`, `awaiting_consent`, `requested`, `proposed`,
`declined`, `cancelled` or `expired`. `data` is null until a consented native upload
is bound, then the existing real read result. `result_bundle` is null until a plan
exists, then the immutable `stats_real_result` canonical bundle. It remains
available after cancellation/expiry for receipt verification and history; it
never grants permission to execute an expired or cancelled plan.

## Native socket

Use the verified existing descriptor and same-UID private socket. Every command
is an exact object with `schema_version:2`, `expected_instance_id` and
`native_session_id` (an in-memory UUIDv4 for this native session):

- `op:"next_global_collection_intent"` has no other fields. It atomically claims
  one pending intent. Its result is
  `{schema_version:1,kind:"stats_global_collection_poll",intent,intent_hash}`;
  the last two fields are both null when nothing is claimable. Repeating a poll
  in the same session returns the same claim. Another session cannot steal it.
- `op:"resolve_global_collection_intent"` additionally takes `intent_id`,
  `intent_hash`, `decision:"declined"`, and returns the empty poll result.
- `op:"diagnose_real_for_intent"` additionally takes `intent_id`, `intent_hash`,
  and the existing `client_request` real envelope. It returns the unchanged
  `stats_real_socket_status` result. Native `client_request_id` must equal
  `intent_id`. Creation and consent timestamps must not predate intent creation;
  request expiry must not exceed intent expiry. Submission must occur before
  expiry, on the claiming session, while the intent remains uncancelled and its
  pinned subscriptions remain live. Request insertion, destination pinning and
  attachment to the intent commit in one SQLite transaction.

Socket success still wraps `{result:...}`, failure `{error:<finite reason>}`.
Existing frame size (16,384 bytes including newline), strict JSON and 5-second
deadlines apply. Poll only while the native app has a verified live foreground
runtime, at a bounded interval (5 seconds), never through a launch-on-login or
background daemon. Remember displayed intents locally so retries cannot prompt
again or imply repeated consent. A native session reset does not reclaim old
consent: cancel or let the old claim expire.

After upload, existing `result_real`, `cancel_real`, `receipt_real` and the
independent local action approval flow remain unchanged. Retrying an upload uses
the exact original envelope, even when acknowledgement was lost. The old direct
`diagnose_real` path cannot submit an intent-bound request.

## Destination and evidence

New intents and direct native uploads require exactly one active
`diagnostic.requested/global-device-v1` subscription and exactly one active
`diagnostic.receipt_ready/global-device-v1` subscription. Their IDs are pinned
separately, never replaced by later subscriptions. Event-specific callback URLs
may differ. The platform establishes which conversation owns these subscriptions;
the runtime cannot prove conversation identity from a caller-supplied chat ID.
One known automation must therefore own the pair, and live acceptance must
verify both arrive in the intended original conversation. A second matching
subscription makes new admission fail closed. Existing pinned events continue
only to their original subscription IDs; an unavailable destination never causes
retargeting. Pre-extension unpinned real rows do not broadcast.

Events use the existing signed official webhook transport and contain IDs/hashes
only. The proposal/receipt is read through owned tools. HTTP acknowledgement is
delivery acceptance, not analysis completion. Receipts report local observations,
not proof of causation. Cancellation prevents late upload and new actions after
native revalidation; it cannot recall a delivered event or undo an effect. An
already-returned receipt and its historical binding remain readable.
