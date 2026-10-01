// Explicit synthetic socket exchange + separately approved, allowlisted local tests.
import Cocoa
import Darwin

final class SyntheticRoundtripController: NSObject, NSMenuItemValidation {
    typealias Capture = ([LocalMetric]) -> [LocalMetricReading]
    private let storage: LocalRoundtripStorage
    private let capture: Capture
    private let discover: (SyntheticSocketCancellation) throws -> [SyntheticRuntimeEndpoint]
    private var state = LocalRoundtripState()
    private let statusWindow = SyntheticStatusWindow()
    private var window: NSWindow? { statusWindow.window }
    private var lastConnectionError: Error?
    private var displayedManifestHash: String?
    private var generation = UUID()
    private var observationTimer: Timer?
    private var openTimeout: DispatchWorkItem?
    private var storageFailure: String?
    // Runtime selection and polling consent live only in this app session.
    private var runtimeEndpoint: SyntheticRuntimeEndpoint?
    private var discoveryInFlight = false
    private let socketQueue = DispatchQueue(label: "StatsDiagnostics.synthetic-ipc", qos: .utility)
    private var pollingTimer: Timer?
    private var exchangeGeneration = UUID()
    private var exchangeInFlight = false
    private var socketMessage = DiagnosticText.text("See a simulated suggestion, decide whether to approve a local test, then view its result.", "看一份模拟建议，由你决定是否批准本地测试，最后查看结果。")
    private var socketRequestID: String?
    private var socketBinding: SyntheticSocketBinding?
    private var approvalCheckInFlight = false
    private var socketCancellation = SyntheticSocketCancellation()


