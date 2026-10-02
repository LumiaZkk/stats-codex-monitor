# One-shot global diagnosis requests

Version 0.6.0 (build 9) accepts a one-shot collection intent from the panel or chat
through the already-approved foreground runtime. The native app never launches
that runtime, reads its key, or installs a service.

While Stats is awake and unpaused, a five-second timer checks only the dedicated
private runtime registry and verified same-user Unix sockets. Discovery retains
its eight-entry and five-second bounds; metadata exchanges share a further
five-second deadline, with no overlapping poll jobs. Polling stops during an
existing diagnosis or local action. Inbox requests contain only protocol version,
runtime UUID and a memory-only native-session UUID. They include no host readings,
process names, app targets, history or credentials.

An intent contains an ID, creation/expiry times (at most ten minutes), fixed
`global_diagnostics_v1` scope, and canonical SHA-256 hash. Unknown fields, altered
hashes, unsupported scopes and expired intents are rejected. The original runtime
and native session retain the claim. The native app does not migrate a request to
another runtime.

1. An intent opens **Allow one global diagnosis request?** No new process or host
   capture is performed by polling or presenting this prompt.
2. **Collect and preview** explicitly permits local collection. Before reading
   processes, native rechecks that the identical intent is still active.
3. The existing real-data preview separately asks **Agree and analyze** before
   uploading. No app needs to be chosen first. The request ID equals the intent ID
   and its expiry cannot exceed the intent expiry.
4. The existing immutable proposal, exact local approval, normal-quit/observe
   capability limits, durable receipt and result verification remain in use.

Closing or declining the unsubmitted prompt cancels local authority immediately
and attempts to decline that exact runtime intent. Sleep/pause cancels in-flight
work. Late confirmation cannot capture after cancellation. Seen intents are
remembered only until expiry, with a fixed memory bound. Expired unsubmitted
consent clears, allowing a subsequent new intent. If an upload response is lost,
**Retry same request** resends its original bytes; refresh cannot create another
snapshot under the same intent ID. Cancellation is required before starting over.

## Build and check

```sh
./scripts/build-diagnostics.sh
```

The script runs the native checks, probes the installed CoreWLAN SDK for
`CWPHYMode.mode11be`, and applies `STATS_LEGACY_COREWLAN` only when that enum case
is unavailable. The default source mapping stays intact for SDKs that support it.
The legacy build returns the existing `unknown` label for unrecognized PHY modes.
No network module permissions or collection behavior change.

The unsigned Xcode output is in `build/Build/Products/Release`. The script copies
that output without extended attributes to a fresh `/tmp/stats-diagnostics-release.*`
directory, signs it ad hoc, verifies the complete bundle, and prints its path.
This avoids FinderInfo reinjection on FileProvider volumes. It does not install,
launch, change login items, or connect the app.

For an arm64-only local build, the verified invocation is:

```sh
xcodebuild -project Stats.xcodeproj -scheme Stats -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath build \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) STATS_LEGACY_COREWLAN' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Omit the legacy condition when the probe succeeds. Test compilation uses a
workspace module cache. Unix fixture tests require permission to bind temporary
local sockets; they do not connect a live runtime. AppKit tests use inert transport
and collector boundaries to check no capture before consent, close during
confirmation, expiry, and byte-identical retry. They render both English and
Simplified Chinese, including Retina displays. These checks do not establish live
end-to-end delivery to dot, and do not authorize a live upload or local action.
