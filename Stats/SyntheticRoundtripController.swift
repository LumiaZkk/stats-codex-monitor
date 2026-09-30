// Explicit synthetic socket exchange + separately approved, allowlisted local tests.
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
    // Runtime selection and polling consent live only in this app session.
    private var runtimeDirectory: URL?
    private let socketQueue = DispatchQueue(label: "StatsDiagnostics.synthetic-ipc", qos: .utility)
    private var pollingTimer: Timer?
    private var exchangeGeneration = UUID()
    private var exchangeInFlight = false
    private var socketMessage = "Choose the foreground runtime's private folder, then send a synthetic test."
    private var socketRequestID: String?
    private var socketBinding: SyntheticSocketBinding?
    private var approvalCheckInFlight = false
    private var socketCancellation = SyntheticSocketCancellation()


    init(directory: URL, capture: @escaping Capture) {
        storage = LocalRoundtripStorage(directory: directory)
        self.capture = capture
        super.init()
        do { state = try storage.load(at: Date()); try storage.save(state) }
        catch { storageFailure = "Local roundtrip state could not be read safely. No local action is available." }
    }
    func appendMenu(to menu: NSMenu) {
        let root = NSMenuItem(title: "Synthetic diagnosis with dot", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        add("Send synthetic diagnosis to dot", #selector(sendSynthetic), to: submenu)
        add("Review status / proposal…", #selector(reviewCurrent), to: submenu)
        add("Retry same pending request", #selector(retrySocketRequest), to: submenu)
        add("Cancel request / local check", #selector(cancel), to: submenu)
        add("Last local receipt…", #selector(showReceipt), to: submenu)
        submenu.addItem(.separator())
        add("Choose temporary runtime folder…", #selector(chooseRuntime), to: submenu)
        let files = NSMenuItem(title: "Manual file test tools", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu()
        add("Create file-test request…", #selector(createRequest), to: fileMenu)
        add("Save pending request…", #selector(saveRequest), to: fileMenu)
        add("Import returned proposal…", #selector(importProposal), to: fileMenu)
        files.submenu = fileMenu; submenu.addItem(files)
        root.submenu = submenu; menu.addItem(root)
    }
    @objc private func chooseRuntime() {
        guard !exchangeInFlight, pollingTimer == nil, state.phase != .executing,
              runtimeDirectory == nil || ![.waiting, .reviewing].contains(state.phase) else {
            show(RoundtripError.invalid("Cancel the current request or local check before changing the runtime.")); return
        }
        let panel = NSOpenPanel()
        panel.title = "Choose the foreground synthetic runtime's private run folder"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try SyntheticSocketTransport(directory: url).validateEndpoint()
            let alert = NSAlert()
            alert.messageText = "Use this temporary synthetic runtime?"
            alert.informativeText = "Each explicit Send click shares only the fixed SYNTHETIC fixture (CPU 92%, normal memory, disk 80 GiB) plus a random request ID, timestamps and hashes through your already-running private Tunnel to its subscribed dot. It does not describe this Mac. Dot analysis may use your model plan. No real readings or receipts are uploaded.\n\nThe app will retrieve this request's result until it arrives, expires or you cancel. A returned suggestion requires separate local approval. This selects a same-user socket, not a verified model identity. Keep the foreground Terminal open. The folder is remembered only until this app quits; no credential is read or saved."
            alert.addButton(withTitle: "Use temporary runtime"); alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            runtimeDirectory = url
            socketMessage = "Runtime folder selected. Send explicitly to begin; no request has been sent by selection."
            reviewCurrent()
        } catch { show(error) }
    }
    @objc private func sendSynthetic() {
        guard runtimeDirectory != nil else { chooseRuntime(); return }
        guard !exchangeInFlight, pollingTimer == nil, ![.waiting, .reviewing, .executing].contains(state.phase) else {
            reviewCurrent(); return // Repeated clicks never create a second event.
        }
        do {
            try transition { _ = try $0.create(at: Date()) }
            socketRequestID = state.request?.clientRequestID; socketBinding = nil
            beginSocket(.diagnose)
        } catch { show(error) }
    }
    @objc private func retrySocketRequest() {
        guard state.phase == .waiting, !exchangeInFlight, pollingTimer == nil else { reviewCurrent(); return }
        guard runtimeDirectory != nil else { chooseRuntime(); return }
        socketRequestID = state.request?.clientRequestID
        beginSocket(.diagnose) // Same immutable envelope, idempotent even after uncertain timeout.
    }
    private func stopRetrieval() {
        pollingTimer?.invalidate(); pollingTimer = nil
        socketCancellation.cancel(); socketCancellation = SyntheticSocketCancellation()
        exchangeGeneration = UUID(); exchangeInFlight = false; approvalCheckInFlight = false
    }
    private func beginSocket(_ operation: SyntheticSocketOperation) {
        guard let directory = runtimeDirectory, let request = state.request, state.phase == .waiting,
              !exchangeInFlight else { return }
        do {
            let data = try SyntheticSocketProtocol.command(operation, request: request, at: Date())
            let token = exchangeGeneration, cancellation = socketCancellation
            exchangeInFlight = true
            socketMessage = operation == .diagnose ? "Submitting the fixed synthetic test. No local action is authorized." : "Waiting for dot's synthetic proposal. No local action is authorized."
            if operation == .diagnose { reviewCurrent() }
            socketQueue.async { [weak self] in
                let result = Result { try SyntheticSocketTransport(directory: directory).exchange(data, cancellation: cancellation) }
                DispatchQueue.main.async {
                    guard let self, self.exchangeGeneration == token, self.state.phase == .waiting,
                          self.state.request == request else { return }
                    self.exchangeInFlight = false
                    do {
                        let response = try SyntheticSocketProtocol.response(result.get(), request: request, at: Date(), expected: self.socketBinding)
                        self.socketBinding = response.binding
                        switch response.status {
                        case .requested:
                            self.socketMessage = "Synthetic request accepted. Waiting for a returned proposal; callback acknowledgement alone does not mean analysis is complete. Close this window to keep waiting, or Cancel to stop."
                            self.scheduleRetrieval()
                            if operation == .diagnose { self.reviewCurrent() }
                        case .proposed:
                            guard let bundle = response.bundle else { throw SyntheticSocketError.invalidResponse }
                            try self.transition { _ = try $0.receive(bundle, at: Date()) }
                            self.stopRetrieval()
                            self.reviewCurrent() // Review only; never authorize or run an action here.
                        case .cancelled, .expired:
                            self.stopRetrieval()
                            try self.transition { try $0.cancel(at: Date()) }
                            self.socketMessage = "The runtime reports this request is \(response.status.rawValue). No local action is authorized."
                            self.reviewCurrent()
                        }
                    } catch {
                        self.stopRetrieval()
                        self.socketMessage = error.localizedDescription + "\nRetrieval stopped. Retry uses the same pending request."
                        self.reviewCurrent()
                    }
                }
            }
        } catch { stopRetrieval(); socketMessage = error.localizedDescription; reviewCurrent() }
    }
    private func scheduleRetrieval() {
        pollingTimer?.invalidate()
        let timer = Timer(timeInterval: 5, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.pollingTimer = nil
            self.beginSocket(.result)
        }
        pollingTimer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    private func cancelRemote(_ request: SyntheticClientRequest, directory: URL, token: UUID) {
        // Local cancellation is already durably committed. This acknowledgement cannot restore it.
        let binding = socketBinding
        socketQueue.async { [weak self] in
            let result = Result { () -> SyntheticSocketResponse in
                let data = try SyntheticSocketProtocol.command(.cancel, request: request, at: Date())
                let bytes = try SyntheticSocketTransport(directory: directory).exchange(data)
                return try SyntheticSocketProtocol.response(bytes, request: request, at: Date(), expected: binding, allowExpired: true)
            }
            DispatchQueue.main.async {
                guard let self, self.exchangeGeneration == token, self.state.phase == .cancelled else { return }
                switch result {
                case .success(let response) where response.status == .cancelled:
                    self.socketMessage = "Cancelled locally and acknowledged by the runtime. An event already delivered to dot cannot be recalled."
                default:
                    self.socketMessage = "Cancelled locally. Runtime cancellation could not be confirmed; an already sent event may still be analyzed, but its result cannot authorize local actions."
                }
                self.reviewCurrent()
            }
        }
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
        guard !exchangeInFlight, pollingTimer == nil, ![.waiting, .reviewing, .executing].contains(state.phase) else { reviewCurrent(); return }
        do {
            try transition { _ = try $0.create(at: Date()) }
            generation = UUID(); socketRequestID = nil
            socketMessage = "Manual file-test request. Use the secondary file tools to save/import it."
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
            UNVERIFIED PROPOSAL ORIGIN: SHA-256 checks bytes and request binding, not the author. The same-user local socket is a transport boundary, not proof of model identity.

            Cloud proposal remains dry_run=true. Nothing has executed.
            The actions below form a separate local test manifest. Approval here authorizes only these native functions on this Mac; it never authorizes a remote command or an optimization.

            EXACT LOCAL TEST ACTIONS
            \(actions)

            LOCAL RECEIPT EVIDENCE
            Before/after cached readings: \(metrics(for: proposal).map { $0.rawValue }.joined(separator: ", ")).
            Freshness and source timestamps are preserved; stale/missing data is not measured improvement.

            No shell, process termination, settings change, deletion, receipt upload, new collector, or native remote listener is available.
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

            \(socketMessage)

            Explicit Send shares this fixed fixture through the selected foreground runtime. The app retrieves only this request's result every 5 seconds. Nothing resumes automatically after app restart. Closing this preview does not cancel the request; use Cancel.

            Returned proposals remain dry_run=true. Exact allowed actions require separate local review and approval. Real before/after measurements and receipts remain on this Mac. No key, real telemetry, process detail or filesystem content is sent.

            This request is bound to this local installation and expires after 30 minutes. Cancel before starting a different request. File tools remain available only for manual testing.

            \(json)
            """, buttons: [("Retry same request", #selector(retrySocketRequest)), ("Cancel request", #selector(cancel))])
        } else {
            present(title: "Synthetic roundtrip", text: "SYNTHETIC TEST ONLY. State: \(state.phase.rawValue)\n\n\(socketMessage)\n\nSend shares the fixed CPU 92% / normal memory / 80 GiB fixture with the subscribed dot, and may use your model plan. It does not describe this Mac. Real actions require separate local approval. Cancelled, expired or already imported results cannot be replayed.", buttons: [("Send synthetic diagnosis", #selector(sendSynthetic)), ("Choose runtime…", #selector(chooseRuntime)), ("Last receipt", #selector(showReceipt))])
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
        guard !exchangeInFlight, pollingTimer == nil, state.phase == .waiting else { show(RoundtripError.invalid("Pause/cancel socket retrieval or create a pending manual request first. Replayed or already imported proposals are rejected.")); return }
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
        guard !approvalCheckInFlight, let hash = displayedManifestHash, state.phase == .reviewing,
              let proposal = state.proposal, proposal.manifestHash == hash else {
            show(RoundtripError.invalid("The displayed manifest is no longer current or is already being checked")); return
        }
        let alert = NSAlert()
        alert.messageText = "Run this separate local test?"
        alert.informativeText = "The returned proposal is synthetic and its origin is unverified. This approval applies only to:\n\n" + proposal.actions.map(\.description).joined(separator: "\n\n") + "\n\nNo optimization is performed. Metric observations remain on this Mac. Socket proposals are rechecked after your approval and before actions start. Later remote cancellation cannot recall a locally started action; use this app's Cancel control."
        alert.addButton(withTitle: "Approve local test"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn,
              state.phase == .reviewing, state.proposal?.manifestHash == hash else { return }
        if state.request?.clientRequestID == socketRequestID {
            guard let directory = runtimeDirectory, let request = state.request else { return }
            let token = exchangeGeneration, binding = socketBinding, cancellation = socketCancellation
            approvalCheckInFlight = true
            present(title: "Checking approved synthetic proposal", text: "Your local approval is being checked against the temporary runtime. No action has started. You can still Cancel. A failed or changed response requires a new explicit approval.", buttons: [("Cancel request", #selector(cancel))])
            socketQueue.async { [weak self] in
                let result = Result { () -> VerifiedSyntheticProposal in
                    let data = try SyntheticSocketProtocol.command(.result, request: request, at: Date())
                    let bytes = try SyntheticSocketTransport(directory: directory).exchange(data, cancellation: cancellation)
                    let response = try SyntheticSocketProtocol.response(bytes, request: request, at: Date(), expected: binding)
                    guard response.status == .proposed, let bundle = response.bundle else {
                        throw RoundtripError.invalid("The runtime no longer has an active proposal. Cancel this local request.")
                    }
                    return try VerifiedSyntheticProposal.importFile(bundle, pending: request, at: Date())
                }
                DispatchQueue.main.async {
                    guard let self, self.exchangeGeneration == token, self.state.phase == .reviewing,
                          self.state.request == request else { return }
                    self.approvalCheckInFlight = false
                    do {
                        guard try result.get().manifestHash == hash else { throw RoundtripError.invalid("The proposal changed before local execution") }
                        self.startApprovedLocalTest(hash: hash, proposal: proposal)
                    } catch { self.reviewCurrent(); self.show(error) }
                }
            }
        } else { startApprovedLocalTest(hash: hash, proposal: proposal) }
    }
    private func startApprovedLocalTest(hash: String, proposal: VerifiedSyntheticProposal) {
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
    func stop() { stopRetrieval(); interrupt(reason: "app_termination"); observationTimer?.invalidate(); openTimeout?.cancel() }
    @objc private func cancel() {
        observationTimer?.invalidate(); observationTimer = nil
        openTimeout?.cancel(); openTimeout = nil
        generation = UUID()
        let request = state.request, directory = runtimeDirectory
        let shouldCancelRemote = request?.clientRequestID == socketRequestID
        stopRetrieval()
        do {
            try transition { try $0.cancel(at: Date()) }
            socketMessage = "Cancelled locally. No returned proposal can start an action."
            if shouldCancelRemote, let request, let directory {
                socketMessage += " Runtime cancellation is being requested."
                cancelRemote(request, directory: directory, token: exchangeGeneration)
            }
            reviewCurrent()
        } catch { show(error) }
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
