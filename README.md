# stats-codex-monitor

A local-first macOS performance companion, built as a small native extension of [Stats](https://github.com/exelban/stats).

CPU, memory, swap and startup-disk monitoring stay on your Mac. Open **SD → Diagnose…** to review a bounded, sanitized snapshot and explicitly share it with dot, Codex, or another analyzer. No AI runs in the background, and the app never executes an analyzer's suggested commands.

**Status: experimental source preview, version 0.1.0.** Cloud source checks have been run. A full macOS build, UI validation, and resource-use measurements are still required before calling this a working release. No prebuilt/notarized release is provided yet.

[Synthetic native roundtrip preview](docs/NATIVE_SYNTHETIC_ROUNDTRIP.md) · [简体中文](README.zh-CN.md) · [Mac build and QA](docs/MAC_VALIDATION.md) · [Architecture and privacy](docs/ARCHITECTURE.md)

## What this adds

- Existing native Stats CPU/RAM/Disk menus and settings, plus a small **SD** status/history menu
- Existing collectors reused: CPU/RAM/swap every 60 seconds; top CPU/RAM processes and disk capacity every 5 minutes
- An OS memory-pressure event catches critical pressure between polling intervals
- Seven days of local sanitized history, in small hourly files with bounded record counts
- Deterministic local alerts: CPU above 85% for 5 minutes; warning memory pressure for 3 minutes; critical pressure immediately; startup disk below 20 GiB, escalating below 10 GiB
- A 30-minute CPU/memory reminder cooldown, reset after recovery; disk alerts once per episode plus one escalation
- Sleep, pause, missing samples and backward clock changes cannot count as sustained evidence
- Explicit diagnostic prompt preview, Copy, Save and Open analyzer application actions

## Current analyzer integration

There is **no automatic dot upload or one-click model execution** in this preview. Review the prompt, copy or save it, then submit it in your chosen analyzer yourself. Only that submission may consume your plan or incur charges.

The export contains at most 90 readings from the last 30 minutes plus 12 recent alerts, capped at 64 KiB of JSON. It contains numeric measurements and fixed process categories, not raw process names, PIDs, command lines, environment variables, paths, serial numbers, account details or credentials. The prompt asks for advice without tools or automatic fixes; the app does not control the separate analyzer's tool permissions.

Codex CLI `exec --sandbox read-only` is not a snapshot-only security boundary: it can still allow file inspection, and configuration/plugins vary. This preview deliberately uses an explicit export workflow until a supported, verifiable adapter can meet the same privacy contract. No private URL scheme, undocumented endpoint, credentials bridge, incoming command listener or remote shell is implemented.

## Build on a Mac

Requires macOS 12 or later and full Xcode with its command-line tools selected. The fork keeps upstream Swift 5 project settings. Xcode 26.3 is the initial intended verification environment; compatibility is not yet certified.

```sh
git clone https://github.com/LumiaZkk/stats-codex-monitor.git
cd stats-codex-monitor
./scripts/build-diagnostics.sh
```

The script runs the actual Foundation-only rule/privacy tests, builds with Xcode, and applies an ad-hoc local signature. It does not install, launch, enable a login item, notarize, or use developer credentials. Output: `build/Build/Products/Release/Stats Diagnostics.app`.

For rule tests alone:

```sh
./scripts/test-diagnostics.sh
```

Do not use the upstream Makefile's release workflow: it is retained for attribution/history and assumes upstream release credentials, signing and distribution settings. Follow [the Mac QA checklist](docs/MAC_VALIDATION.md) before installing or replacing another monitor.

## Privacy and controls

- No monitoring data leaves the process automatically. The fork disables upstream Remote and update downloads
- Sensors, Bluetooth, network monitoring, GPU, battery, Clock, desktop widgets and SMC/fan tools are not instantiated by this edition; desktop widget and privileged helper payloads are not shipped
- The native raw-reader database is disabled. Only sanitized diagnostic history is persisted
- Local notification delivery is opt-in: **SD → Enable local notifications…**. Status/history work without notification permission
- Data is stored under `~/Library/Application Support/StatsDiagnostics/`, with owner-only directory/file permissions
- Retention cleanup runs on launch, samples and a one-minute housekeeping timer (up to its ten-second tolerance); while the Mac/app is off, cleanup resumes at next launch/wake. No collection is added by housekeeping
- Explicit exports are user-owned files and are not deleted by automatic history retention
- The app has a separate bundle ID (`io.github.LumiaZkk.StatsDiagnostics`), preferences, login-helper identity and data directory. It cannot silently update itself to upstream Stats

## Scope and limitations

This is an analyzer-neutral companion, not an autonomous optimizer. The first release favors low-rate, interpretable evidence over high-frequency graphs. APFS free-space reporting can differ from Storage settings because of purgeable space. Top-process CPU values come from upstream `ps` and are process lifetime averages, not guaranteed five-minute interval samples. Native controls for optional metrics may still be visible but show no samples. Settings remain local and user controlled.

Future adapters should preserve preview/consent, bounded data, no background LLM requests, explicit approval of consequential recommendations, and independent local execution approval. A future transport is not an implemented feature.

## Upstream and license

Based on Stats **v3.0.19**, commit `e42ffdf3fe9cf789649a741ab2a0fb15f377b7f3`, by Serhiy Mytrovtsiy and contributors. Upstream copyright notices and [MIT LICENSE](LICENSE) are preserved; [the original README](UPSTREAM_README.md) is retained. This is an independent experimental fork, not an official Stats or OpenAI product.
