# Mac build, installation and QA handoff

## Verification status

Cloud Linux checks: source syntax parsing of new Swift files, Xcode/OpenStep source membership, plist/XML syntax, shell syntax, whitespace checks, and private-data review. The actual Swift tests, Xcode compile/link, native UI, OS notification delivery, sleep/wake and CPU/RAM footprint require a Mac and have **not** been run in this source preview. Syntax parsing is not type checking. Existing upstream syntax constructs unsupported by the parser are baseline exceptions, not declared compilation failures.

## Build once, without upstream release machinery

1. Check the source provenance: Stats v3.0.19 at `e42ffdf3fe9cf789649a741ab2a0fb15f377b7f3`; verify LICENSE is preserved
2. Confirm `xcode-select -p`, `xcodebuild -version`, free disk space and architecture. Initial target: Xcode 26.3, macOS 12+. Do not download a different Xcode unless authorized
3. Run `./scripts/test-diagnostics.sh`. It compiles the production Foundation-only core plus test harness, then exercises thresholds, cooldowns, recovery, gaps, rollback, disk escalation, sanitization, retention, bounded export and real persistence roundtrips
4. Run `./scripts/build-diagnostics.sh`. This repeats the small core tests, builds Release, then ad-hoc signs/verifies the local app. It does not install or launch anything
5. If compile fails, report the first real error and fix the smallest source issue. Do not bypass signing/security prompts, add privileges, install a helper, or fall back to upstream's update mechanism

Expected artifact: `build/Build/Products/Release/Stats Diagnostics.app`. Expected app ID: `io.github.LumiaZkk.StatsDiagnostics`; version 0.1.0/build1. Scheme remains named `Stats` for minimal project disruption. The source source-tree registration is explicit in the project; no Xcode manual file-add step is needed.

## Before installation

- Inspect the built app: no `WidgetsExtension.appex`, `SMC.Helper`, helper LaunchDaemon, upstream update/uninstall scripts, or embedded `smc` command
- Confirm separate identity in built Info.plist and the login-helper bundle ID
- Keep any existing monitoring service active until this app passes the checks below; do not stop/delete an existing monitor simply because compilation succeeded
- Install/launch only in the user's approved destination. No root or Full Disk Access should be needed
- Do not enable launch at login or accept unexpected permissions without user authorization

## Native QA

- CPU/RAM/Disk native menus render, no optional module runs, SD status menu appears
- Wait past the first fresh baseline: CPU/RAM appear at about 60 seconds, disk/process samples at startup and every five minutes
- Native history window opens, closes, reopens and resizes; long text scrolls, selecting/copying text works
- Diagnose previews only; repeatedly opening/closing produces no model invocation or network request
- Copy/Save contain at most the documented data; export unknown/custom executable names as `Other process`; no PIDs, usernames, paths, raw commands, serials, secrets or credentials
- Cancel Save or application chooser: no file export or app launch occurs
- Selecting an installed analyzer only opens it; no automatic paste/send/optimization occurs
- Enable notifications only if desired, verify OS permission handling and clicking an alert opens history. Avoid forcing real resource exhaustion to generate test notifications
- Test pause/resume and disabling each module: no stale red status and no fabricated duration after resume
- Test short and long sleep/wake: first post-wake CPU interval is ignored; five minutes of fresh high evidence are still needed
- Inspect runtime/files: no upstream lldb, raw widget cache, remote session, updater network request, desktop widget or SMC helper
- Check alert/cooldown fixtures via tests rather than filling disk or stressing the machine. Disk alerts are binary GiB, with recovery at 20 GiB
- Observe at least one full five-minute process/disk interval for duplicate readers, memory growth, CPU usage and file-write rate. Report actual measurements, not estimates
- Verify small hourly history files and owner-only permissions; restart to confirm disk episode/cooldown restored while CPU/memory duration evidence resets
- Only after successful app QA should an overlapping legacy monitor be disabled, if authorized; preserve its data/config for rollback

## Known limitations

- No end-to-end dot transport or one-click model invocation is implemented
- Diagnostics UI is English in this preview; Chinese README is provided
- Low sampling rate intentionally makes some native high-frequency charts sparse
- Optional-metric controls inherited from Stats may remain visible while their collectors are omitted
- The upstream native test target is retained; its app test-host path is adjusted for the fork name. Full upstream test coverage is not claimed
- Ad-hoc signed local builds are not notarized distribution releases; never claim Gatekeeper approval

## Optional cloud macOS CI

`.github/workflows/build.yaml` runs the real Swift tests and unsigned Xcode build on GitHub's standard `macos-latest` runner for pushes/PRs, with read-only repository permissions, no developer credentials, a 30-minute timeout, and a seven-day unsigned development artifact. This is normal CI, not a release or notarization workflow. Its result must be checked for the exact pushed commit; no run is claimed merely because this workflow exists. Runner Xcode version is printed. A successful run can reduce the Mac handoff to signature/install/native QA, but does not replace UI/performance validation.
