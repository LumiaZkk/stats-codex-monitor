# Global diagnostic panel

`panel-app.mts` mounts `installDiagnosticPanel` through the pinned official MCP Apps SDK. The production surface starts a whole-Mac collection intent; it never asks the user to select an application first. The old synthetic controller remains isolated as a regression fixture and is not the primary panel flow.

The main UI separates native collection consent, receipt of a timestamped system/process snapshot, analysis from the bound dot, local approval, and native execution receipts. Native collection consists of confirmation to collect followed by preview and approval to send. This panel has no approval or execution tool, conversation-message API, or model-context update API. Tool output and names are rendered as inert text.

## Trust and lifetime

`real-panel-contract.mts` checks exact wire shapes, capabilities, candidate allowlists, collection consent scope/timing, canonical JSON, SHA-256 and immutable runtime/intent/request/proposal bindings before exposing data to the view. The historical `result_bundle` preserves the canonical proposal required to verify a receipt after request cancellation or expiry. Unknown fields and substituted identities fail closed.

`real-panel-controller.mts` starts no work automatically. User-triggered readiness refresh reads `open_diagnostic_panel` and may update capability flags only for the same instance and unchanged lease. Creation is gated on real diagnostics, the bound subscription pair, and native availability. Duplicate submits are suppressed; a retry reuses the same idempotency key or bound intent. The active request is read every five seconds, without overlapping calls. Errors pause reads. Disconnect, runtime expiry, invalid data, and teardown clear timers and invalidate late responses. Timer wrappers retain the Window receiver.

Collection consent is bounded by the intent expiry. Collected requests use their expiry until a plan is present. A validated plan permits receipt-only polling until the earlier of the runtime lease and plan expiry plus 180 seconds. A cancelled plan may still have already-started local effects, so its historical proposal remains visible and receipt-only polling continues within that bound. A verified terminal receipt is retained even if the surrounding request is cancelled or expired. No new approval is offered from expired/cancelled evidence.

## Display semantics

The metric cards contain values and observation times. Coverage states sampled/unavailable process counts, the PID cap, truncation, and nonaggregation of helpers. Process CPU uses one core as 100%, separately from whole-host CPU. Protected/system process identities use localized category labels. The recommendation is readable text, with technical hashes in collapsed provenance details. A receipt exposes factual outcome, local approval time, quit requested/exit confirmed flags, and before/after readings. Null readings are “不可用”, never zero. The UI states that observed differences do not establish causality.

## Verification

Run `node scripts/build-panel.mjs --record` after reviewing intended source changes, then `npm run check:panel`, `npm run typecheck`, and the panel tests. `tests/real-panel-contract.test.mts` checks strict browser validation; `tests/real-panel-ui.test.mts` exercises the state machine with deterministic clocks. The existing synthetic tests retain timer and SDK lifecycle regression coverage.

`tests/support/real-panel-browser-fixture.mts` serves the actual production HTML and SDK in a loopback iframe with an explicit test host. It exists to verify browser rendering/transport behavior and does not collect Mac data, obtain native consent, execute an action, or demonstrate hosted/current-dot acceptance. Live-host acceptance must be recorded separately against the pinned runtime and native process.
