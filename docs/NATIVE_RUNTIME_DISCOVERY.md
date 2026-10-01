# Automatic local runtime discovery (0.4.0 / build4 preview)

The primary synthetic diagnosis flow no longer asks for a temporary directory.
Click **SD → Synthetic diagnosis with dot → Send synthetic diagnosis to dot**.
The app verifies live runtimes in one dedicated per-user cache directory. One
valid runtime is selected automatically. If several are valid, an explicit choice
shows the session name from the end of its Terminal’s existing “Private run
directory” line, start time, short scope fingerprint and instance identifier.
This is a runtime choice, not a folder picker. No
filesystem paths, credentials or device telemetry are sent to dot by discovery.

If none is available, the app explains that the updated foreground Tunnel runtime
must be started and its temporary key entered directly in Terminal. It never
reads that key, launches a runtime, installs a service or claims automatic key
setup. A running older runtime needs the matching discovery update and a normal
foreground restart; no process is silently modified.

Each Send remains explicit and sends only the existing fixed synthetic fixture.
Analysis may use the subscribed dot's model plan. Result retrieval is automatic;
real bounded local actions still require their separate native approval and a
fresh immutable-proposal check. Real metric receipts stay on the Mac. File import
is secondary test tooling and cannot bypass a runtime-bound request's checks.

## Discovery contract

Only `~/Library/Caches/stats-codex-monitor/runtime-v1/` is enumerated. Both dedicated
directory components must be owner-only mode0700. At most8 descriptor filenames
and32 total directory entries are admitted. Native discovery writes/deletes
nothing and never scans home, temp directories, process lists or network ports.

The runtime atomically publishes `<instance_id>.json` only after its approved
lease and private socket are ready. A descriptor is a regular, non-symlink,
single-link, owner-owned mode0600 file, at most4096 bytes. Exact fields:

- schema_version1, kind stats_runtime_descriptor, protocol_version2
- instance_id: fresh lowercase UUIDv4 for this server process lifetime
- uid, runtime_pid: current OS user and server PID
- started_at, expires_at: canonical UTC milliseconds, at most1hour apart
- scope_hash: SHA-256 fingerprint of the previously approved scope, no raw scope IDs
- socket_path: canonical absolute path ending native.sock, within Darwin's path limit

The startup UUID is public identity metadata, not a credential. Clean runtime exit
removes only its matching descriptor. Native discovery rejects expired, changed,
wrong-owner, unsafe-permission and incompatible entries without using them.
Processes owned by the same OS user remain in the trust boundary; this is not
model authorship attestation or protection from a compromised user account.

## Live proof and race handling

At most8 local handshakes run concurrently with a shared five-second deadline.
The socket directory and socket must be owner-owned0700/0600. Native checks the
kernel peer UID and PID (Darwin getpeereid / LOCAL_PEERPID) before sending bytes.
A refused dead socket is ignored; a candidate with an unresolved timeout,
changed identity or failed handshake makes discovery incomplete and prevents
automatic selection of another responder. A fresh nonce is sent in `{schema_version:2,op:"hello_native",expected_instance_id,
nonce}`. The response result has schema_version2, kind stats_runtime_hello,
instance_id, protocol_version2, uid, runtime_pid, started_at, expires_at,
scope_hash and the exact nonce. Every field must match the descriptor.

The app pins descriptor bytes, device/inode identities and the socket inode. It
reopens the descriptor through a verified directory descriptor, rejects symlinks
and changed files, and rechecks before every send. Every discovered diagnosis,
result and cancel command uses schema_version2 plus expected_instance_id; the
runtime rejects a wrong startup identity before state mutation or event delivery.
The result/proposal bundle format stays unchanged. Legacy v1 commands remain
available only for compatibility tests.

A request's runtime instance is persisted before submission. Restart or uncertain
retry cannot silently move that request to a different runtime. If its original
runtime is gone, cancel it before creating another request. Discovery/IPC and late
callbacks respect local Cancel; nothing resumes automatically on app restart.

## Verification and remaining acceptance

Production Swift tests validate descriptor/hello schemas, expiry, challenges,
runtime binding persistence and cross-language golden fixtures. Actual Darwin
Unix socket fixtures cover unique/multiple runtimes, wrong peer PID, stale or
replaced descriptors, symlinks/hardlinks, permissions, missing registries, capacity
bounds, cancellation and eight slow peers sharing one deadline. These tests do
not need a Tunnel, key or hosted event delivery.

Exact-commit macOS CI must also compile the full unsigned app. Native UI acceptance
still needs the installed app with the matching foreground runtime: one-click
submission with no folder dialog, multiple-choice cancellation, stopped/expired
runtime, retry without duplicate events, returned review, separate approval and
local receipts. No installation, merge or release is implied by this preview.
