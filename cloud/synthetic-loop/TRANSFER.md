# Manual native/browser transfer

This increment reuses the existing private Sites MCP. It introduces no additional server, Tailscale, native OAuth client, browser cookie copying, service credential on the Mac, or automatic event wake-up.

## Authentication boundary

The supported runtime path is the Site's own top-level browser sign-in. The hosting platform supplies authenticated user identity to server routes. MCP calls use the already connected Site plugin. No supported native device-pairing contract was found in the Sites runtime interfaces. Non-user service access does not provide user identity and is not used as a substitute. The native app therefore remains offline.

The selected fallback has explicit user steps:

1. Export a **synthetic request** from the native app.
2. Open the existing private Site in a signed-in browser, choose that file and inspect the fixed-fixture preview. Selection does not transmit the file.
3. Click **Submit synthetic request**. Both browser and server reject telemetry, unknown fields, invalid hashes and expiry.
4. Copy the request ID/instruction to the intended dot conversation and explicitly ask for analysis. This is not automatic wake-up.
5. Refresh the browser result and download the result file.
6. Import it in the native app, review the exact actions and independently authorize a local check if wanted.

No direct App upload/download or persistent pairing is claimed. The installed app is unchanged until a separately approved build/install step.

## File contract

Input `stats_synthetic_request` is a flat, sorted-key JSON object with schema version 1, fixed `high-cpu-v1` fixture, lowercase UUID-v4 `client_request_id`, creation/expiry timestamps (UTC `.SSS` `Z`), and `client_request_hash`. The hash is SHA-256 of canonical sorted-key JSON excluding the hash field. Input may be pretty-printed with whitespace but must use sorted unique keys and canonical string values. The time window is at most 30 minutes; a two-minute future-clock tolerance is allowed. The file limit is 16 KiB.

The server request embeds the original input as `client_request`; its hash covers that binding. Request expiry is no later than the original input expiry. Idempotency keys cannot be reused for a different transfer.

Output `stats_synthetic_result` includes `integrity: unsigned_sha256`, the original client request, exact `request_canonical_json` and `proposal_canonical_json` strings with corresponding SHA-256 hashes, `status: proposed`, and export time. Hash the exact UTF-8 string bytes before decoding. There is no parallel nested request/proposal that could disagree with those bytes.

The result is **unsigned**. Hashes detect mismatches and bind content; they do not prove who authored a file. Never describe a valid hash as authentication or trust the file as permission to execute. The native importer must reject unknown/duplicate fields, invalid fixed fixture, mismatched local request, hashes, expiry or replay. Cross-language golden files are in `fixtures/`; their fixed clock is recorded in `native-vectors-v1.json`.

## Separate local approval

Every cloud proposal remains `dry_run: true`. It can suggest only:

- `open_activity_monitor`, target `current_device`
- `observe_metrics`, selected from `cpu_utilization`, `memory_pressure`, `disk_free_gib`, for 60–120 seconds (default 60)

The app must not execute the imported proposal. A distinct local approval operation derives and displays an immutable allowlisted local-check manifest. Only an explicit local approval of that exact manifest can call known native functions. Unknown commands, URLs, paths, PIDs, process termination and deletion are excluded. No model makes decisions after approval.

Local before/after evidence must retain timestamps and freshness, distinguish unavailable measurements from zero, and state that the diagnosis input was synthetic and unsigned. Real local observations stay on the device; this Site has no endpoint that accepts them.

Cancellation on the server blocks later proposal submission/download. It cannot recall a file already downloaded to an offline app. Local cancellation, expiry and replay protection are independent mandatory guards. Do not promise immediate remote revocation of an offline file.

## Verification

Run `npm ci --ignore-scripts`, `npm test` and `npm run typecheck` in the public `cloud/synthetic-loop` directory. The dedicated Synthetic bridge CI job runs those commands on the exact PR commit, separately from the existing macOS archive job. Tests cover the manual transfer, golden hashes, identity isolation, expiry, cancellation, duplicate requests, pre-upload field rejection, and legacy fixture separation.

Native Swift compilation, native approval behavior and macOS archive checks belong to the separate native increment. A local/mock test is not a live browser or installed-Mac verification.
