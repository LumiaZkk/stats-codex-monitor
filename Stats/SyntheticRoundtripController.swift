// Synthetic file exchange + separately approved, allowlisted local test actions.
import Cocoa
import Darwin

final class SyntheticRoundtripController: NSObject {
    typealias Capture = ([LocalMetric]) -> [LocalMetricReading]
    private let storage: LocalRoundtripStorage
    private let capture: Capture
    private var state = LocalRoundtripState()
    private var window: NSWindow?
    private var textView: NSTextView?
    private var displayedManifestHash: String?
    private var generation = UUID()
    private var observationTimer: Timer?
    private var openTimeout: DispatchWorkItem?
    private var storageFailure: String?

    init(directory: URL, capture: @escaping Capture) {
        storage = LocalRoundtripStorage(directory: directory)
        self.capture = capture
        super.init()
        do { state = try storage.load(at: Date()); try storage.save(state) }
        catch { storageFailure = "Local roundtrip state could not be read safely. No local action is available." }
    }
    func appendMenu(to menu: NSMenu) {
        let root = NSMenuItem(title: "Synthetic dot roundtrip", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        add("Create synthetic request…", #selector(createRequest), to: submenu)
        add("Import returned proposal…", #selector(importProposal), to: submenu)
        add("Review current request / proposal…", #selector(reviewCurrent), to: submenu)
        add("Cancel pending request / local check", #selector(cancel), to: submenu)
        add("Last local receipt…", #selector(showReceipt), to: submenu)
        root.submenu = submenu; menu.addItem(root)
    }
    private func add(_ title: String, _ action: Selector, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; menu.addItem(item)
    }
    private func transition(_ change: (inout LocalRoundtripState) throws -> Void) throws {
        if let failure = storageFailure { throw RoundtripError.invalid(failure) }
        var next = state
        try change(&next)
        try storage.save(next) // Commit approval/replay state before any side effect.
        state = next
    }
    @objc private func createRequest() {
        do {
            try transition { _ = try $0.create(at: Date()) }
            generation = UUID()
            reviewCurrent()
        } catch { show(error) }
    }
    @objc private func reviewCurrent() {
        if let failure = storageFailure { show(RoundtripError.invalid(failure)); return }
        if state.phase == .executing { showRunning(); return }
        if state.phase == .reviewing, let proposal = state.proposal {
            displayedManifestHash = proposal.manifestHash
            let actions = proposal.actions.enumerated().map { "\($0.offset + 1). \($0.element.description)" }.joined(separator: "\n")
            present(title: "SYNTHETIC · Unverified proposal · Local review", text: """
            SYNTHETIC FIXTURE — this is not a diagnosis of this Mac.
            UNSIGNED FILE: origin is NOT authenticated. SHA-256 only checks bytes and request binding.

            Cloud proposal remains dry_run=true. Nothing has executed.
            The actions below form a separate local test manifest. Approval here authorizes only these native functions on this Mac; it never authorizes a remote command or an optimization.

            EXACT LOCAL TEST ACTIONS
            \(actions)

            LOCAL RECEIPT EVIDENCE
            Before/after cached readings: \(metrics(for: proposal).map { $0.rawValue }.joined(separator: ", ")).
            Freshness and source timestamps are preserved; stale/missing data is not measured improvement.

            No shell, process termination, settings change, deletion, network upload, new collector, or remote listener is available.
            Observations stay local. Opening Activity Monitor is not a completed optimization.

            UNTRUSTED HUMAN-READABLE SUMMARY (inert text)
            \(proposal.untrustedSummary)

            Client request: \(proposal.clientRequestID)
            Expires: \(proposal.expiresAt)
            Proposal hash: \(proposal.proposalHash)
            Local manifest hash: \(proposal.manifestHash)
            """, buttons: [("Authorize local test…", #selector(authorize)), ("Cancel request", #selector(cancel))])
            return
        }
        displayedManifestHash = nil
        if state.phase == .waiting, let request = state.request {
            let json = (try? request.json()) ?? "Unavailable"
            present(title: "SYNTHETIC · Request preview", text: """
            SYNTHETIC TEST ONLY — no real telemetry, device identity or credentials.
            The fixed server fixture is CPU 92%, normal memory pressure, disk 80 GiB.
            It does not describe this Mac.

            Save this request only if you want to test the manual roundtrip. Import it in the signed-in private companion Site, explicitly submit there, and ask dot in your existing chat to read and propose a dry-run plan. Download the returned file and choose Import returned proposal here.

            This app has no pairing, account login, upload, polling, model call, or remote command channel. Browser sign-in and submission are separate manual steps. No fixed/private Site URL is embedded in this public app.

            A returned file is untrusted. You will review exact actions and separately approve any local test. This pending request belongs to this local app installation and expires after 30 minutes. Creating a new request replaces it.

            \(json)
            """, buttons: [("Save synthetic request…", #selector(saveRequest)), ("Cancel request", #selector(cancel))])
        } else {
            present(title: "Synthetic roundtrip", text: "State: \(state.phase.rawValue)\nCreate a new synthetic request to begin. Cancelled, expired or already imported files cannot be replayed.", buttons: [("Create synthetic request…", #selector(createRequest)), ("Last receipt", #selector(showReceipt))])
        }
    }
    @objc private func saveRequest() {
        guard state.phase == .waiting, let request = state.request else { return }
        do {
            _ = try SyntheticClientRequest.parse(RoundtripJSON.object(request.json()), at: Date())
            try saveFile(Data(request.json().utf8), name: "stats-SYNTHETIC-request.json")
        } catch { show(error) }
    }
    @objc private func importProposal() {
        guard state.phase == .waiting else { show(RoundtripError.invalid("Create a pending synthetic request first. Replayed or already imported proposals are rejected.")); return }
        let panel = NSOpenPanel()
        panel.title = "Import an untrusted SYNTHETIC result JSON"
        panel.allowedFileTypes = ["json"]
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let bytes = try readBoundedJSON(url)
            try transition { _ = try $0.receive(bytes, at: Date()) }
            reviewCurrent()
        } catch { show(error) }
    }
    private func readBoundedJSON(_ url: URL) throws -> Data {
        guard url.isFileURL else { throw RoundtripError.invalid("Only local regular JSON files are accepted") }
        let descriptor = url.withUnsafeFileSystemRepresentation { path in
            path.map { Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) } ?? -1
        }
        guard descriptor >= 0 else { throw RoundtripError.invalid("Could not open a regular local JSON file") }
        defer { Darwin.close(descriptor) }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0, (attributes.st_mode & S_IFMT) == S_IFREG,
              attributes.st_size >= 0, attributes.st_size <= off_t(RoundtripJSON.maximumBytes) else {
            throw RoundtripError.invalid("Only regular JSON files up to16KiB are accepted")
        }
        var bytes = [UInt8](repeating: 0, count: RoundtripJSON.maximumBytes + 1)
        var count = 0
        while count < bytes.count {
            let available = bytes.count - count
            let received = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), available)
            }
            if received == 0 { break }
            guard received > 0 else { throw RoundtripError.invalid("Could not safely read the JSON file") }
            count += received
        }
        guard count <= RoundtripJSON.maximumBytes else { throw RoundtripError.invalid("JSON file exceeded16KiB while being read") }
        return Data(bytes.prefix(count))
    }
    @objc private func authorize() {
        guard let hash = displayedManifestHash, state.phase == .reviewing, let proposal = state.proposal,
              proposal.manifestHash == hash else { show(RoundtripError.invalid("The displayed manifest is no longer current")); return }
        let alert = NSAlert()
        alert.messageText = "Run this separate local test?"
        alert.informativeText = "The imported proposal is synthetic and its origin is unverified. This approval applies only to:\n\n" + proposal.actions.map(\.description).joined(separator: "\n\n") + "\n\nNo optimization is performed. Metric observations remain on this Mac."
        alert.addButton(withTitle: "Approve local test")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            let before = capture(metrics(for: proposal))
            try transition { _ = try $0.authorize(manifestHash: hash, before: before, at: Date()) }
            generation = UUID()
            showRunning()
            runAction(0, generation: generation)
        } catch { show(error) }
    }
    private func metrics(for proposal: VerifiedSyntheticProposal) -> [LocalMetric] {
        let selected = proposal.actions.flatMap(\.metrics)
        return selected.isEmpty ? LocalMetric.allCases : LocalMetric.allCases.filter { selected.contains($0) }
    }
    private func current(_ expected: UUID) -> Bool { generation == expected && state.phase == .executing }
    private func runAction(_ index: Int, generation expected: UUID) {
        guard current(expected), let proposal = state.proposal else { return }
        guard state.mayContinueExecution(at: Date()) else { complete("expired_before_next_action"); return }
        guard index < proposal.actions.count else { complete("completed_local_test"); return }
        let action = proposal.actions[index]
        switch action.kind {
        case .openActivityMonitor:
            // Fixed system app, verified bundle identity, no caller-supplied path or args.
            let url = URL(fileURLWithPath: "/System/Applications/Utilities/Activity Monitor.app", isDirectory: true)
            guard Bundle(url: url)?.bundleIdentifier == "com.apple.ActivityMonitor" else {
                record("activity_monitor_unavailable")
                complete("failed_local_test"); return
            }
            record("activity_monitor_open_requested; an OS launch request cannot be retracted by Cancel")
            guard current(expected) else { return }
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, self.current(expected) else { return }
                self.record("activity_monitor_open_timeout; launch outcome is unknown")
                self.complete("failed_local_test")
            }
            openTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] app, error in
                DispatchQueue.main.async {
                    guard let self, self.current(expected) else { return }
                    self.openTimeout?.cancel(); self.openTimeout = nil
                    guard error == nil, app != nil else {
                        self.record("activity_monitor_open_failed; no optimization performed")
                        self.complete("failed_local_test"); return
                    }
                    self.record("activity_monitor_opened; no optimization performed")
                    self.runAction(index + 1, generation: expected)
                }
            }
        case .observeMetrics:
            let started = Date(), uptime = ProcessInfo.processInfo.systemUptime
            let duration = TimeInterval(action.durationSeconds)
            guard (60...120).contains(action.durationSeconds) else { complete("rejected_invalid_local_duration"); return }
            record("observation_started: \(action.durationSeconds)s; existing collectors only")
            guard current(expected) else { return }
            var lastSignature = ""
            let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
                guard let self, self.current(expected) else { return }
                guard self.state.mayContinueExecution(at: Date()) else {
                    self.interrupt(reason: "proposal_expired"); return
                }
                let elapsed = ProcessInfo.processInfo.systemUptime - uptime
                guard elapsed >= 0, abs(Date().timeIntervalSince(started) - elapsed) <= 5, elapsed <= duration + 15 else {
                    self.interrupt(reason: "clock_or_runloop_gap"); return
                }
                let values = self.capture(action.metrics)
                let signature = values.map { "\($0.metric.rawValue):\($0.observedAt ?? "missing"):\($0.freshness.rawValue)" }.joined(separator: "|")
                if signature != lastSignature, (self.state.activeReceipt?.observations.count ?? 0) < 30 {
                    self.state.activeReceipt?.observations.append(values)
                    lastSignature = signature
                }
                if elapsed >= duration {
                    self.observationTimer?.invalidate(); self.observationTimer = nil
                    self.record("observation_finished; compare timestamps and freshness, not synthetic fixture values")
                    self.runAction(index + 1, generation: expected)
                }
            }
            observationTimer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }
    private func record(_ message: String) {
        guard state.phase == .executing else { return }
        state.activeReceipt?.actionResults.append(message)
        do { try storage.save(state) }
        catch { interrupt(reason: "receipt_storage_failed") }
    }
    private func complete(_ outcome: String) {
        guard state.phase == .executing, let proposal = state.proposal else { return }
        observationTimer?.invalidate(); observationTimer = nil
        openTimeout?.cancel(); openTimeout = nil
        generation = UUID()
        do {
            let after = capture(metrics(for: proposal))
            try transition { try $0.finish(outcome: outcome, after: after, at: Date()) }
            showReceipt()
        } catch { storageFailure = "Receipt could not be saved. The local test will not resume."; show(error) }
    }
    func interrupt(reason: String) {
        guard state.phase == .executing else { return }
        observationTimer?.invalidate(); observationTimer = nil
        openTimeout?.cancel(); openTimeout = nil
        generation = UUID()
        state.activeReceipt?.actionResults.append("interrupted: \(reason)")
        do {
            try state.finish(outcome: "interrupted_\(reason)", after: [], at: Date())
            try storage.save(state)
        } catch { storageFailure = "Local check interrupted; receipt storage unavailable." }
    }
    func maintain(at now: Date) {
        let previousCount = state.receipts.count
        state.prune(at: now)
        if previousCount != state.receipts.count {
            do { try storage.save(state) }
            catch { storageFailure = "Expired local receipts could not be removed. Roundtrip actions are disabled." }
        }
    }
    func stop() { interrupt(reason: "app_termination"); observationTimer?.invalidate(); openTimeout?.cancel() }
    @objc private func cancel() {
        observationTimer?.invalidate(); observationTimer = nil
        openTimeout?.cancel(); openTimeout = nil
        generation = UUID()
        do { try transition { try $0.cancel(at: Date()) }; reviewCurrent() }
        catch { show(error) }
    }
    private func showRunning() {
        present(title: "SYNTHETIC suggestion · Approved local test running", text: "Only the reviewed native test functions are running. No model, remote upload or optimization runs.\n\nYou may cancel observation. An Activity Monitor launch already requested from macOS cannot be retracted; an opened app is not automatically closed. Sleep, pause or collection changes interrupt measurement; no automatic retry occurs.", buttons: [("Cancel local check", #selector(cancel))])
    }
    @objc private func showReceipt() {
        guard let receipt = state.receipts.last else { show(RoundtripError.invalid("No completed local receipt yet")); return }
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let text = String(data: try encoder.encode(receipt), encoding: .utf8) ?? "Unavailable"
            present(title: "Local test receipt · No optimization claimed", text: "SYNTHETIC suggestion; unsigned/unverified origin. The following observations, if available, came from this Mac's existing collectors and remain local. This receipt does not prove a performance improvement.\n\n" + text, buttons: [("Save local receipt…", #selector(saveReceipt))])
        } catch { show(error) }
    }
    @objc private func saveReceipt() {
        guard let receipt = state.receipts.last else { return }
        do { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; try saveFile(encoder.encode(receipt), name: "stats-LOCAL-test-receipt.json") }
        catch { show(error) }
    }
    private func saveFile(_ data: Data, name: String) throws {
        let panel = NSSavePanel(); panel.nameFieldStringValue = name; panel.allowedFileTypes = ["json"]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try data.write(to: url, options: .atomic)
    }
    private func present(title: String, text: String, buttons: [(String, Selector)]) {
        window?.close()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 600), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.title = title
        let root = NSStackView(); root.orientation = .vertical; root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 720, height: 500))
        view.isEditable = false; view.isSelectable = true; view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.autoresizingMask = [.width]; view.textContainer?.widthTracksTextView = true; view.string = text
        scroll.documentView = view; root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32).isActive = true
        let row = NSStackView(); row.orientation = .horizontal
        for (label, action) in buttons { row.addArrangedSubview(NSButton(title: label, target: self, action: action)) }
        root.addArrangedSubview(row)
        window.contentView = root; self.window = window; textView = view
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    private func show(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "Synthetic roundtrip"
        alert.informativeText = error.localizedDescription; alert.runModal()
    }
}
