# Architecture and privacy contract

## Small native extension

`Kit/DiagnosticsBridge.swift` is a local NotificationCenter bridge. CPU/RAM/Disk callbacks publish numeric measurements; CPU/RAM top-process callbacks publish at most five in-memory rows. The controller converts names to fixed categories before persisting them. The bridge does not start readers or create network clients.

`Stats/DiagnosticsCore.swift` contains the Foundation-only state machine, sanitized data model, bounded prompt builder and hourly persistence. It can be compiled without the Stats application or AppKit. `Stats/DiagnosticsController.swift` provides the native menu, history window, consent/preview workflow, local notifications and OS memory-pressure event subscription.

Only existing Stats CPU, RAM and Disk modules are instantiated. CPU and RAM reader intervals are fixed at 60 seconds; process readers run at 300 seconds even with popups closed; disk capacity runs at 300 seconds. CPU optional frequency/temperature/average collectors and Disk SMART/activity/process readers are not created. Native settings show the fixed diagnostic cadence. No new sampling timer exists; a 60-second housekeeping timer only ages metadata and refreshes stale UI.

The CPU collector rejects extra reads within 55 seconds so an on-demand native UI refresh cannot reset its tick baseline and manufacture a sustained signal. The controller drops startup/wake CPU baseline readings and cached upstream values are not replayed. Durations require consecutive observations with gaps no longer than 90 seconds. Pause, wake and rollback reset duration evidence.

## Alert episodes

- CPU: strictly greater than 0.85 for at least 300 seconds
- Memory warning: level 2 for 180 seconds
- Memory critical: level 4 immediately, including direct OS pressure events
- CPU/memory reminders: at least 1,800 seconds apart within an episode; normal recovery resets the episode
- Memory escalation is tracked by last alerted severity, so warning/critical oscillation cannot bypass cooldown repeatedly
- Disk: strictly below 20 GiB once per low-space episode; one escalation strictly below 10 GiB; recovery to at least 20 GiB resets
- Cooldown and disk episode metadata survive restart; sustained evidence does not
- Backward wall-clock changes restart evidence and clamp a future cooldown timestamp
- Indicators use fresh, enabled metric readings, not restored stale severity

These are sampled heuristics, not medical-style guarantees or proof of a failing machine. Native free capacity and process CPU measurements retain upstream semantics.

## Persistence

The fork disables the upstream raw-reader database at its construction/setup/write entry points. Module desktop-widget defaults are nil, and this build does not ship the desktop widget extension. Raw process names/PIDs and drive paths never enter the diagnostic archive.

Sanitized samples/events are kept in `history-<UTC-hour>.json`; cooldown metadata is in `episodes-v1.json`. Files are owner-readable/writable only (0600), directory 0700. Only changed hourly chunks plus the retention-boundary chunk are rewritten. Full-week rewrites are avoided.

Memory/history is bounded to 30,000 samples and 1,000 alert events, seven elapsed days, and 2 MiB per hourly file. The exporter additionally limits the most recent 30 minutes to 90 readings plus 12 alerts and 64 KiB JSON. There may be fewer than seven days during unusually heavy event activity due to the record cap. Cleanup is checked every minute with ten-second scheduling tolerance and upon launch/sample/save; cleanup while the app or Mac is off is impossible and resumes when active.

## Network, identity, and action boundaries

The fork's updater check/download/install paths refuse to operate. Remote service startup/login/requests are guarded, and no remote credentials are read/migrated during fork initialization. The app has a separate bundle/login-helper ID and data folder. Upstream scripts, helper payloads and desktop widget extension are excluded from the app bundle's build phases.

The analyzer action is intentionally neutral. It exports only the reviewed prompt and can open a user-selected installed application. It does not execute Codex CLI, paste into another app, submit a model request, launch a script, or receive remote commands. No provider credentials, tokens, private endpoints, or app URL schemes are introduced.

A future dot adapter needs a documented supported transport, explicit payload/recipient consent and independently authorized local execution. An AI recommendation must never become an executable command through this bridge. The current UI accurately states that the user must paste/send the export.

Codex CLI feasibility was checked using local `codex exec --help` (0.159.0-alpha.7), [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [schema](https://learn.chatgpt.com/docs/config-schema.json). Read-only is not tool-free; no complete snapshot-only interface was verified. No billed model was invoked during this research.
