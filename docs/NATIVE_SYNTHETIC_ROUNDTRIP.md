# Native synthetic file roundtrip (experimental)

This increment adds a manual file boundary to the existing local monitor. It is not native authentication, live-data upload, automatic dot delivery or remote execution.

## User flow

1. Open SD → Synthetic dot roundtrip → Create synthetic request
2. Review the unmistakably **synthetic** request; save its JSON file. It contains only a random client request ID, fixed fixture selector, timestamps and an integrity hash. No current metrics, device identifier, local receipt or credential is exported
3. Manually import the request in the signed-in private companion Site and explicitly submit. Ask dot in the intended conversation to read that synthetic request and submit a dry-run proposal. The public native app contains no private Site address or pairing endpoint
4. Download the proposed result from the Site, then import the file in SD
5. Review **UNSIGNED / ORIGIN NOT AUTHENTICATED**, the inert untrusted summary, exact bounded actions, expiry and full manifest hash
6. The imported cloud proposal remains `dry_run: true`. A separate explicit local approval authorizes a deterministic **local test manifest**. Only the listed native test functions can run
7. Read the local before/after receipt; optionally save it yourself. Nothing is uploaded automatically, and the synthetic browser endpoint does not accept local measurements

Creating a newer native request replaces the pending request. Cancelled, already imported, completed or unmatched files cannot be replayed. Closing the review window is not approval. Cancelling the approval dialog runs nothing. After approval, cancellation stops further actions/observation; an Activity Monitor launch already requested from macOS cannot be retracted or automatically closed.

## Hard execution boundary

The complete allowlist is:

- `open_activity_monitor`: fixed current-device target. The native app verifies Apple's `com.apple.ActivityMonitor` at the fixed system-app path. No path, arguments, PID, URL or executable field is accepted
- `observe_metrics`: a unique subset of `cpu_utilization`, `memory_pressure`, `disk_free_gib`, for an integer60–120 seconds. Existing Stats callbacks supply readings; no collector or command starts

There is no shell, process termination, file deletion, optimization script, settings/security change, network upload, persistent listener or provider credential access. Opening Activity Monitor is not an optimization. The receipt permanently marks `optimizationPerformed: false` and `originAuthenticated: false`.

Local receipt readings are actual cached Mac measurements, labelled `measurementSource: existing_local_stats_collectors`, with source timestamps and fresh/stale/unavailable status. They are distinct from the fixed synthetic92%-CPU fixture. Before/after data is not proof of improvement. No new reading is fabricated if the collector is paused, disabled or stale.

Approval is saved before a side effect. Request/manifest identity is rechecked, a second approval cannot execute twice, and expiration is checked before each action and throughout observation. Sleep, pause, module changes, clock/run-loop gaps, cancellation and app restart interrupt execution; it is never automatically resumed. A10-second app-opening timeout is reported as uncertain, never as a completed optimization.

## File validation and integrity limitations

Request and result envelopes are version1, with exact field sets, lowercase UUIDv4 IDs, UTC millisecond timestamps and a30-minute request lifetime. Maximum result size is16KiB. Duplicate object keys, excessive nesting, unknown fields/actions/metrics, booleans in numeric positions, duplicate actions/metrics, wrong request hashes, changed canonical payload bytes, mismatched local pending requests, invalid/expired dates and replayed states are rejected.

Server and client creation/export timestamps permit at most120 seconds of clock skew. Expiry remains strict. The client-request hash is sorted-key ASCII JSON. Returned server request/proposal data is carried as exact canonical JSON strings, hashed as UTF-8 and then strictly decoded, avoiding JS/Swift floating-point or Unicode serialization differences.

SHA-256 is **not author authentication**. Someone who has the request can rewrite allowed fields and recompute hashes. No signature or native pairing is claimed. The mandatory review, exact local allowlist, device-local pending request state and separate approval remain the execution boundary. An attacker with write access to the local app state is outside that integrity boundary; no returned file can introduce a new action type.

## Persistence and privacy

Local request/approval/replay metadata and at most20 receipts are stored in `synthetic-roundtrip-v1.json` under the monitor's existing owner-only directory. File mode0600/directory0700. Receipt measurements are pruned after seven days using the existing one-minute housekeeping timer and on lifecycle operations. While the Mac/app is stopped cleanup resumes next launch. User-exported files are not automatically deleted.

The public golden fixtures are intentionally fake, with UUIDs containing repeated a/b/c characters and a fixed test clock. The native tests consume exactly the same fixtures as the browser contract and test hostile mutations, hashes, skew, expiry, replay, approval binding, cancellation, persistence and restart behavior.

## Verification boundary

Run `./scripts/test-diagnostics.sh`, then the normal unsigned macOS CI build. Tests never open Activity Monitor or perform GUI actions. Native manual acceptance is still required for request preview/save/cancel, malicious file rejection, repeated clicks/reopen, local approval/cancel, Activity Monitor permission/error handling,60-second observation, interruption and receipt review. Do not install, merge or release this increment merely because CI passes.