    init(directory: URL, capture: @escaping Capture,
         discover: @escaping (SyntheticSocketCancellation) throws -> [SyntheticRuntimeEndpoint] = { try SyntheticRuntimeDiscovery.find(cancellation: $0) }) {
        storage = LocalRoundtripStorage(directory: directory)
        self.capture = capture; self.discover = discover
        super.init()
        do { state = try storage.load(at: Date()); try storage.save(state) }
        catch { storageFailure = "Local roundtrip state could not be read safely. No local action is available." }
    }
    func appendMenu(to menu: NSMenu) {
        let root = NSMenuItem(title: DiagnosticText.text("Synthetic diagnosis with dot", "与 dot 进行合成诊断测试"), action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        add(DiagnosticText.text("Send synthetic test…", "发送合成测试…"), #selector(sendSynthetic), to: submenu)
        add(DiagnosticText.text("Status / review proposal…", "查看状态／审核建议…"), #selector(reviewCurrent), to: submenu)
        add(DiagnosticText.text("Retry same pending request", "重试本次请求"), #selector(retrySocketRequest), to: submenu)
        add(DiagnosticText.text("Cancel request / local test", "取消请求／本地测试"), #selector(cancel), to: submenu)
        add(DiagnosticText.text("Last local receipt…", "最近一次本地回执…"), #selector(showReceipt), to: submenu)
        submenu.addItem(.separator())
        add(DiagnosticText.text("Check connection…", "检查连接…"), #selector(checkRuntimeStatus), to: submenu)
        add(DiagnosticText.text("Connection help…", "连接帮助…"), #selector(connectionHelp), to: submenu)
        let files = NSMenuItem(title: DiagnosticText.text("Advanced file test tools", "高级：文件测试工具"), action: nil, keyEquivalent: "")
        let fileMenu = NSMenu()
        add(DiagnosticText.text("Create file-test request…", "创建文件测试请求…"), #selector(createRequest), to: fileMenu)
        add(DiagnosticText.text("Save pending request…", "保存待处理请求…"), #selector(saveRequest), to: fileMenu)
        add(DiagnosticText.text("Import returned proposal…", "导入返回的建议…"), #selector(importProposal), to: fileMenu)
        files.submenu = fileMenu; submenu.addItem(files)
        root.submenu = submenu; menu.addItem(root)
    }
    private var controls: SyntheticControlState {
        SyntheticControlState(phase: state.phase, discovering: discoveryInFlight, exchanging: exchangeInFlight,
                              polling: pollingTimer != nil, checkingApproval: approvalCheckInFlight, hasReceipt: !state.receipts.isEmpty)
    }
    private func enabled(_ action: Selector) -> Bool {
        switch action {
        case #selector(sendSynthetic): return controls.canSend
        case #selector(retrySocketRequest): return controls.canRetry
        case #selector(checkRuntimeStatus): return controls.canCheck
        case #selector(authorize): return controls.canApprove
        case #selector(cancel): return controls.canCancel
        case #selector(showReceipt), #selector(saveReceipt): return controls.hasReceipt && !controls.busy
        case #selector(createRequest): return controls.canSend && state.phase != .waiting
        case #selector(saveRequest): return state.phase == .waiting && !controls.busy
        case #selector(importProposal): return state.phase == .waiting && state.runtimeInstanceID == nil && !controls.busy
        default: return true
        }
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { menuItem.action.map(enabled) ?? true }
    @objc private func checkRuntimeStatus() { discoverRuntime(submit: false) }
    @objc private func sendSynthetic() {
        guard !discoveryInFlight, !exchangeInFlight, pollingTimer == nil,
              ![.reviewing, .executing].contains(state.phase) else { reviewCurrent(); return }
        discoverRuntime(submit: true)
    }
    @objc private func retrySocketRequest() {
        guard state.phase == .waiting, !discoveryInFlight, !exchangeInFlight, pollingTimer == nil else { reviewCurrent(); return }
        discoverRuntime(submit: true) // Same client envelope and persisted runtime binding.
    }
    private func discoverRuntime(submit: Bool) {
        guard !discoveryInFlight, !exchangeInFlight, !approvalCheckInFlight, pollingTimer == nil,
              ![.reviewing, .executing].contains(state.phase) else { reviewCurrent(); return }
        let token = exchangeGeneration, cancellation = socketCancellation
        let boundInstance = state.phase == .waiting ? state.runtimeInstanceID : nil
        discoveryInFlight = true; lastConnectionError = nil
        present(title: DiagnosticText.text("Finding the local connection…", "正在查找本机连接…"), text: DiagnosticText.text("Checking the private runtime. This takes up to 5 seconds. No request has been sent yet.", "正在验证本机运行端，最多需要 5 秒。此时尚未发送测试请求。"), buttons: [(DiagnosticText.text("Send test", "发送测试"), #selector(sendSynthetic)), (DiagnosticText.text("Cancel", "取消"), #selector(cancel))], busy: true)
        socketQueue.async { [weak self] in
            guard let self else { return }
            let result = Result { try self.discover(cancellation) }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.exchangeGeneration == token else { return }
                self.discoveryInFlight = false
                do {
                    let candidates = try result.get()
                    let eligible = boundInstance.map { id in candidates.filter { $0.descriptor.instanceID == id } } ?? candidates
                    guard !eligible.isEmpty else { throw boundInstance == nil ? RuntimeDiscoveryError.noRuntime : RuntimeDiscoveryError.originalRuntimeGone }
                    let endpoint: SyntheticRuntimeEndpoint
                    if eligible.count == 1 { endpoint = eligible[0] }
                    else {
                        let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 510, height: 28), pullsDown: false)
                        eligible.forEach { picker.addItem(withTitle: $0.label) }
                        let alert = NSAlert(); alert.messageText = DiagnosticText.text("Choose a local session", "选择本机运行会话")
                        alert.informativeText = DiagnosticText.text("Several verified sessions are active. Match the session name to the end of the “Private run directory” line in its Terminal. Select the intended session before sending.", "发现多个已验证的运行会话。请对照终端中“Private run directory”一行末尾的名称，选择本次要使用的会话。选择前不会发送请求。")
                        alert.accessoryView = picker
                        alert.addButton(withTitle: submit ? DiagnosticText.text("Select and send", "选择并发送") : DiagnosticText.text("Select", "选择")); alert.addButton(withTitle: DiagnosticText.text("Cancel", "取消"))
                        guard alert.runModal() == .alertFirstButtonReturn, self.exchangeGeneration == token else { self.reviewCurrent(); return }
                        endpoint = eligible[picker.indexOfSelectedItem]
                    }
                    self.runtimeEndpoint = endpoint
                    self.lastConnectionError = nil
                    self.socketMessage = DiagnosticText.text("Last connection check passed at \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)). Send will verify it again before sharing the fixture.", "上次连接检查通过（\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))）。发送前会再次核验连接。")
                    if submit {
                        if self.state.phase != .waiting {
                            try self.transition { _ = try $0.create(at: Date()) }
                            self.socketBinding = nil
                        }
                        try self.transition { try $0.bindRuntime(endpoint.descriptor.instanceID) }
                        self.socketRequestID = self.state.request?.clientRequestID
                        self.beginSocket(.diagnose)
                    } else { self.reviewCurrent() }
                } catch {
                    self.runtimeEndpoint = nil
                    self.lastConnectionError = error
                    self.socketMessage = DiagnosticText.error(error)
                    self.reviewCurrent()
                }
            }
        }
    }
    private func stopRetrieval() {
        pollingTimer?.invalidate(); pollingTimer = nil
        socketCancellation.cancel(); socketCancellation = SyntheticSocketCancellation()
        exchangeGeneration = UUID(); exchangeInFlight = false; approvalCheckInFlight = false; discoveryInFlight = false
    }
    private func beginSocket(_ operation: SyntheticSocketOperation) {
        guard let endpoint = runtimeEndpoint, let request = state.request, state.phase == .waiting,
              !exchangeInFlight else { return }
        do {
            _ = try SyntheticSocketProtocol.command(operation, request: request, at: Date(), expectedInstanceID: endpoint.descriptor.instanceID)
            let token = exchangeGeneration, cancellation = socketCancellation
            exchangeInFlight = true
            lastConnectionError = nil
            socketMessage = operation == .diagnose ? DiagnosticText.text("Sending the synthetic request…", "正在发送合成测试请求…") : DiagnosticText.text("Waiting for dot to return a proposal. Nothing is running on this Mac.", "正在等待 dot 返回建议，本机尚未执行任何操作。")
            if operation == .diagnose { reviewCurrent() }
            socketQueue.async { [weak self] in
                let result = Result { try endpoint.exchange(operation, request: request, cancellation: cancellation) }
                DispatchQueue.main.async {
                    guard let self, self.exchangeGeneration == token, self.state.phase == .waiting,
                          self.state.request == request else { return }
                    self.exchangeInFlight = false
                    do {
                        let response = try SyntheticSocketProtocol.response(result.get(), request: request, at: Date(), expected: self.socketBinding)
                        self.socketBinding = response.binding
                        switch response.status {
                        case .requested:
                            self.socketMessage = DiagnosticText.text("Request accepted. Waiting for dot’s proposal; analysis is not complete yet. This window may be closed while waiting.", "请求已接收，正在等待 dot 返回建议；分析尚未完成。等待期间可以关闭此窗口。")
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
                            self.socketMessage = response.status == .expired ? DiagnosticText.text("The request expired. Start a new test when ready.", "本次请求已过期，可以重新开始测试。") : DiagnosticText.text("The runtime cancelled this request. No action was authorized.", "运行端已取消本次请求，未授权任何操作。")
                            self.reviewCurrent()
                        }
                    } catch {
                        self.stopRetrieval()
                        self.lastConnectionError = error
                        self.socketMessage = DiagnosticText.error(error) + DiagnosticText.text("\nResult checks stopped. Retry reuses this request.", "\n已停止查询结果。重试会继续使用本次请求。")
                        self.reviewCurrent()
                    }
                }
            }
        } catch { stopRetrieval(); lastConnectionError = error; socketMessage = DiagnosticText.error(error); reviewCurrent() }
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
    private func cancelRemote(_ request: SyntheticClientRequest, endpoint: SyntheticRuntimeEndpoint, token: UUID) {
        // Local cancellation is already durably committed. This acknowledgement cannot restore it.
        let binding = socketBinding
        socketQueue.async { [weak self] in
            let result = Result { () -> SyntheticSocketResponse in
                let bytes = try endpoint.exchange(.cancel, request: request)
                return try SyntheticSocketProtocol.response(bytes, request: request, at: Date(), expected: binding, allowExpired: true)
            }
            DispatchQueue.main.async {
                guard let self, self.exchangeGeneration == token, self.state.phase == .cancelled else { return }
                switch result {
                case .success(let response) where response.status == .cancelled:
                    self.socketMessage = DiagnosticText.text("Cancelled locally and confirmed by the runtime. An event already delivered to dot cannot be recalled.", "本地已取消，运行端也已确认。已送达 dot 的事件无法撤回。")
                default:
                    self.socketMessage = DiagnosticText.text("Cancelled locally. Remote cancellation is unconfirmed. A sent event may still be analyzed, but its result cannot start a local action.", "本地已取消，运行端的取消状态尚未确认。已发送的事件可能继续被分析，但返回结果不能启动本地操作。")
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
        guard !discoveryInFlight, !exchangeInFlight, pollingTimer == nil, ![.waiting, .reviewing, .executing].contains(state.phase) else { reviewCurrent(); return }
        do {
            try transition { _ = try $0.create(at: Date()) }
            generation = UUID(); socketRequestID = nil; socketBinding = nil; runtimeEndpoint = nil
            socketMessage = DiagnosticText.text("Manual file test. Save the request and import its returned proposal using Advanced tools.", "这是手动文件测试。请通过高级工具保存请求并导入返回建议。")
            reviewCurrent()
        } catch { show(error) }
    }
    @objc private func reviewCurrent() {
        if let failure = storageFailure { show(RoundtripError.invalid(failure)); return }
        if discoveryInFlight || approvalCheckInFlight { window?.makeKeyAndOrderFront(nil); return }
        if state.phase == .executing { showRunning(); return }
        if state.phase == .reviewing, let proposal = state.proposal {
            displayedManifestHash = proposal.manifestHash
            let model = SyntheticExperience.proposal(proposal)
            let details = "Client request: \(proposal.clientRequestID)\nExpires: \(proposal.expiresAt)\nProposal SHA-256: \(proposal.proposalHash)\nLocal manifest SHA-256: \(proposal.manifestHash)"
            presentExperience(model, buttons: [(DiagnosticText.text("Review local approval…", "查看并决定是否批准…"), #selector(authorize)), (DiagnosticText.text("Do not run", "不执行"), #selector(cancel))], details: details)
            return
        }
        displayedManifestHash = nil
        let active = exchangeInFlight || pollingTimer != nil
        let title: String
        if let error = lastConnectionError {
            title = error is RuntimeDiscoveryError ? DiagnosticText.text("Local connection unavailable", "尚未连接本机运行端") : DiagnosticText.text("Request could not finish", "请求暂未完成")
        } else if active {
            title = pollingTimer != nil || socketBinding != nil ? DiagnosticText.text("Waiting for dot…", "正在等待 dot 返回建议…") : DiagnosticText.text("Sending test…", "正在发送测试…")
        } else if state.phase == .cancelled {
            title = DiagnosticText.text("Request cancelled", "请求已取消")
        } else if state.phase == .waiting {
            title = DiagnosticText.text("Request paused · ready to retry", "请求已暂停，可重试")
        } else if state.phase == .completed || state.phase == .interrupted {
            title = DiagnosticText.outcome(state.receipts.last?.outcome ?? "interrupted")
        } else if runtimeEndpoint != nil {
            title = DiagnosticText.text("Last connection check passed", "上次连接检查已通过")
        } else {
            title = DiagnosticText.text("Try a guided simulated diagnosis", "体验一次模拟诊断")
        }
        let explanation = socketMessage + "\n\n" + (active ? DiagnosticText.text(
            "Results are checked every 5 seconds. Closing the window keeps waiting; Cancel stops this request. Local actions will always need separate approval.",
            "每 5 秒查询一次结果。关闭窗口后会继续等待；点击“取消请求”才会停止。本地操作始终需要另行审核和批准。") : DiagnosticText.text(
            "Send uses the fixed synthetic fixture and may use your model plan. It does not upload this Mac’s readings. Returned suggestions need your separate approval before any local test.",
            "发送会使用固定的合成样例，并可能使用你的模型额度；不会上传这台 Mac 的读数。收到建议后，仍需你另行批准才会进行本地测试。"))
        var details = state.request.flatMap { try? $0.json() } ?? ""
        if let endpoint = runtimeEndpoint { details += "\nRuntime: \(endpoint.label)" }
        if let error = lastConnectionError { details += "\n\n" + error.localizedDescription }
        var buttons: [(String, Selector)] = state.phase == .waiting ? [
            (DiagnosticText.text("Retry same request", "重试本次请求"), #selector(retrySocketRequest)),
            (DiagnosticText.text("Cancel request", "取消请求"), #selector(cancel)),
            (DiagnosticText.text("Connection help", "连接帮助"), #selector(connectionHelp))
        ] : [
            (DiagnosticText.text("Send synthetic test", "发送合成测试"), #selector(sendSynthetic)),
            (DiagnosticText.text("Check connection", "检查连接"), #selector(checkRuntimeStatus)),
            (DiagnosticText.text("Connection help", "连接帮助"), #selector(connectionHelp))
        ]
        if [.completed, .interrupted].contains(state.phase), !state.receipts.isEmpty {
            buttons = [(DiagnosticText.text("View local receipt", "查看本地回执"), #selector(showReceipt)), buttons[0], buttons[2]]
        }
        present(title: title, text: explanation, buttons: buttons, details: details, busy: active)
    }
    @objc private func connectionHelp() {
        let alert = NSAlert()
        alert.messageText = DiagnosticText.text("Connect the local runtime", "连接本机运行端")
        alert.informativeText = DiagnosticText.text(
            "1. Open the approved foreground runtime in Terminal.\n2. If Terminal asks for a temporary key, enter it there yourself. Keep that Terminal session open.\n3. Return here and choose Check connection, then Send synthetic test.\n\nA runtime becomes discoverable only after it is ready. The app cannot tell whether an absent runtime is stopped, expired, or waiting for key entry. No folder selection is needed. This app cannot start the runtime or read your key.",
            "1. 在终端打开已批准的前台运行端。\n2. 如果终端提示输入临时密钥，请直接在那里自行输入，并保持该终端会话运行。\n3. 回到此窗口，点击“检查连接”，连接就绪后再“发送合成测试”。\n\n运行端准备就绪后才可被发现。未发现时，应用无法判断它是已退出、已过期，还是正在等待输入密钥。无需选择文件夹；本应用不能代为启动运行端或读取密钥。")
        alert.addButton(withTitle: DiagnosticText.text("Got it", "知道了"))
        alert.runModal()
    }
    @objc private func saveRequest() {
        guard state.phase == .waiting, let request = state.request else { return }
        do {
            _ = try SyntheticClientRequest.parse(RoundtripJSON.object(request.json()), at: Date())
            try saveFile(Data(request.json().utf8), name: "stats-SYNTHETIC-request.json")
        } catch { show(error) }
    }
    @objc private func importProposal() {
        guard !discoveryInFlight, !exchangeInFlight, pollingTimer == nil, state.phase == .waiting, state.runtimeInstanceID == nil else { show(RoundtripError.invalid("Create a separate manual request for file import; runtime-bound requests use verified socket retrieval. Replayed or already imported proposals are rejected.")); return }
        let panel = NSOpenPanel()
        panel.title = DiagnosticText.text("Import an untrusted synthetic result", "导入未经信任的合成测试结果")
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
        let alert = SyntheticStatusWindow.approval(for: proposal)
        guard alert.runModal() == .alertFirstButtonReturn,
              state.phase == .reviewing, state.proposal?.manifestHash == hash else { return }
        if state.runtimeInstanceID != nil {
            guard let endpoint = runtimeEndpoint, let request = state.request, endpoint.descriptor.instanceID == state.runtimeInstanceID else { show(RuntimeDiscoveryError.originalRuntimeGone); return }
            let token = exchangeGeneration, binding = socketBinding, cancellation = socketCancellation
            approvalCheckInFlight = true
            present(title: DiagnosticText.text("Verifying before starting…", "正在进行执行前核验…"), text: DiagnosticText.text("No action has started. The runtime must confirm the exact proposal you approved. You can still cancel.", "尚未执行操作，正在向运行端确认你批准的同一份建议。此时仍可取消。"), buttons: [(DiagnosticText.text("Cancel request", "取消请求"), #selector(cancel))], busy: true)
            socketQueue.async { [weak self] in
                let result = Result { () -> VerifiedSyntheticProposal in
                    let bytes = try endpoint.exchange(.result, request: request, cancellation: cancellation)
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
                if self.window?.isVisible == true { self.showRunning(activate: false) }
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
        if state.phase == .executing, window?.isVisible == true { showRunning(activate: false) }
    }
    private func complete(_ outcome: String) {
        guard state.phase == .executing, let proposal = state.proposal else { return }
        observationTimer?.invalidate(); observationTimer = nil
        openTimeout?.cancel(); openTimeout = nil
        generation = UUID()
        do {
            let after = capture(metrics(for: proposal))
            try transition { try $0.finish(outcome: outcome, after: after, at: Date()) }
            socketMessage = DiagnosticText.text("Local test finished. Review the local receipt for readings and freshness; no optimization is claimed.", "本地测试已结束，可查看回执中的读数与采样时间；不代表性能已优化。")
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
        // Refresh a visible test after sleep/pause without reopening a dismissed window.
        if reason != "app_termination", window?.isVisible == true {
            if storageFailure == nil { showReceipt() } else { reviewCurrent() }
        }
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
        let request = state.request, endpoint = runtimeEndpoint
        let shouldCancelRemote = state.runtimeInstanceID != nil && state.runtimeInstanceID == endpoint?.descriptor.instanceID
        stopRetrieval()
        do {
            try transition { try $0.cancel(at: Date()) }
            lastConnectionError = nil
            socketMessage = DiagnosticText.text("Cancelled locally. Returned proposals cannot start an action.", "本地已取消，返回的建议不能启动操作。")
            if shouldCancelRemote, let request, let endpoint {
                socketMessage += DiagnosticText.text(" Notifying the runtime…", " 正在通知运行端…")
                cancelRemote(request, endpoint: endpoint, token: exchangeGeneration)
            }
            reviewCurrent()
        } catch { show(error) }
    }
    private func showRunning(activate: Bool = true) {
        presentExperience(SyntheticExperience.running(state.proposal, receipt: state.activeReceipt), buttons: [(DiagnosticText.text("Stop observation", "停止观测"), #selector(cancel))], activate: activate)
    }
    @objc private func showReceipt() {
        guard let receipt = state.receipts.last else { return }
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let details = String(data: try encoder.encode(receipt), encoding: .utf8) ?? ""
            presentExperience(SyntheticExperience.receipt(receipt), buttons: [(DiagnosticText.text("Back to overview", "返回概览"), #selector(reviewCurrent)), (DiagnosticText.text("Save local result…", "保存本地结果…"), #selector(saveReceipt))], details: details)
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
    private func presentExperience(_ model: SyntheticExperience, buttons: [(String, Selector)], details: String = "", activate: Bool = true) {
        present(title: model.title, text: model.introduction, buttons: buttons, details: details, busy: model.busy, localEvidence: model.localEvidence, sections: model.sections, progress: model.progress, activate: activate)
    }
    private func present(title: String, text: String, buttons: [(String, Selector)], details: String = "", busy: Bool = false, localEvidence: Bool = false,
                         sections: [SyntheticSection] = [], progress: String = "", activate: Bool = true) {
        statusWindow.show(title: title, introduction: text, sections: sections, progress: progress,
                          buttons: buttons.map { SyntheticStatusWindow.Button(title: $0.0, action: $0.1, enabled: enabled($0.1), isApproval: $0.1 == #selector(authorize)) }, target: self,
                          details: details, busy: busy, localEvidence: localEvidence, activate: activate)
    }
    private func show(_ error: Error) {
        let alert = NSAlert(); alert.messageText = DiagnosticText.text("The test could not continue", "测试暂时无法继续")
        alert.informativeText = DiagnosticText.error(error)
        let detail = NSTextField(wrappingLabelWithString: error.localizedDescription)
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 460; detail.setAccessibilityLabel(DiagnosticText.text("Technical detail", "技术详情"))
        alert.accessoryView = detail
        alert.addButton(withTitle: DiagnosticText.text("OK", "知道了")); alert.runModal()
    }
}
