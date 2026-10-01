> Version0.4.0 replaces the temporary-folder selection described below with [automatic verified runtime discovery](NATIVE_RUNTIME_DISCOVERY.md). The bounded result and local approval contract remains.

# Native synthetic socket preview

Version 0.3.0/build3 adds an explicit native menu action to the existing foreground
private Tunnel runtime. It is a development preview, not a notarized release.
The prior 0.2.0 file workflow remains secondary test tooling. No runtime, login
service, credential storage or persistent access is installed by this code.

## User flow

1. Start the separately approved foreground runtime with the user-entered temporary
   key and its verified private Tunnel subscription. The native app does not start
   this runtime or inspect its key, scope, lease, subscription files or environment.
2. In SD → Synthetic diagnosis with dot, choose the private run folder printed by
   that Terminal. Selection is session-only. Review the fixed fixture and model-use
   disclosure. Selecting the folder does not send a diagnostic request.
3. Click **Send synthetic diagnosis to dot**. One immutable request is persisted
   locally before submission. Repeated clicks show the same request. The sole
   fixture is CPU 92%, normal memory pressure and 80 GiB disk, explicitly SYNTHETIC.
   This is not a diagnosis of this Mac. Dot processing may consume model usage.
4. The app retrieves only this request every five seconds until a proposal arrives,
   an error/expiry occurs, or the user cancels. Closing the preview keeps waiting;
   quitting stops retrieval. Restart never resumes transport automatically.
5. A returned, validated dry-run proposal opens local review. The author is still
   unverified: hashes bind bytes and identity, not authorship. Review the exact
   native actions and separately choose **Approve local test**. No socket result
   can invoke approval or execution.
6. Approved actions can only open Apple's Activity Monitor and/or observe selected
   existing CPU/memory/disk collectors for 60–120 seconds. Real readings include
   timestamps and freshness. Before/after evidence and receipts remain local.
   Opening an app is not an optimization, and synthetic values are never evidence
   of improvement.

Keep the foreground Terminal open. A stopped runtime, lease expiry, wrong socket
or old protocol fails closed. Retry uses the same client envelope after uncertain
submission; it cannot extend expiry or create another pending request. Cancel the
current request before choosing a different runtime or starting a new one.

## Frozen local protocol

One UTF-8 JSON object followed by LF per connection, one response followed by LF
and EOF. Maximum 16,384 bytes including LF in each direction. The client has a
five-second total monotonic deadline. It does not expose TCP/HTTP or accept inbound
connections. All unknown fields and duplicate JSON keys are rejected.

Request keys: `schema_version:1`, `op`, and the existing `client_request` envelope.
Operations are `diagnose_native`, `result_native`, `cancel_native`. The request
contains only a random ID, fixed fixture name, timestamps and SHA-256. No real
metrics, device identifiers, process data, file content or credentials are inputs.

Success is `{result:{schema_version:1,kind:"stats_native_socket_status",status,
client_request_id,client_request_hash,request_id,request_hash,bundle}}`. Status is
requested, proposed, cancelled or expired; bundle is null except for proposed,
where it is the existing `stats_synthetic_result` envelope. The first successful
response pins the server request ID/hash during the app session. Proposal hashes,
strict schemas, client binding and expiry are independently revalidated before
review. A rejection is `{error:<bounded reason>}`; arbitrary error text is never
shown as instructions.

The directory must be owned by the current user and mode0700; native.sock must be
an owned socket of mode0600, not a symlink. The client checks the connected peer's
UID before sending and verifies socket identity again after connecting. Processes
owned by the same user remain inside this local trust boundary; this is not an
attestation of a model or protection from a compromised user account.

## Cancellation and interruption

Cancellation stops queued/in-flight IPC cooperatively (at most a 250ms poll interval)
and is saved locally before the app asks the runtime to cancel. Late
responses cannot revive it. Remote cancellation is best-effort and the UI reports
whether acknowledgement was received. Already delivered events cannot be recalled.
A cancelled/expired response cannot reach approval. After explicit local approval, socket requests are rechecked against the runtime
before approval is committed and any action starts. The user can cancel during
this check. A failure or changed proposal requires a new approval. Once local
approval is committed, cancellation at the remote runtime cannot recall it; use
the native Cancel control for the active local test. This is a local consent
boundary, not an atomic distributed execution transaction. An already submitted OS request
to open Activity Monitor cannot be recalled; Cancel does not close that app.

The runner still enforces proposal expiry before every action and during
observation. Sleep, pause, collection changes, clock/run-loop gaps, app termination,
and local Cancel interrupt measurement. There is no automatic retry or resume of
approved actions. Storage failure prevents dependent actions.

## Verification

`./scripts/test-diagnostics.sh` builds actual production Swift rules, protocol and
Darwin IPC code. Tests include cross-language golden proposal bytes, altered or
unknown fields, binding changes, expiry/replay/cancellation, and real temporary
Unix socket peers for good framing, permission/type/symlink checks, oversized or
multiple frames, missing EOF payload and the five-second deadline. No tunnel or
credential is used by these tests. Standard macOS CI also builds the unsigned app.

Native GUI acceptance is still required on the exact artifact: select/cancel setup,
repeat Send, close/reopen preview, uncertain submission/retry, cancel during
submission and waiting, disconnected runtime, returned review without execution,
explicit approval/cancellation, actual Activity Monitor launch, bounded local
measurement and its receipt, quit/restart, expiry and sleep. The earlier live
Tunnel CLI-to-dot test does not prove this native UI flow. Do not install, merge or
release this preview without the separate approved acceptance step.
