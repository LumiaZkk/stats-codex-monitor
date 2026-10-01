// Global real-data diagnosis, local consent, and one bounded capability invocation.
import Cocoa

final class RealOptimizationController: NSObject {
    typealias Capture = () -> RealHostSnapshot
    private let capture: Capture
    private let recent: () -> [[String: Any]]
    private let probe = RealAppProbe()
    private let storage: RealReceiptStorage
    private let ui = SyntheticStatusWindow()
    private let queue = DispatchQueue(label: "StatsDiagnostics.real-diagnosis", qos: .utility)
    private var generation = UUID()
    private var cancellation = SyntheticSocketCancellation()
    private var timer: Timer?
    private var busy = false
    private var sample: RealGlobalSample?
    private var previewAt: Date?
    private var snapshot = RealHostSnapshot.empty
    private var trend: [[String: Any]] = []
    private var request: RealDiagnosticRequest?
    private var endpoint: SyntheticRuntimeEndpoint?
    private var binding: (String, String)?
    private var plan: RealPlan?
    private var gate: RealExecutionGate?
    private var candidate: RealCandidate?
    private var receipts: [RealLocalReceipt] = []
    private var activeID: String?
    private var storageError = false
    private var storageFailureDetail = ""
    private var status = ""
    private var receiptStatus = ""
    private var beforeWire: [String: Any]?
    private var displayManifest: String?
    private var requestConsumed = false

