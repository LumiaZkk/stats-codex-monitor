# Chinese UI and visible request status (0.5 preview)

Diagnostics menus and the native dot test flow use Simplified Chinese when macOS selects it for this app, and English otherwise. The selection honors the ordered system/per-app language preferences. Technical JSON keys, hashes, and persisted protocol fields are unchanged.

The status window now shows a headline, short explanation, fixed-fixture notice, and appropriate actions. Technical request/receipt details are collapsed initially. The window stays alive across transitions, so clicking Send visibly enters discovery rather than replacing its own window. Discovery, submission, waiting, and approval verification show progress. Repeat Send/Check/Approve controls are disabled while a request is in flight; local Cancel remains available. Closing the window continues an already requested result check, as before.

No-runtime is reported as an unavailable local connection. The app cannot infer whether an absent runtime has stopped, expired, or is awaiting key entry. Connection help asks the user to keep the approved foreground runtime running and enter a temporary key only in its Terminal if prompted. It never reads a key, starts a service, or scans for processes. Runtime and socket protocol v2 are unchanged.

All remote input remains the fixed synthetic CPU 92% / normal memory / 80 GiB fixture. Proposal origin remains unverified; approval is still a separate local confirmation of exact allowlisted native actions. Real cached before/after readings have localized metric and freshness labels, and are explicitly distinguished from the synthetic fixture. Receipts do not claim performance improvement or completed optimization. Raw receipt evidence is unchanged and remains local.

## Verification

`./scripts/test-diagnostics.sh` runs production core/control-state assertions, actual Darwin socket/discovery cases, then AppKit smoke tests in English and Simplified Chinese. UI tests use isolated temporary state and injected empty discovery; they perform no network exchange, process launch, or real collection. They verify immediate click feedback, disabled duplicate submission, cancellation against a late discovery completion, persistent window identity, and receipt labeling. Actual AppKit renders are uploaded by CI for visual review.

Final interactive acceptance still requires the installed app: open SD, send while disconnected, check help, connect the approved foreground runtime, submit one synthetic request, wait for a proposal, review/cancel, and separately approve an allowed local test. Check app-language changes after relaunch, window resizing/details, close/reopen while waiting, and the displayed local receipt. No installation, runtime restart, merge, or release is part of this source change.
