// Native, local-only diagnostics UI. MIT; see LICENSE.
import Cocoa
import Kit
import UserNotifications

final class DiagnosticsController: NSObject, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var archive = DiagnosticsArchive()
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var pressureSource: DispatchSourceMemoryPressure?
    private var skipNextCPU = true
    private var sleeping = false
    private var housekeeping: Timer?
    private var saveWork: DispatchWorkItem?
    private var roundtrip: SyntheticRoundtripController?
    private var window: NSWindow?
    private var textView: NSTextView?
    private var previewPrompt = ""
    private var storageError: String?
    private var latest: [String: DiagnosticSample] = [:]
    private var lastAccepted: [String: Date] = [:]
    private let directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("StatsDiagnostics", isDirectory: true)
    private lazy var storage = DiagnosticsStorage(directory: directory)
    private var dirtyHours: Set<Int> = []

    override init() {
        super.init()
        archive = (try? storage.load(at: Date())) ?? DiagnosticsArchive()
        archive.prune(at: Date())
        archive.rules.resetContinuity()
        roundtrip = SyntheticRoundtripController(directory: directory) { [weak self] metrics in
            self?.captureLocalMetrics(metrics) ?? metrics.map { LocalMetricReading(metric: $0, value: nil, observedAt: nil, freshness: .unavailable) }
        }
        item.button?.title = "SD ·"
        item.button?.toolTip = "Stats Diagnostics: local CPU, memory and disk history"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        observers.append(NotificationCenter.default.addObserver(forName: DiagnosticsBridge.notification, object: nil, queue: .main) { [weak self] note in
            self?.receive(note)
        })
        for name in [Notification.Name.pause, Notification.Name.toggleModule] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.resetContinuity()
            })
        }
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sleeping = true
            self?.resetContinuity()
            self?.save()
        })
        workspaceObservers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sleeping = false
            self?.resetContinuity()
        })
        // An OS pressure event is not a second RAM poller. It catches critical pressure
        // immediately between normal 60-second Stats RAM samples.
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let source = self.pressureSource, !self.sleeping,
                  !Store.shared.bool(key: "pause", defaultValue: false),
                  Store.shared.bool(key: "RAM_state", defaultValue: true) else { return }
            let value = source.data.contains(.critical) ? 4.0 : (source.data.contains(.warning) ? 2.0 : 1.0)
            self.accept(DiagnosticSample(date: Date(), kind: "pressure", values: ["pressure": value], processes: []))
        }
        pressureSource = source
        source.resume()
        housekeeping = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            let count = self.archive.samples.count + self.archive.events.count
            self.archive.prune(at: Date())
            self.roundtrip?.maintain(at: Date())
            self.updateIndicator()
            if count != self.archive.samples.count + self.archive.events.count { self.save() }
        }
        housekeeping?.tolerance = 10
        scheduleSave()
    }

    func stop() {
        roundtrip?.stop()
        housekeeping?.invalidate()
        saveWork?.cancel()
        save()
        pressureSource?.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        NSStatusBar.system.removeStatusItem(item)
    }
    private func resetContinuity() {
        roundtrip?.interrupt(reason: "sleep_pause_or_collection_change")
        archive.rules.resetContinuity()
        skipNextCPU = true
        latest.removeAll()
        lastAccepted.removeAll()
        item.button?.title = "SD ·"
    }
    private func receive(_ note: Notification) {
        guard !sleeping, !Store.shared.bool(key: "pause", defaultValue: false),
              let info = note.userInfo, let kind = info["kind"] as? String,
              let values = info["values"] as? [String: Double], let date = info["date"] as? Date else { return }
        let allowed: [String: Set<String>] = ["cpu": ["usage"], "memory": ["used", "total", "swap", "pressure"],
                                            "disk": ["free", "total"], "cpuProcesses": [], "memoryProcesses": []]
        guard let keys = allowed[kind], date <= Date(), Date().timeIntervalSince(date) < 90 else { return }
        if kind == "cpu", let usage = values["usage"], !usage.isFinite || !(0...1).contains(usage) { return }
        if kind == "cpu", skipNextCPU { skipNextCPU = false; return }
        // Settings/manual popup refreshes cannot inflate history or sustained evidence.
        let minimum: TimeInterval = kind == "disk" || kind.hasSuffix("Processes") ? 295 : 55
        if let last = lastAccepted[kind] {
            let elapsed = date.timeIntervalSince(last)
            if elapsed < 0 { resetContinuity() }
            else if elapsed < minimum { return }
        }
        let filtered = values.filter { keys.contains($0.key) && $0.value.isFinite && $0.value >= 0 }
        let processes = ((info["processes"] as? [TopProcess]) ?? []).prefix(5).compactMap { process -> DiagnosticProcess? in
            guard process.usage.isFinite, process.usage >= 0 else { return nil }
            return DiagnosticProcess(category: DiagnosticProcess.category(for: process.name), usage: process.usage)
        }
        lastAccepted[kind] = date
        accept(DiagnosticSample(date: date, kind: kind, values: filtered, processes: processes))
    }
    private func accept(_ sample: DiagnosticSample) {
        latest[sample.kind] = sample
        archive.samples.append(sample)
        dirtyHours.insert(DiagnosticsStorage.hour(sample.date))
        if let event = archive.rules.consume(sample) {
            archive.events.append(event)
            notify(event)
        }
        archive.prune(at: Date())
        updateIndicator()
        scheduleSave()
    }
    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.save() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }
    private func save() {
        archive.prune(at: Date())
        do {
            try storage.save(archive, dirtyHours: dirtyHours, at: Date())
            dirtyHours.removeAll()
            storageError = nil
        } catch {
            storageError = "History could not be saved: \(error.localizedDescription)"
            item.button?.title = "SD !"
        }
    }
    private func notify(_ event: DiagnosticEvent) {
        guard UserDefaults.standard.bool(forKey: "DiagnosticsLocalNotifications") else { return }
        let content = UNMutableNotificationContent()
        content.title = "Stats Diagnostics"
        content.body = event.message + ". Open SD to review; nothing is sent to AI automatically."
        content.sound = .default
        content.userInfo = ["diagnostics": true]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "diagnostics-\(event.kind)", content: content, trigger: nil))
    }
    private func updateIndicator() {
        let now = Date()
        func fresh(_ kind: String, _ module: String, _ seconds: TimeInterval) -> DiagnosticSample? {
            guard Store.shared.bool(key: "\(module)_state", defaultValue: true),
                  let sample = latest[kind], now.timeIntervalSince(sample.date) >= 0, now.timeIntervalSince(sample.date) <= seconds else { return nil }
            return sample
        }
        let cpu = fresh("cpu", "CPU", 90)
        let memory = [fresh("memory", "RAM", 90), fresh("pressure", "RAM", 90)].compactMap { $0 }.max { $0.date < $1.date }
        let disk = fresh("disk", "Disk", 360)
        let warning = (cpu?.values["usage"] ?? 0) > 0.85 || (memory?.values["pressure"] ?? 1) > 1 ||
            (disk?.values["free"] ?? .greatestFiniteMagnitude) < 20 * 1_073_741_824
        let hasFreshData = cpu != nil || memory != nil || disk != nil
        item.button?.title = storageError != nil || warning ? "SD !" : (hasFreshData ? "SD ✓" : "SD ·")
        item.button?.toolTip = summary()
    }
    private func captureLocalMetrics(_ metrics: [LocalMetric]) -> [LocalMetricReading] {
        metrics.map { metric in
            var sample: DiagnosticSample?
            var value: Double?
            var limit: TimeInterval = 90
            let module: String
            switch metric {
            case .cpu:
                module = "CPU"; sample = latest["cpu"]; value = sample?.values["usage"]
            case .memory:
                module = "RAM"
                sample = [latest["memory"], latest["pressure"]].compactMap { $0 }.max { $0.date < $1.date }
                value = sample?.values["pressure"]
            case .disk:
                module = "Disk"; sample = latest["disk"]; limit = 360
                if let free = sample?.values["free"] { value = free / 1_073_741_824 }
            }
            guard !sleeping, !Store.shared.bool(key: "pause", defaultValue: false),
                  Store.shared.bool(key: "\(module)_state", defaultValue: true),
                  let source = sample, let reading = value, reading.isFinite,
                  Date().timeIntervalSince(source.date) >= 0 else {
                return LocalMetricReading(metric: metric, value: nil, observedAt: nil, freshness: .unavailable)
            }
            return LocalMetricReading(metric: metric, value: reading, observedAt: RoundtripJSON.timestamp(source.date),
                                      freshness: Date().timeIntervalSince(source.date) <= limit ? .fresh : .stale)
        }
    }
    private func summary() -> String {
        var parts: [String] = []
        if Store.shared.bool(key: "pause", defaultValue: false) { return "Monitoring paused" }
        if let sample = latest["cpu"], let value = sample.values["usage"] {
            parts.append("CPU \(Int(value * 100))%\(age(sample, maximum: 90))")
        }
        if let sample = latest["memory"], let swap = sample.values["swap"] {
            parts.append(String(format: "Swap %.1f GiB%@", swap / 1_073_741_824, age(sample, maximum: 90)))
        }
        if let sample = latest["disk"], let free = sample.values["free"] {
            parts.append(String(format: "Disk %.1f GiB free%@", free / 1_073_741_824, age(sample, maximum: 360)))
        }
        return parts.isEmpty ? "Waiting for fresh Stats samples…" : parts.joined(separator: " · ")
    }
    private func age(_ sample: DiagnosticSample, maximum: TimeInterval) -> String {
        Date().timeIntervalSince(sample.date) > maximum ? " (stale)" : ""
    }
    func menuNeedsUpdate(_ menu: NSMenu) {
        updateIndicator()
        menu.removeAllItems()
        let status = NSMenuItem(title: summary(), action: nil, keyEquivalent: "")
        menu.addItem(status)
        if let error = storageError { menu.addItem(NSMenuItem(title: error, action: nil, keyEquivalent: "")) }
        menu.addItem(.separator())
        add("History (7 days)…", #selector(showHistory), to: menu)
        add("Diagnose…", #selector(diagnose), to: menu)
        if roundtrip == nil {
            roundtrip = SyntheticRoundtripController(directory: directory) { [weak self] metrics in
                self?.captureLocalMetrics(metrics) ?? metrics.map { LocalMetricReading(metric: $0, value: nil, observedAt: nil, freshness: .unavailable) }
            }
        }
        roundtrip?.appendMenu(to: menu)
        add("Enable local notifications…", #selector(enableNotifications), to: menu)
        add("Open local history folder", #selector(openFolder), to: menu)
        menu.addItem(.separator())
        add("Stats settings…", #selector(openSettings), to: menu)
    }
    private func add(_ title: String, _ action: Selector, to menu: NSMenu) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self
        menu.addItem(entry)
    }
    @objc func showHistory() {
        archive.prune(at: Date())
        let formatter = ISO8601DateFormatter()
        var lines = ["Local history: last 7 days; \(archive.samples.count) retained readings", summary(),
                     "CPU/RAM/swap: 60 seconds · Startup disk/top processes: 5 minutes", "", "Alerts (latest 50)"]
        lines += archive.events.suffix(50).reversed().map { "\(formatter.string(from: $0.date))  \($0.message)" }
        lines += ["", "Readings (latest 240; full seven-day hourly JSON in local history folder)"]
        lines += archive.samples.suffix(240).reversed().map { sample in
            let values = sample.values.sorted { $0.key < $1.key }.map { "\($0.key)=\(String(format: "%.2f", $0.value))" }.joined(separator: "  ")
            return "\(formatter.string(from: sample.date))  \(sample.kind)  \(values)"
        }
        present(title: "Stats Diagnostics · Local history", text: lines.joined(separator: "\n"), diagnosis: false)
    }
    @objc private func diagnose() {
        archive.prune(at: Date())
        previewPrompt = archive.prompt(at: Date())
        let notice = """
        Review the sanitized snapshot below. Nothing has been sent and no model is running.
        Copy the prompt, share it with dot or your chosen analyzer in a new conversation.
        Only your explicit submission may use your AI plan or incur charges. This version does not invoke
        Codex CLI automatically: a tool-free, snapshot-only CLI session could not be guaranteed.
        The analyzer is asked for read-only advice. Review its next steps; no automatic fix is authorized.

        """
        present(title: "Diagnose · Review before sharing", text: notice + previewPrompt, diagnosis: true)
    }
    private func present(title: String, text: String, diagnosis: Bool) {
        window?.close()
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 580),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.title = title
        let root = NSStackView()
        root.orientation = .vertical
        root.spacing = 10
        root.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 720, height: 480))
        view.isEditable = false
        view.isSelectable = true
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.string = text
        scroll.documentView = view
        root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -28).isActive = true
        if diagnosis {
            let buttons = NSStackView()
            buttons.orientation = .horizontal
            for (label, action) in [("Copy prompt", #selector(copyPrompt)), ("Save prompt…", #selector(savePrompt)), ("Open analyzer app…", #selector(openCodex))] {
                buttons.addArrangedSubview(NSButton(title: label, target: self, action: action))
            }
            root.addArrangedSubview(buttons)
        }
        w.contentView = root
        textView = view
        window = w
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func copyPrompt() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(previewPrompt, forType: .string)
    }
    @objc private func savePrompt() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "stats-diagnostic-prompt.txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try previewPrompt.write(to: url, atomically: true, encoding: .utf8) }
        catch { showError(error.localizedDescription) }
    }
    @objc private func openCodex() {
        // Choose an installed application explicitly. No invented app URL/private API,
        // command interpolation, credential copying, automatic paste, or model execution.
        let panel = NSOpenPanel()
        panel.title = "Choose your installed analyzer application"
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.allowedFileTypes = ["app"]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url,
              url.pathExtension == "app", Bundle(url: url) != nil else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
            if let error { DispatchQueue.main.async { self?.showError(error.localizedDescription) } }
        }
    }
    @objc private func enableNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            UserDefaults.standard.set(granted, forKey: "DiagnosticsLocalNotifications")
            if !granted { DispatchQueue.main.async { self.showError("Notifications are off. Enable Stats Diagnostics in macOS notification settings if desired.") } }
        }
    }
    @objc private func openFolder() { save(); NSWorkspace.shared.open(directory) }
    @objc private func openSettings() { NotificationCenter.default.post(name: .toggleSettings, object: nil) }
    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Stats Diagnostics"
        alert.informativeText = message
        alert.runModal()
    }
}