    init(directory: URL, capture: @escaping Capture, recent: @escaping () -> [[String: Any]]) {
        self.capture = capture; self.recent = recent; storage = RealReceiptStorage(directory: directory)
        super.init()
        do { receipts = try storage.load(at: Date()); try storage.save(receipts) }
        catch { storageError = true; storageFailureDetail = String(describing: error) }
    }
    private func text(_ en: String, _ zh: String) -> String { DiagnosticText.text(en, zh) }
    private func show(_ title: String, _ intro: String, sections: [SyntheticSection] = [], buttons: [(String, Selector)] = [], loading: Bool = false, details: String = "", activate: Bool = true, progress: String? = nil) {
        ui.show(title: title, introduction: intro, sections: sections, progress: progress ?? status,
                buttons: buttons.map { SyntheticStatusWindow.Button(title: $0.0, action: $0.1, enabled: !busy || $0.1 == #selector(cancel), isApproval: $0.1 == #selector(approve)) }, target: self,
                details: details, busy: loading, localEvidence: true, activate: activate, realOptimization: true)
    }
    @objc func open() {
        if busy { showProgress(); return }
        if requestConsumed { showLast(); return }
        if let plan { showPlan(plan); return }
        if sample != nil { showPreview(); return }
        show(text("Diagnose this Mac, then choose an action", "分析这台 Mac，再决定是否执行"),
             text("Collect a bounded real snapshot, review what will be shared with your dot, then receive a specific explanation. You approve any local action separately.", "先采集有限的真实数据，预览将发给你的 dot 的内容，再查看具体判断。任何本地操作都需要你另行批准。"),
             sections: [SyntheticSection(title: text("Available actions", "现在可执行的能力"), body: text("Normally quit one eligible ordinary app, or observe for60seconds. No force quit, shell command or file cleanup. Apps may ask you to save work.", "正常退出一个符合条件的普通应用，或观测 60 秒。不会强制退出、执行命令或清理文件。应用可能要求你保存工作。"))],
             buttons: [(text("Collect and preview", "采集并预览"), #selector(collect)), (text("Last result", "上次结果"), #selector(showLast))])
    }
    @objc private func collect() {
        guard !busy, activeID == nil, !storageError else { if storageError { fail(RealOptimizationError.storage) }; return }
        resetPending(); busy = true
        status = text("Reading visible process counters twice over about2seconds…", "正在对可见进程读取两次计数，约需 2 秒…")
        showProgress()
        let token = generation
        queue.async { [weak self] in
            guard let self else { return }
            let before = self.probe.processTable()
            self.queue.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                let after = self.probe.processTable()
                let sample = self.probe.globalSample(before: before, after: after)
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.generation == token else { return }
                    self.busy = false; self.sample = sample; self.previewAt = Date(); self.snapshot = self.capture(); self.trend = self.recent()
                    self.status = self.text("Collected locally. Nothing has been uploaded.", "已在本机采集，尚未上传任何数据。")
                    self.showPreview()
                }
            }
        }
    }
    private func hostText(_ value: RealHostSnapshot) -> String {
        func bytes(_ value: UInt64?) -> String { value.map { String(format: "%.2f GiB", Double($0) / 1_073_741_824) } ?? text("unavailable", "暂无数据") }
        func time(_ stamp: String?) -> String { stamp.flatMap { try? RoundtripJSON.date($0) }.map { DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .medium) } ?? "—" }
        let cpu = value.cpuBasisPoints.map { String(format: "%.1f%%", Double($0) / 100) } ?? "—"
        let pressure = value.memoryPressure == "critical" ? text("critical", "严重") : value.memoryPressure == "warning" ? text("warning", "警告") : value.memoryPressure == "normal" ? text("normal", "正常") : "—"
        let io = value.diskReadBytesPerSecond.map { String(format: "%.1f / %.1f MiB/s", Double($0) / 1_048_576, Double(value.diskWriteBytesPerSecond ?? 0) / 1_048_576) } ?? "—"
        return "CPU \(cpu) (\(time(value.cpuObservedAt)))\n" + text("Memory pressure", "内存压力") + ": \(pressure) · " + text("Swap", "交换内存") + " \(bytes(value.swapBytes)) (\(time(value.memoryObservedAt)))\n" + text("Disk free", "磁盘可用") + " \(bytes(value.diskFreeBytes)) (\(time(value.diskObservedAt)))\n" + text("Disk read/write", "磁盘读／写") + " \(io) (\(time(value.ioObservedAt)))"
    }
    private func usageText(_ usage: RealAppUsage) -> String {
        String(format: text("CPU %.1f%% of one core · resident %.0f MiB · %.1fs sample", "CPU 占单核 %.1f%% · 常驻内存 %.0f MiB · 采样 %.1f 秒"), Double(usage.cpuBasisPoints) / 100, Double(usage.residentBytes) / 1_048_576, Double(usage.intervalMS) / 1000)
    }
    private func showPreview() {
        guard let sample else { open(); return }
        let rows = sample.consumers.map { row in
            let name: String
            switch row["category"] as? String {
            case "system_process": name = text("System process", "系统进程")
            case "protected_app": name = text("Protected app", "受保护应用")
            case "app_helper": name = text("App helper", "应用辅助进程")
            case "unknown_process": name = text("Other process", "其他进程")
            default: name = row["display_name"] as? String ?? "—"
            }
            let bp = row["cpu_basis_points"] as? Int ?? 0, rss = row["resident_bytes"] as? UInt64 ?? 0
            return "\(DiagnosticText.safeUntrusted(name)) · CPU \(String(format: "%.1f", Double(bp) / 100))% · \(rss / 1_048_576) MiB"
        }.joined(separator: "\n")
        let targets = sample.candidates.map { "\(DiagnosticText.safeUntrusted($0.wire()["display_name"] as? String ?? "")) · \(usageText($0.usage))" }.joined(separator: "\n")
        let sections = [SyntheticSection(title: text("Real host readings and sample times", "本机读数与采样时间"), body: hostText(snapshot)),
                        SyntheticSection(title: text("Largest visible consumers", "占用较高的可见进程"), body: rows.isEmpty ? text("No usable process samples.", "暂无可用进程采样。") : rows),
                        SyntheticSection(title: text("Apps the model may recommend quitting", "可被建议正常退出的应用"), body: targets.isEmpty ? text("None. Analysis can still recommend observation or no action.", "暂无。仍可分析并建议继续观测或不操作。") : targets),
                        SyntheticSection(title: text("What is shared and why", "发送哪些数据、发给谁"), body: text("Send these values, app display names, opaque IDs, coverage, and up to5 recent host samples to your dot through the approved personal Tunnel. After your decision, send one bounded before/after receipt for verification. No PID, path, code identity, document, window title, arguments or keys are included. Main processes and helpers are not grouped; inaccessible processes are missing. This is a short sample, not proof of a sustained fault.", "通过已批准的个人 Tunnel，将以上读数、应用显示名、不透明编号、覆盖范围及最多 5 个近期主机采样发送给你的 dot。你作出决定后，还会发送一次有限的前后结果供核验。不含 PID、路径、代码身份、文档、窗口标题、命令参数或密钥。主进程与辅助进程没有合并；无权限读取的进程会缺失。短时采样不能证明持续故障。"))]
        let detail = (try? RealJSON.encode(["snapshot": snapshot.json, "consumers": sample.consumers, "candidates": sample.candidates.map { $0.wire() }, "coverage": sample.coverage, "recent_samples": trend])) ?? ""
        show(text("Review the real data before sending", "发送前，核对真实数据"), text("Confirming below shares this preview and the later bounded receipt with your dot. It does not approve quitting any app. Refresh if this preview is older than30seconds.", "下方确认会将本次预览及后续有限结果发送给你的 dot，不代表批准退出应用。预览超过 30 秒后请刷新。"), sections: sections,
             buttons: [(text("Agree and analyze", "同意发送并分析"), #selector(send)), (text("Refresh data", "刷新数据"), #selector(collect)), (text("Cancel", "取消"), #selector(cancel))], details: detail)
    }
    @objc private func send() {
        guard !busy, let sample, let previewAt, Date().timeIntervalSince(previewAt) <= 30 else { fail(RealOptimizationError.changed); return }
        do {
            request = try RealDiagnosticRequest.create(sample: sample, snapshot: snapshot, recent: trend.filter { row in
                guard let stamp = row["observed_at"] as? String, let date = try? RoundtripJSON.date(stamp) else { return false }; return Date().timeIntervalSince(date) <= 300
            }, consentAt: Date(), at: Date())
            busy = true; status = text("Verifying the approved local runtime…", "正在核验已批准的本机运行端…"); showProgress()
            let token = generation, cancellation = cancellation
            queue.async { [weak self] in
                let result = Result { try SyntheticRuntimeDiscovery.find(cancellation: cancellation) }
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.generation == token else { return }
                    do {
                        let endpoints = try result.get()
                        guard !endpoints.isEmpty else { throw RuntimeDiscoveryError.noRuntime }
                        let selected: SyntheticRuntimeEndpoint
                        if endpoints.count == 1 { selected = endpoints[0] }
                        else {
                            let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 510, height: 28), pullsDown: false); endpoints.forEach { picker.addItem(withTitle: $0.label) }
                            let alert = NSAlert(); alert.messageText = self.text("Choose the approved personal runtime", "选择已批准的个人运行会话")
                            alert.informativeText = self.text("Match the private run directory name shown in Terminal.", "请与终端中 Private run directory 末尾的名称对应。")
                            alert.accessoryView = picker; alert.addButton(withTitle: self.text("Send", "发送")); alert.addButton(withTitle: self.text("Cancel", "取消"))
                            guard alert.runModal() == .alertFirstButtonReturn, self.generation == token else { self.cancel(); return }
                            selected = endpoints[picker.indexOfSelectedItem]
                        }
                        self.endpoint = selected; self.exchange("diagnose_real")
                    } catch { self.busy = false; self.fail(error) }
                }
            }
        } catch { fail(error) }
    }
    private func exchangeJob(_ operation: String, receipt: [String: Any]? = nil) throws -> () throws -> RealSocketStatus {
        guard let request, let endpoint else { throw RealOptimizationError.invalid }
        let expected = binding, cancellation = cancellation
        let data = try RealSocketStatus.command(operation, request: request, endpointID: endpoint.descriptor.instanceID, receipt: receipt, server: binding)
        return {
            try cancellation.check(); try endpoint.validateCurrent()
            let bytes = try endpoint.transport.exchange(data, cancellation: cancellation, peer: endpoint.peer, beforeSend: endpoint.validateCurrent)
            return try RealSocketStatus.parse(bytes, request: request, expected: expected, at: Date())
        }
    }
    private func exchange(_ operation: String) {
        let token = generation
        let job: () throws -> RealSocketStatus
        do { job = try exchangeJob(operation) } catch { busy = false; fail(error); return }
        busy = true; status = text("Waiting for dot’s analysis. No app will quit without your approval.", "正在等待 dot 分析。未经你的批准，不会退出任何应用。")
        showProgress()
        queue.async { [weak self] in
            let result = Result { try job() }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token else { return }
                do {
                    let response = try result.get(); self.binding = (response.serverID, response.serverHash)
                    if response.status == "requested" { self.poll(); return }
                    self.busy = false
                    guard response.status == "proposed", let plan = response.plan else { throw RealOptimizationError.expired }
                    self.plan = plan; self.candidate = self.sample?.candidates.first { $0.id == plan.candidateID }
                    if plan.recommendsQuit && self.candidate == nil { throw RealOptimizationError.invalid }
                    self.status = self.text("Analysis returned. Review the exact proposed capability.", "分析已返回，请查看确切的操作建议。")
                    self.showPlan(plan)
                } catch { self.busy = false; self.fail(error) }
            }
        }
    }
    private func poll() {
        timer?.invalidate()
        let next = Timer(timeInterval: 5, repeats: false) { [weak self] _ in
            guard let self, let request = self.request else { return }
            guard let end = try? RoundtripJSON.date(request.expiresAt), Date() < end else { self.busy = false; self.fail(RealOptimizationError.expired); return }
            self.exchange("result_real")
        }
        timer = next; RunLoop.main.add(next, forMode: .common)
    }
    private func showPlan(_ plan: RealPlan) {
        guard let request else { return }
        displayManifest = plan.manifest(candidate: candidate, request: request)
        let action: String
        if let candidate, plan.recommendsQuit {
            action = text("Normally quit ", "正常退出 ") + DiagnosticText.safeUntrusted(candidate.identity.displayName) + "\n" + usageText(candidate.usage) + "\n" + text("Local verified identity: ", "仅本机显示的核验身份：") + candidate.identity.bundleID + " · " + candidate.identity.teamID + text("\nWhy this could help: this main process currently uses measurable CPU or memory. Quitting may release its resources. It will close the app and may interrupt ongoing work. Save first. A save prompt, refusal or15s timeout stops this attempt; no force quit follows. A short sample cannot prove this app caused the slowdown.", "\n可能有帮助的原因：该主进程当前占用了一定 CPU 或内存。退出可能释放其资源，也会关闭应用并可能中断正在进行的工作，请先保存。保存提示、拒绝退出或等待 15 秒超时都会停止本次尝试，不会强制退出。短时采样不能证明它就是卡顿原因。")
        } else if plan.decision == "observe" { action = text("Observe existing local host metrics for60seconds. No app is changed. This may reveal a newer sample; disk capacity updates only every300seconds.", "继续观测已有的本机指标 60 秒，不改变任何应用。可能获得新的采样；磁盘容量每 300 秒才更新一次。") }
        else { action = text("No local action is recommended. The result can be returned to dot without changing any app.", "本次不建议执行本地操作。可将结果回传给 dot，不改变任何应用。") }
        var buttons: [(String, Selector)] = []
        if plan.decision != "no_action" { buttons.append((text("Review and approve…", "核对并批准…"), #selector(approve))) }
        else { buttons.append((text("Finish and return result", "完成并回传结果"), #selector(noAction))) }
        if plan.decision != "no_action" { buttons.append((text("Do not execute", "不执行"), #selector(decline))) }
        show(text("dot’s analysis and proposed next step", "dot 的分析与下一步建议"), text("The returned explanation is model text, not an instruction with local authority. Review its evidence and the exact action below.", "返回的解释是模型建议，本身没有本地执行权限。请核对依据及下方确切操作。"),
             sections: [SyntheticSection(title: text("Model conclusion · unverified", "模型结论 · 需结合证据判断"), body: DiagnosticText.safeUntrusted(plan.summary)), SyntheticSection(title: text("Exact action, impact and limits", "确切操作、影响与局限"), body: action), SyntheticSection(title: text("Verification afterward", "执行后如何核验"), body: text("Record whether the original process actually exited, then compare timestamped local metrics after60seconds. Differences are observations, not a causal guarantee of improvement. The bounded receipt is returned to your dot under the sharing consent above.", "记录原进程是否确实退出，再于 60 秒后比较带采样时间的本地指标。变化只是观测结果，不保证由此次操作带来改善。有限结果会按前面的发送确认回传给你的 dot。"))], buttons: buttons)
    }
    @objc private func approve() {
        guard !busy, !storageError, !requestConsumed, let plan, let request, let displayed = displayManifest, plan.decision != "no_action", activeID == nil else { return }
        let immutable = plan.manifest(candidate: candidate, request: request)
        guard displayed == immutable, plan.permitsStart(at: Date()) else { fail(RealOptimizationError.expired); return }
        let alert = makeApprovalAlert(plan)
        let token = generation
        guard alert.runModal() == .alertFirstButtonReturn, token == generation, self.plan == plan, displayManifest == immutable else { return }
        busy = true; status = text("Rechecking the same cloud plan and current app identity/usage…", "正在复核同一份云端建议，以及当前应用身份与占用…"); showProgress()
        let job: () throws -> RealSocketStatus
        do { job = try exchangeJob("result_real") } catch { busy = false; fail(error); return }
        queue.async { [weak self] in
            let result = Result { try job() }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token else { return }
                do {
                    guard try result.get().plan == plan else { throw RealOptimizationError.changed }
                    if let candidate = self.candidate, plan.recommendsQuit { self.freshMeasurement(candidate, plan: plan, manifest: immutable, token: token) }
                    else { try self.beginApproved(plan: plan, candidate: nil, fresh: nil, manifest: immutable) }
                } catch { self.busy = false; self.fail(error) }
            }
        }
    }
    private func makeApprovalAlert(_ plan: RealPlan) -> NSAlert {
        let alert = NSAlert(); alert.messageText = plan.recommendsQuit ? text("Approve normal quit of this app?", "批准正常退出这个应用吗？") : text("Approve60seconds of observation?", "批准观测 60 秒吗？")
        alert.informativeText = (candidate.map { DiagnosticText.safeUntrusted($0.identity.displayName) + "\n" + usageText($0.usage) + "\n" + $0.identity.bundleID + " · " + $0.identity.teamID + "\n\n" } ?? "") + text("This approval applies once to this exact target and plan. Save your work first. The app controls any save prompt. No forced termination or automatic retry will occur. After a quit request is sent, Cancel cannot retract it.", "本次批准只适用于这份建议和这个确切目标，且仅执行一次。请先保存工作。保存提示由目标应用处理，不会强制终止或自动重试。退出请求发出后，取消无法撤回该请求。")
        alert.addButton(withTitle: text("Approve this action", "批准本次操作")); alert.addButton(withTitle: text("Cancel", "取消"))
        return alert
    }
    private func freshMeasurement(_ candidate: RealCandidate, plan: RealPlan, manifest: String, token: UUID) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let before = try self.probe.counter(for: candidate.identity)
                self.queue.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self else { return }
                    let result = Result { try RealAppCounter.usage(before, self.probe.counter(for: candidate.identity), maximumCores: ProcessInfo.processInfo.activeProcessorCount) }
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.generation == token else { return }
                        do { try self.beginApproved(plan: plan, candidate: candidate, fresh: result.get(), manifest: manifest) }
                        catch { if self.activeID != nil { self.interrupt(reason: "precondition_or_storage") } else { self.busy = false; self.fail(error) } }
                    }
                }
            } catch { DispatchQueue.main.async { [weak self] in guard let self, self.generation == token else { return }; self.busy = false; self.fail(error) } }
        }
    }
    private func beginApproved(plan: RealPlan, candidate: RealCandidate?, fresh: RealAppUsage?, manifest: String) throws {
        guard !requestConsumed, !storageError, self.plan == plan, let request, displayManifest == manifest, manifest == plan.manifest(candidate: candidate, request: request) else { throw RealOptimizationError.invalid }
        var gate = RealExecutionGate(manifest: manifest)
        try gate.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: fresh, now: Date())
        self.gate = gate
        if var candidate, let fresh { candidate.usage = fresh; self.candidate = candidate }
        try createReceipt(outcome: "approved", approved: true)
        if plan.recommendsQuit {
            guard let candidate = self.candidate, let endpoint else { throw RealOptimizationError.invalid }
            try self.gate?.takeQuitPermission()
            // Commit authorization + attempted request before the only side-effect API.
            try updateReceipt { $0.dispatchAttempted = true; $0.dispatchOutcomeKnown = false; $0.outcome = "quit_dispatch_pending" }
            let validUntil = try RoundtripJSON.date(candidate.usage.observedAt).addingTimeInterval(5)
            let accepted: Bool
            do { accepted = try probe.requestNormalQuit(candidate.identity, notAfter: validUntil, protecting: endpoint.descriptor.pid) }
            catch { finish("precondition_failed"); return }
            try updateReceipt { $0.dispatchOutcomeKnown = true; $0.quitRequested = accepted; $0.outcome = accepted ? "quit_requested" : "quit_dispatch_refused" }
            if !accepted { finish("precondition_failed"); return }
            status = text("Normal quit requested. If the app asks to save, handle it there. Waiting up to15seconds…", "已请求正常退出。若应用提示保存，请在该应用中处理。最多等待 15 秒…")
            showProgress(); waitForQuit(candidate)
        } else { try self.gate?.observeOnly(); observe() }
    }
    private func waitForQuit(_ candidate: RealCandidate) {
        let token = generation, began = Date(), uptime = ProcessInfo.processInfo.systemUptime
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, self.generation == token, self.activeID != nil else { return }
            let elapsed = ProcessInfo.processInfo.systemUptime - uptime
            guard elapsed >= 0, abs(Date().timeIntervalSince(began) - elapsed) < 3 else { self.interrupt(reason: "clock_or_sleep"); return }
            if self.probe.hasExited(candidate.identity) {
                do { try self.gate?.didExit(); try self.updateReceipt { $0.exitConfirmed = true }; self.observe() }
                catch { self.interrupt(reason: "storage_failed") }
            } else if elapsed >= 15 { self.finish("quit_refused_or_timed_out") }
        }
        self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    private func observe() {
        timer?.invalidate()
        let token = generation, began = Date(), uptime = ProcessInfo.processInfo.systemUptime
        status = text("Observing existing local metrics for60seconds…", "正在观测已有本机指标，持续 60 秒…"); showProgress()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.generation == token, self.activeID != nil else { return }
            let elapsed = ProcessInfo.processInfo.systemUptime - uptime
            guard elapsed >= 0, abs(Date().timeIntervalSince(began) - elapsed) < 3, elapsed <= 75 else { self.interrupt(reason: "clock_or_sleep"); return }
            self.status = self.text("Observed ", "已观测 ") + "\(Int(elapsed))/60 " + self.text("seconds", "秒")
            if self.ui.window?.isVisible == true { self.showProgress(activate: false) }
            if elapsed >= 60 { self.finish(self.plan?.recommendsQuit == true ? "quit_confirmed" : "observed") }
        }
        self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    private func createReceipt(outcome: String, approved: Bool) throws {
        guard !requestConsumed, !storageError, let request, let plan else { throw RealOptimizationError.invalid }
        let now = Date(), host = approved ? capture() : snapshot, id = UUID().uuidString.lowercased()
        let receipt = RealLocalReceipt(id: id, requestID: request.id, clientRequestHash: request.hash, runtimeInstanceID: endpoint?.descriptor.instanceID, planID: plan.id, planHash: plan.hash,
            manifest: plan.manifest(candidate: candidate, request: request), targetFingerprint: candidate?.identity.fingerprint ?? "none", appName: candidate?.identity.displayName ?? "",
            startedAt: RoundtripJSON.timestamp(now), approvalAt: approved ? RoundtripJSON.timestamp(now) : nil, outcome: outcome,
            quitRequested: false, exitConfirmed: false, before: host, beforeUsage: candidate?.usage)
        receipts.append(receipt); receipts = RealReceiptStorage.pruned(receipts, at: now); try storage.save(receipts); activeID = id; requestConsumed = true
        beforeWire = ["observed_at": approved ? RoundtripJSON.timestamp(now) : request.createdAt, "snapshot": host.json, "candidate": candidate?.wire() as Any? ?? NSNull()]
    }
    private func updateReceipt(_ change: (inout RealLocalReceipt) -> Void) throws {
        guard let id = activeID, let index = receipts.firstIndex(where: { $0.id == id }) else { throw RealOptimizationError.invalid }
        change(&receipts[index]); try storage.save(receipts)
    }
    private func finish(_ outcome: String, deliver: Bool = true, present: Bool = true) {
        timer?.invalidate(); timer = nil; gate?.finish(); receiptStatus = ""
        guard let id = activeID, let index = receipts.firstIndex(where: { $0.id == id }), let request, let plan else { return }
        let now = Date(), after = capture()
        receipts[index].completedAt = RoundtripJSON.timestamp(now); receipts[index].outcome = outcome; receipts[index].after = after
        let receipt = receipts[index]
        let afterWire: Any = ["observed_at": RoundtripJSON.timestamp(now), "snapshot": after.json,
                              "candidate": candidate.map { $0.wire(exited: receipt.exitConfirmed, at: receipt.exitConfirmed ? now : nil) } as Any? ?? NSNull()]
        let body: [String: Any] = ["schema_version": 1, "kind": "stats_real_receipt", "receipt_id": id, "client_request_id": request.id,
            "request_id": plan.serverID, "request_hash": plan.serverHash, "plan_id": plan.id, "plan_hash": plan.hash,
            "candidate_id": plan.candidateID as Any? ?? NSNull(), "policy_id": "local_capabilities_v1", "started_at": receipt.startedAt,
            "completed_at": RoundtripJSON.timestamp(now), "local_approval_at": receipt.approvalAt as Any? ?? NSNull(), "outcome": outcome,
            "quit_requested": receipt.quitRequested, "process_exit_confirmed": receipt.exitConfirmed, "before": beforeWire ?? [:], "after": ["quit_confirmed", "observed"].contains(outcome) || receipt.exitConfirmed ? afterWire : NSNull()]
        do {
            let json = try RealJSON.encode(body); receipts[index].cloudReceiptJSON = json; receipts[index].cloudReceiptHash = RoundtripJSON.digest(json)
            try storage.save(receipts); activeID = nil; busy = false; if present { showLast() }; if deliver { returnReceipt() }
        } catch { activeID = nil; busy = false; storageError = true; storageFailureDetail = String(describing: error); fail(RealOptimizationError.storage) }
    }
    @objc private func noAction() { guard !busy, !requestConsumed, plan?.decision == "no_action" else { return }; do { try createReceipt(outcome: "no_action", approved: false); finish("no_action") } catch { fail(error) } }
    @objc private func decline() { guard !busy, !requestConsumed else { return }; do { try createReceipt(outcome: "declined", approved: false); finish("declined") } catch { fail(error) } }
    @objc private func returnReceipt() {
        guard !busy, let receipt = receipts.last, let json = receipt.cloudReceiptJSON, let hash = receipt.cloudReceiptHash,
              let instance = receipt.runtimeInstanceID else { return }
        let token = generation
        if endpoint?.descriptor.instanceID != instance {
            busy = true; receiptStatus = text("Finding the original runtime for this saved receipt…", "正在查找这份已保存结果对应的原运行会话…"); showLast()
            let cancellation = cancellation
            queue.async { [weak self] in
                let result = Result { try SyntheticRuntimeDiscovery.find(cancellation: cancellation).filter { $0.descriptor.instanceID == instance } }
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.generation == token else { return }; self.busy = false
                    do { let matches = try result.get(); guard matches.count == 1 else { throw RuntimeDiscoveryError.originalRuntimeGone }; self.endpoint = matches[0]; self.returnReceipt() }
                    catch { self.receiptStatus = self.text("The original runtime is unavailable. This result remains local; it will not be sent to another session.", "原运行会话不可用。结果仍保存在本机，不会发送给其他会话。"); self.showLast() }
                }
            }
            return
        }
        guard let endpoint else { return }
        let job: () throws -> Void
        do {
            let body = try RoundtripJSON.object(json)
            let serverID = try RoundtripJSON.string(body, "request_id"), serverHash = try RoundtripJSON.string(body, "request_hash")
            let command: [String: Any] = ["schema_version": 2, "op": "receipt_real", "expected_instance_id": instance,
                "client_request_id": receipt.requestID, "client_request_hash": receipt.clientRequestHash, "request_id": serverID, "request_hash": serverHash,
                "receipt": ["schema_version": 1, "kind": "stats_real_receipt_envelope", "receipt_json": json, "receipt_hash": hash]]
            let bytes = Data(try RealJSON.encode(command).utf8), cancellation = cancellation
            job = {
                try endpoint.validateCurrent()
                let reply = try endpoint.transport.exchange(bytes, cancellation: cancellation, peer: endpoint.peer, beforeSend: endpoint.validateCurrent)
                let outer = try RoundtripJSON.object(reply); try RoundtripJSON.keys(outer, ["result"])
                let value = try RealJSON.object(outer, "result")
                try RoundtripJSON.keys(value, ["schema_version", "kind", "client_request_id", "client_request_hash", "request_id", "request_hash", "status", "bundle", "receipt"])
                let ack = try RealJSON.object(value, "receipt"); try RoundtripJSON.keys(ack, ["receipt_id", "receipt_hash"])
                guard try RoundtripJSON.number(value, "schema_version") == 1,
                      try RoundtripJSON.string(value, "kind") == "stats_real_socket_status",
                      try RoundtripJSON.string(value, "client_request_id") == receipt.requestID,
                      try RoundtripJSON.string(value, "client_request_hash") == receipt.clientRequestHash,
                      try RoundtripJSON.string(value, "request_id") == serverID, try RoundtripJSON.string(value, "request_hash") == serverHash,
                      try RoundtripJSON.string(ack, "receipt_id") == receipt.id, try RoundtripJSON.string(ack, "receipt_hash") == hash else { throw RealOptimizationError.invalid }
            }
        } catch { fail(error); return }
        busy = true; receiptStatus = text("Local result saved. Returning the bounded receipt to dot…", "本地结果已保存，正在向 dot 回传有限结果…"); showLast()
        queue.async { [weak self] in
            let result = Result { try job() }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token else { return }; self.busy = false
                do {
                    try result.get()
                    guard let index = self.receipts.firstIndex(where: { $0.id == receipt.id }) else { throw RealOptimizationError.invalid }
                    self.receipts[index].cloudReceiptConfirmed = true; try self.storage.save(self.receipts)
                    self.receiptStatus = self.text("The runtime confirmed the exact receipt hash. dot can now verify this result.", "运行端已确认同一份结果哈希，dot 现在可以核验。")
                } catch { self.receiptStatus = self.text("Result is saved locally; delivery to dot is unconfirmed. Retry returning the same result.", "结果已保存在本机；尚未确认送达 dot，可重试回传同一份结果。") }
                if self.ui.window?.isVisible == true { self.showLast() }
            }
        }
    }
    @objc private func showLast() {
        guard let value = receipts.last else { status = text("No result yet.", "暂无结果。"); open(); return }
        let title: String
        switch value.outcome {
        case "quit_confirmed": title = text("The original app process exited", "原应用进程已退出")
        case "observed": title = text("Observation completed", "观测已完成")
        case "quit_refused_or_timed_out": title = text("App exit was not confirmed", "未能确认应用退出")
        case "no_action": title = text("No local action was needed", "本次未执行本地操作")
        case "declined": title = text("You declined the action", "你已拒绝本次操作")
        default: title = text("The attempt stopped", "本次尝试已停止")
        }
        let effect = value.dispatchAttempted && !value.dispatchOutcomeKnown ? text("The app may have received a normal quit request, but the dispatch result was not saved before interruption. Its outcome is unknown; do not repeat this old plan.", "应用可能已收到正常退出请求，但中断前未能保存发送结果。实际结果未知，请不要重试这份旧建议。") : value.exitConfirmed ? text("The original process is gone. This confirms the quit, not a general performance improvement.", "原进程已不存在，这确认了退出结果，不代表整体性能已改善。") : value.quitRequested ? text("One normal quit was requested. The app may still be asking to save or may have refused. No force quit or retry followed; a request already sent cannot be recalled.", "曾发送一次正常退出请求。应用可能仍在等待保存，或拒绝退出。没有强制退出或重试；已发出的请求无法撤回。") : value.dispatchAttempted ? text("A normal-quit API call was attempted but acceptance was not confirmed. No forced exit or retry occurred.", "曾尝试调用正常退出接口，但未确认请求被接受，没有强制退出或重试。") : text("No quit request was sent.", "没有发送退出请求。")
        show(title, effect, sections: [SyntheticSection(title: text("Target and exact outcome", "目标与确切结果"), body: DiagnosticText.safeUntrusted(value.appName) + "\n" + (value.beforeUsage.map(usageText) ?? text("Observation only", "仅观测"))),
            SyntheticSection(title: text("Before · actual sample times", "操作前 · 实际采样时间"), body: hostText(value.before)),
            SyntheticSection(title: text("After · actual sample times", "操作后 · 实际采样时间"), body: hostText(value.after ?? .empty)),
            SyntheticSection(title: text("How to interpret this", "怎样理解结果"), body: text("Only compare new timestamps. Unchanged timestamps mean the same cached sample, not a new measurement. A short-term change does not establish cause or lasting improvement. If the slowdown remains, run another global diagnosis; do not repeatedly close apps based on this old plan.", "只有不同采样时间才能作为新的观测。时间相同表示同一份缓存，并非新测量。短期变化不能证明因果关系或长期改善。若仍然卡顿，可重新全局诊断，不要根据旧建议反复关闭应用。"))], buttons: [(text("New diagnosis", "重新诊断"), #selector(collect)), (text("Retry receipt delivery", "重试回传结果"), #selector(returnReceipt))], loading: busy, progress: receiptStatus.isEmpty ? (value.cloudReceiptConfirmed ? text("The runtime confirmed this exact result.", "运行端已确认同一份结果。") : text("Saved locally. Delivery to dot has not been confirmed.", "结果已保存在本机，尚未确认送达 dot。")) : receiptStatus)
    }
    private func showProgress(activate: Bool = true) { show(text("Diagnosis and optimization in progress", "诊断与优化进行中"), status, buttons: [(text("Cancel / stop observing", "取消／停止观测"), #selector(cancel))], loading: true, activate: activate) }
    private func fail(_ error: Error) {
        status = error is RealOptimizationError ? error.localizedDescription : DiagnosticText.error(error)
        show(text("This attempt cannot continue", "本次暂时无法继续"), status, buttons: [(text("Start again", "重新开始"), #selector(collect)), (text("Cancel", "取消"), #selector(cancel))], details: error.localizedDescription)
    }
    @objc private func cancel() {
        let oldRequest = request, oldEndpoint = endpoint, oldBinding = binding
        timer?.invalidate(); timer = nil; cancellation.cancel(); cancellation = SyntheticSocketCancellation(); generation = UUID(); busy = false; gate?.cancel(); receiptStatus = ""
        if activeID != nil { finish("cancelled") }
        else {
            resetPending(); status = text("Cancelled. No returned plan can start an action.", "已取消，返回的建议不能启动操作。"); open()
            if let oldRequest, let oldEndpoint {
                queue.async {
                    do {
                        try oldEndpoint.validateCurrent()
                        let command = try RealSocketStatus.command("cancel_real", request: oldRequest, endpointID: oldEndpoint.descriptor.instanceID)
                        let result = try oldEndpoint.transport.exchange(command, peer: oldEndpoint.peer, beforeSend: oldEndpoint.validateCurrent)
                        _ = try RealSocketStatus.parse(result, request: oldRequest, expected: oldBinding, at: Date())
                    } catch { /* Local cancellation remains authoritative. */ }
                }
            }
        }
    }
    private func resetPending() {
        generation = UUID(); cancellation.cancel(); cancellation = SyntheticSocketCancellation(); timer?.invalidate(); timer = nil
        request = nil; endpoint = nil; binding = nil; plan = nil; candidate = nil; gate = nil; displayManifest = nil; beforeWire = nil; sample = nil; previewAt = nil; requestConsumed = false; receiptStatus = ""
    }
    func interrupt(reason: String) {
        timer?.invalidate(); timer = nil; cancellation.cancel(); cancellation = SyntheticSocketCancellation(); generation = UUID(); busy = false; gate?.cancel(); receiptStatus = ""
        if activeID != nil {
            // Persist a terminal report, preserving any effect already accepted. No network during sleep/termination.
            finish("cancelled", deliver: false, present: false)
        } else if !requestConsumed { resetPending() }
        if reason != "app_termination", ui.window?.isVisible == true { showLast() }
    }
    func maintain(at now: Date) {
        let pruned = RealReceiptStorage.pruned(receipts, at: now)
        if pruned.count != receipts.count { receipts = pruned; do { try storage.save(receipts) } catch { storageError = true; storageFailureDetail = String(describing: error) } }
    }
    func stop() { interrupt(reason: "app_termination") }
    #if DIAGNOSTICS_TESTS
    func testSeed(request: RealDiagnosticRequest, plan: RealPlan, sample: RealGlobalSample, host: RealHostSnapshot) {
        self.request = request; self.plan = plan; self.sample = sample; self.snapshot = host
        self.candidate = sample.candidates.first { $0.id == plan.candidateID }; self.busy = false; self.requestConsumed = false
        showPlan(plan)
    }
    func testShowPreview() { status = ""; showPreview() }
    func testApprovalAlert() -> NSAlert { makeApprovalAlert(plan!) }
    func testShowRunning() { status = text("The app’s original process exited. Observing local metrics:30/60seconds.", "应用原进程已退出，正在观测本机指标：30/60 秒。"); showProgress() }
    func testConsumeAndReopen(cancelled: Bool) throws {
        guard !storageError else { throw RoundtripError.invalid("QA initialization storage failure: " + storageFailureDetail) }
        try createReceipt(outcome: "declined", approved: false)
        finish(cancelled ? "cancelled" : "declined")
        guard !storageError else { throw RoundtripError.invalid("QA finalization storage failure: " + storageFailureDetail) }
        let count = receipts.count
        open(); approve()
        guard requestConsumed, receipts.count == count, activeID == nil else { throw RoundtripError.invalid("QA consumed state changed: consumed=\(requestConsumed), count=\(receipts.count)/\(count), active=\(activeID != nil)") }
    }
    func testShowReceipt(_ receipt: RealLocalReceipt) { receipts = [receipt]; requestConsumed = true; busy = false; receiptStatus = ""; showLast() }
    #endif
}
