// Native presentation only. It cannot send requests or authorize local execution.
import Cocoa

private final class SyntheticCard: NSView {
    override var isFlipped: Bool { true }
    private let heading: NSTextField
    private let body: NSTextField
    init(_ section: SyntheticSection) {
        heading = NSTextField(wrappingLabelWithString: section.title)
        body = NSTextField(wrappingLabelWithString: section.body)
        super.init(frame: .zero)
        wantsLayer = true; layer?.cornerRadius = 8
        heading.font = .systemFont(ofSize: 13, weight: .semibold)
        body.font = .systemFont(ofSize: 13, weight: .regular)
        for field in [heading, body] { field.isSelectable = true; field.maximumNumberOfLines = 0; addSubview(field) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func reflow(width: CGFloat) -> CGFloat {
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        let contentWidth = max(80, width - 28)
        func height(_ field: NSTextField) -> CGFloat {
            ceil(field.attributedStringValue.boundingRect(with: NSSize(width: contentWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height) + 4
        }
        let top = height(heading), bottom = height(body)
        heading.frame = NSRect(x: 14, y: 12, width: contentWidth, height: top)
        body.frame = NSRect(x: 14, y: 18 + top, width: contentWidth, height: bottom)
        return 32 + top + bottom
    }
}
private final class SyntheticCardDocument: NSView {
    override var isFlipped: Bool { true }
    let cards: [SyntheticCard]
    init(_ sections: [SyntheticSection]) { cards = sections.map(SyntheticCard.init); super.init(frame: .zero); cards.forEach(addSubview) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func reflow(width: CGFloat) {
        var y: CGFloat = 0
        for card in cards {
            let height = card.reflow(width: width - 4)
            card.frame = NSRect(x: 0, y: y, width: width - 4, height: height)
            y += height + 12
        }
        frame.size = NSSize(width: width, height: max(1, y - 12))
    }
}
private final class SyntheticCardScroll: NSScrollView {
    override func tile() {
        super.tile()
        (documentView as? SyntheticCardDocument)?.reflow(width: contentView.bounds.width)
    }
}

final class SyntheticStatusWindow: NSObject {
    struct Button {
        let title: String
        let action: Selector
        let enabled: Bool
        var isApproval = false
    }
    private(set) var window: NSWindow?
    private var detailScroll: NSScrollView?
    private var detailsExpanded = false
    func show(title: String, introduction: String, sections: [SyntheticSection] = [], progress: String = "", buttons: [Button], target: AnyObject,
              details: String = "", busy: Bool = false, localEvidence: Bool = false, activate: Bool = true, realOptimization: Bool = false) {
        let w: NSWindow
        if let existing = window { w = existing }
        else {
            w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 700), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false; w.minSize = NSSize(width: 660, height: 580); w.center(); window = w
        }
        w.title = realOptimization ? DiagnosticText.text("Stats Diagnostics · Diagnose and optimize", "Stats Diagnostics · 诊断与优化") : DiagnosticText.text("Stats Diagnostics · Guided demo", "Stats Diagnostics · 模拟体验")
        let container = NSView()
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24), root.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24), root.topAnchor.constraint(equalTo: container.topAnchor, constant: 22), root.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -22)])
        func label(_ value: String, size: CGFloat, weight: NSFont.Weight = .regular) {
            let field = NSTextField(wrappingLabelWithString: value); field.font = .systemFont(ofSize: size, weight: weight)
            field.isSelectable = true; field.setContentCompressionResistancePriority(.required, for: .vertical)
            root.addArrangedSubview(field); field.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        }
        label(realOptimization ? DiagnosticText.text("THIS MAC · APPROVAL REQUIRED FOR EVERY ACTION", "这台 Mac 的实测数据 · 每次操作都需批准") : localEvidence ? DiagnosticText.text("LOCAL RESULTS · NO PERFORMANCE OPTIMIZATION", "本地结果 · 未执行性能优化") : DiagnosticText.text("GUIDED SIMULATION · NOT A DIAGNOSIS OF THIS MAC", "模拟体验 · 尚未诊断这台 Mac"), size: 11, weight: .semibold)
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 10
        let titleLabel = NSTextField(wrappingLabelWithString: title); titleLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        heading.addArrangedSubview(titleLabel)
        if busy {
            let spinner = NSProgressIndicator(); spinner.style = .spinning; spinner.controlSize = .small
            spinner.setAccessibilityLabel(DiagnosticText.text("In progress", "正在处理")); spinner.startAnimation(nil); heading.addArrangedSubview(spinner)
        }
        root.addArrangedSubview(heading); heading.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        if !progress.isEmpty { label(progress, size: 12, weight: .medium) }
        if !localEvidence && !realOptimization { label(DiagnosticText.text("Fixed example: CPU 92% · memory normal · free disk 80 GiB", "固定样例：CPU 92% · 内存正常 · 磁盘可用 80 GiB"), size: 12) }
        let intro = SyntheticSection(title: DiagnosticText.text("What this means", "这意味着什么"), body: introduction)
        let scroll = SyntheticCardScroll(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.documentView = SyntheticCardDocument([intro] + sections)
        root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
        for (index, item) in buttons.enumerated() {
            let button = NSButton(title: item.title, target: target, action: item.action)
            button.bezelStyle = .rounded; button.isEnabled = item.enabled
            if index == 0, item.enabled, !item.isApproval { button.keyEquivalent = "\r" }
            row.addArrangedSubview(button)
        }
        root.addArrangedSubview(row)
        detailScroll = nil
        if !details.isEmpty {
            let disclosure = NSButton(checkboxWithTitle: DiagnosticText.text("Technical details (optional)", "技术详情（可选）"), target: self, action: #selector(toggleDetails))
            disclosure.state = detailsExpanded ? .on : .off; root.addArrangedSubview(disclosure)
            let detail = NSScrollView(); detail.hasVerticalScroller = true; detail.borderType = .bezelBorder
            let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 660, height: 150))
            text.isEditable = false; text.isSelectable = true; text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView = true; text.string = details
            detail.documentView = text; root.addArrangedSubview(detail)
            detail.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
            detail.heightAnchor.constraint(equalToConstant: 150).isActive = true
            detail.isHidden = !detailsExpanded; detailScroll = detail
        }
        w.contentView = container; w.contentView?.layoutSubtreeIfNeeded(); scroll.tile()
        if activate { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) } else { w.displayIfNeeded() }
    }
    @objc private func toggleDetails(_ sender: NSButton) { detailsExpanded = sender.state == .on; detailScroll?.isHidden = !detailsExpanded }
    static func approval(for proposal: VerifiedSyntheticProposal) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = DiagnosticText.text("Allow these local test actions?", "允许这些本地测试操作吗？")
        alert.informativeText = DiagnosticText.text("The model’s suggestion is simulated and its source is unverified. You are separately approving only:\n\n", "模型建议来自模拟样例，来源未经验证。你现在单独批准的只有：\n\n") + proposal.actions.map { action in
            switch action.kind {
            case .openActivityMonitor: return DiagnosticText.text("• Open Activity Monitor so you can inspect processes; change nothing.", "• 打开活动监视器，供你查看进程，不修改进程。")
            case .observeMetrics: return DiagnosticText.text("• Observe existing \(action.metrics.map(DiagnosticText.metric).joined(separator: ", ")) readings for \(action.durationSeconds) seconds; keep them local.", "• 只读观测已有的\(action.metrics.map(DiagnosticText.metric).joined(separator: "、"))，持续 \(action.durationSeconds) 秒，读数仅保留在本机。")
            }
        }.joined(separator: "\n\n") + DiagnosticText.text("\n\nThis will not find or fix the cause of a slowdown. You can cancel observation; an Activity Monitor launch already requested cannot be recalled. The exact proposal is rechecked before starting.", "\n\n这些操作不会查明或修复卡顿原因。你可以取消观测；已经请求打开的活动监视器无法撤回。执行前会再次核验同一份建议。")
        alert.addButton(withTitle: DiagnosticText.text("Approve these local tests", "批准这些本地测试"))
        alert.addButton(withTitle: DiagnosticText.text("Do not run", "不执行"))
        return alert
    }
}
