# Global diagnostic contract v1

This route is disabled unless the verified foreground scope mode is
`exclusive_personal_global_diagnostics_v1`. It uses the same exclusive personal tunnel;
it does not install a service or save a runtime credential. The native application
must obtain upload consent and later a separate local action approval.

## Request

Socket commands are exact objects:
`{schema_version:2,op:"diagnose_real"|"result_real"|"cancel_real",expected_instance_id,client_request}`.
`client_request` is `{schema_version:1,kind:"stats_real_request",client_request_json,client_request_hash}`.
The hash is SHA-256 of the exact UTF-8 JSON string bytes. The string must be
canonical sorted-key JSON, strict parsed without duplicate/unknown keys. Its body:

```
{
  "schema_version": 1,
  "kind": "stats_real_diagnostic",
  "client_request_id": "UUIDv4",
  "created_at": "UTC milliseconds",
  "expires_at": "UTC milliseconds",
  "consent": {"scope":"global_diagnostics_v1","confirmed_at":"UTC milliseconds"},
  "snapshot": {
    "host_cpu_basis_points": 0,
    "cpu_observed_at": "UTC milliseconds or null",
    "memory_pressure": "normal|warning|critical or null",
    "swap_used_bytes": 0,
    "memory_observed_at": "UTC milliseconds or null",
    "disk_free_bytes": 0,
    "disk_observed_at": "UTC milliseconds or null",
    "disk_read_bytes_per_second": null,
    "disk_write_bytes_per_second": null,
    "io_observed_at": null
  },
  "candidates": [{
    "candidate_id":"UUIDv4",
    "display_name":"recognized ordinary app name",
    "category":"ordinary_gui_app",
    "cpu_basis_points":0,
    "resident_bytes":0,
    "interval_ms":2000,
    "observed_at":"UTC milliseconds",
    "measurement_scope":"main_process_only"
  }],
  "consumers": [],
  "coverage": {"scope":"visible_processes_bounded","pid_limit":4096,"sampled_processes":0,"unavailable_processes":0,"truncated":false,"helpers_aggregated":false},
  "recent_samples": [],
  "capabilities": ["quit_app","observe_metrics"]
}
```

Host metrics can be null if unavailable. Initial request app CPU/RSS must be nonnull. Host CPU is 0..10000; app CPU is
0..10240000 (10000 means one fully occupied core). Byte counts are integers
0..9007199254740991. App interval is 1500..5000ms (target2000ms), observed within 30s before
created_at. Host CPU/memory observations are at most 120s old; disk at most600s.
Unavailable groups have null timestamps. No observation is more than 1s after
created_at. App display name is 1..128 characters without controls. The request has at most5 candidates and10 consumers. Candidates are eligible signed
ordinary GUI app main processes. Consumers are the deduplicated union of top5CPU
and top5RSS among at most4096 visible processes, including ineligible processes.
Each consumer has exactly `{consumer_id,display_name,category,cpu_basis_points,resident_bytes,interval_ms,observed_at,measurement_scope:"single_process",quit_candidate_id}`.
quit_candidate_id is null or references a candidate whose measured process is that
consumer. Category is ordinary_gui_app, protected_app, system_process, app_helper
or unknown_process. Only ordinary_gui_app may include its actual app display name.
Other category display names must respectively be exactly Protected app, System
process, App helper or Other process. No raw custom process name is uploaded.
Coverage counts are integers0..4096; sampled+unavailable<=4096. The displayed
coverage explicitly excludes inaccessible/unattributed processes and does not
aggregate helpers. Each candidate/consumer ID is unique, lists are deterministic.
Recent samples is at most5 objects `{observed_at,host_cpu_basis_points,memory_pressure}`,
oldest first, unique timestamps, within5min of creation; nullable values reflect
actual caches. Disk I/O rates are nullable nonnegative safe integers with their
own timestamp at most120s old. Capabilities is exactly the ordered pair above.
No bundle ID,
PID, process start identity, code signature, executable path, document, window
title, network information, arbitrary text or command is accepted. Request lifetime
is at most10min; client clock future tolerance120s. Consent timestamp lies within
the10min preceding creation. Metrics represent timestamped cached observations,
not a fabricated10s system sampling window.

## Plan and result

Cloud reads the request using existing get_diagnostic_request/get_diagnostic_result.
The immutable server request is `{schema_version:2,request_id,stream_id:"global-device-v1",synthetic:false,created_at,expires_at,client_request}`.
`request_hash` hashes its canonical JSON. Plan sent to submit_diagnostic_plan:
`{schema_version:2,request_id,request_hash,plan_id,expires_at,dry_run:false,requires_local_approval:true,policy_id:"local_capabilities_v1",decision:"recommend_quit"|"observe"|"no_action",summary,actions}`.
Summary is at most1000 Unicode scalars; full proposal canonical JSON is at most4096 UTF-8 bytes. Server request canonical JSON is at most14000 UTF-8 bytes. For recommend_quit, actions is exactly
`[{type:"quit_app",candidate_id}]` and candidate_id selects an eligible member of request candidates.
For observe, actions is exactly `[{type:"observe_metrics"}]`. For no_action, actions is empty. Recommend_quit requires observed app CPU>=2500bp
or RSS>=536870912 bytes. Plan expiry is canonical, future, within request expiry.

Socket status is `{schema_version:1,kind:"stats_real_socket_status",client_request_id,client_request_hash,request_id,request_hash,status:"requested"|"proposed"|"cancelled"|"expired",bundle:null|RESULT,receipt:null|{receipt_id,receipt_hash}}`.
RESULT is `{schema_version:1,kind:"stats_real_result",request_json,request_hash,proposal_json,proposal_hash}`;
JSON strings are canonical exact UTF-8 hash sources. Native pins server IDs/hashes,
strictly validates all fields and original envelope, and checks fresh server state
after local approval before committing effects. No cloud execution endpoint exists.

Local policy constants (not remotely configurable): same immutable selected app
identity; fresh CPU>=2500bp OR RSS>=536870912; normal cooperative termination only;
wait at most15s; observe locally for60s; never force quit, handle save prompts,
choose another target or claim that metric changes prove causation.

## Receipt

`receipt_real` is exactly `{schema_version:2,op:"receipt_real",expected_instance_id,client_request_id,client_request_hash,request_id,request_hash,receipt}`. It references the already-owned immutable request; all four IDs/hashes must match before storage. This avoids repeating the full request beside the receipt. The receipt field is `receipt:{schema_version:1,kind:"stats_real_receipt_envelope",receipt_json,receipt_hash}`.
Receipt JSON is canonical and has exactly:
`{schema_version:1,kind:"stats_real_receipt",receipt_id,client_request_id,request_id,request_hash,plan_id,plan_hash,candidate_id,policy_id:"local_capabilities_v1",started_at,completed_at,local_approval_at,outcome,quit_requested,process_exit_confirmed,before,after}`.
`outcome` is `no_action|observed|declined|cancelled|precondition_failed|quit_refused_or_timed_out|quit_confirmed`. candidate_id is null for observe/no_action, otherwise matches the plan target.
Approval is a timestamp or null. Before/after each use
`{observed_at,snapshot:<same snapshot object>,candidate:<chosen candidate object or null>}`;
after may be null for no-action/declined/cancelled/precondition-failed/refused outcomes. Before/after
may contain only those approved metrics/name/opaque target, never local identity.
After confirmed exit, app CPU/RSS and interval_ms are null (process no longer exists), not zero; observed_at equals completed_at.
Cancellation preserves truthful quit_requested/process_exit_confirmed even after
an effect; partial or absent observation is not presented as completed evidence.
Refused/cancelled after samples may use null CPU/RSS/interval together when
unavailable. Completed observation and ordinary quit_confirmed outcomes require
at least60s and an after observation. Receipt duration<=180s; started_at<=plan expiry for an attempted quit; completed_at
may follow expiry by at most180s. The receipt is one immutable record, idempotent
for identical bytes, conflict on replacement. It is evidence reported by the local
client, not cryptographic proof of native execution. A cancellation never erases
an already-reported effect.

## Events and bounds

Real stream is global-device-v1. diagnostic.requested carries IDs/hashes/expiry,
synthetic:false and stream_id only. diagnostic.receipt_ready additionally carries
receipt_id/receipt_hash, with no metrics or app name in webhook payloads. Both use
the existing signed official event protocol and same-owner storage. Real stream
subscription and read/write routes fail closed when the scope is synthetic.
The existing synthetic stream/automation is not changed by publishing this code.
Receipt-ready events expire10min after receipt completion; full receipts remain
readable until normal temporary retention ends. Socket responses acknowledge the
receipt ID/hash only; get_diagnostic_result includes its full canonical envelope.
All socket frames remain <=16384 UTF-8 bytes including newline, one frame,5s.
Maximum100 real requests; cancellation tombstones bind the exact client envelope.
Temporary runtime exit removes requests, receipts and signing secrets as before.
