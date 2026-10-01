// AppKit smoke/render test: no socket, model, process launch, or real collectors.
import Cocoa

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let zh = CommandLine.arguments.contains("--chinese")
let output = URL(fileURLWithPath: CommandLine.arguments.last!, isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }
let lock = NSLock()
var calls = 0
let controller = SyntheticRoundtripController(directory: directory, capture: { _ in [] }, discover: { cancellation in
    lock.lock(); calls += 1; lock.unlock()
    Thread.sleep(forTimeInterval: 0.15) // A bounded simulated discovery latency, no I/O.
    try cancellation.check()
    return []
})
func run(_ selector: String) { controller.perform(NSSelectorFromString(selector)) }
func pump(_ seconds: TimeInterval = 0.05) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
func window() -> NSWindow { app.windows.first { $0.isVisible && $0.contentView != nil }! }
func visibleText() -> String { descendants(window().contentView!).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: "\n") }
func button(_ title: String) -> NSButton { descendants(window().contentView!).compactMap { $0 as? NSButton }.first { $0.title == title }! }
func check(_ condition: @autoclosure () -> Bool, _ name: String) { if !condition() { fatalError("UI FAIL: " + name) } }
func snapshot(_ name: String) throws {
    pump()
    let view = window().contentView!; view.layoutSubtreeIfNeeded()
    for field in descendants(view).compactMap({ $0 as? NSTextField }) where !field.isHiddenOrHasHiddenAncestor {
        let rect = field.convert(field.bounds, to: view)
        if field.enclosingScrollView == nil {
            check(rect.minY >= -1 && rect.maxY <= view.bounds.maxY + 1 && rect.minX >= -1 && rect.maxX <= view.bounds.maxX + 1, "Header fits the window: " + field.stringValue.prefix(30))
        } else { check(field.bounds.width > 0 && field.bounds.height > 0, "Scrollable card has a real layout") }
    }
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("UI render unavailable") }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    // NSView caching preserves transparency. Composite onto the app background in
    // AppKit so artifact viewers do not accidentally render black text on black.
    guard let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: bitmap.pixelsWide, pixelsHigh: bitmap.pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: canvas) else { fatalError("Canvas unavailable") }
    context.cgContext.setFillColor(CGColor(gray: 1, alpha: 1))
    context.cgContext.fill(view.bounds)
    context.cgContext.setBlendMode(.normal)
    guard let rendered = bitmap.cgImage else { fatalError("Rendered image unavailable") }
    context.cgContext.draw(rendered, in: view.bounds)
    context.flushGraphics()
    check(canvas.colorAt(x: 0, y: 0)?.alphaComponent == 1, "Artifact has an opaque inspection background")
    guard let png = canvas.representation(using: .png, properties: [:]) else { fatalError("PNG render unavailable") }
    try png.write(to: output.appendingPathComponent((zh ? "zh-" : "en-") + name + ".png"))
}
run("reviewCurrent")
check(visibleText().contains(zh ? "体验一次模拟诊断" : "Try a guided simulated diagnosis"), "App language applied")
check(visibleText().contains("92%"), "Fixed synthetic fixture remains visible")
let original = window()
try snapshot("ready")
run("sendSynthetic")
check(window() === original, "Same window survives action")
check(visibleText().contains(zh ? "正在查找" : "Finding"), "Click immediately shows discovery progress")
check(!button(zh ? "发送测试" : "Send test").isEnabled, "Send visibly disabled while discovering")
run("sendSynthetic")
try snapshot("finding")
pump(0.3)
check(visibleText().contains(zh ? "尚未连接本机运行端" : "Local connection unavailable"), "Missing runtime is an obvious state")
lock.lock(); let firstCalls = calls; lock.unlock()
check(firstCalls == 1, "Repeated click did not submit another discovery")
check(button(zh ? "发送合成测试" : "Send synthetic test").isEnabled, "Retry possible after failure")
try snapshot("disconnected")
run("sendSynthetic")
run("cancel")
pump(0.3)
check(visibleText().contains(zh ? "请求已取消" : "Request cancelled"), "Late discovery cannot replace cancellation")
try snapshot("cancelled")
run("createRequest")
check(visibleText().contains(zh ? "请求已暂停" : "Request paused"), "Manual request remains visibly separate")
check(button(zh ? "重试本次请求" : "Retry same request").isEnabled, "Pending request exposes bound retry")
try snapshot("pending")
run("cancel")
window().close(); controller.stop()
// Local receipt display uses synthetic test-only numbers as real-reading-format fixtures.
var state = LocalRoundtripState()
state.receipts = [LocalTestReceipt(receiptID: UUID().uuidString.lowercased(), clientRequestID: UUID().uuidString.lowercased(), proposalHash: String(repeating: "0", count: 64), manifestHash: String(repeating: "1", count: 64), startedAt: RoundtripJSON.timestamp(Date()), finishedAt: RoundtripJSON.timestamp(Date()), outcome: "completed_local_test", actionResults: ["fixture_only"], before: [LocalMetricReading(metric: .cpu, value: 0.21, observedAt: RoundtripJSON.timestamp(Date()), freshness: .fresh)], after: [LocalMetricReading(metric: .memory, value: 1, observedAt: nil, freshness: .unavailable)], observations: [])]
try LocalRoundtripStorage(directory: directory).save(state)
let receiptController = SyntheticRoundtripController(directory: directory, capture: { _ in [] })
receiptController.perform(NSSelectorFromString("showReceipt"))
check(visibleText().contains(zh ? "在本机实际发生" : "real local test outcomes"), "Receipt and synthetic fixture clearly distinguished")
check(!visibleText().contains("92%"), "Real receipt does not show synthetic numbers as evidence")
try snapshot("receipt")
window().close(); receiptController.stop()
// Render the exact presentation factories used by the live controller. Never execute them.
func proposalFixture() throws -> VerifiedSyntheticProposal {
    let now = Date(), expires = RoundtripJSON.timestamp(now.addingTimeInterval(1800))
    let pending = try SyntheticClientRequest.create(at: now)
    var wrapper = try RoundtripJSON.object(Data(contentsOf: URL(fileURLWithPath: "DiagnosticsTests/Fixtures/native-result-v1.json")))
    let client = try RoundtripJSON.object(pending.json())
    var request = try RoundtripJSON.object(wrapper["request_canonical_json"] as! String)
    request["client_request"] = client; request["created_at"] = pending.createdAt; request["expires_at"] = expires
    func canonical(_ object: [String: Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)! }
    let requestText = try canonical(request), requestHash = RoundtripJSON.digest(requestText)
    var plan = try RoundtripJSON.object(wrapper["proposal_canonical_json"] as! String)
    plan["request_hash"] = requestHash; plan["expires_at"] = expires
    plan["summary"] = zh ? "固定样例中的 CPU 使用率为 92%，负载较高，但样例不能说明这台 Mac 的原因。建议由你批准打开活动监视器，并只读观察 60 秒，验证本地建议与操作结果的展示。不会执行优化。" : "The fixed sample shows high CPU usage at 92%; it does not identify a cause on this Mac. With your approval, open Activity Monitor and observe existing readings for 60 seconds to demonstrate the local review and result flow. No optimization is performed."
    let planText = try canonical(plan)
    wrapper["client_request"] = client; wrapper["request_canonical_json"] = requestText; wrapper["request_hash"] = requestHash
    wrapper["proposal_canonical_json"] = planText; wrapper["proposal_hash"] = RoundtripJSON.digest(planText); wrapper["exported_at"] = pending.createdAt
    return try VerifiedSyntheticProposal.importFile(JSONSerialization.data(withJSONObject: wrapper), pending: pending, at: now)
}
let proposal = try proposalFixture()
let preview = SyntheticStatusWindow(), inertTarget = NSObject()
func showModel(_ model: SyntheticExperience, approval: Bool = false) {
    let label = approval ? DiagnosticText.text("Review local approval…", "查看并决定是否批准…") : model.busy ? DiagnosticText.text("Stop observation", "停止观测") : DiagnosticText.text("Back to overview", "返回概览")
    var buttons = [SyntheticStatusWindow.Button(title: label, action: NSSelectorFromString("noop"), enabled: true, isApproval: approval)]
    if approval { buttons.append(SyntheticStatusWindow.Button(title: DiagnosticText.text("Do not run", "不执行"), action: NSSelectorFromString("noop"), enabled: true)) }
    if model.localEvidence { buttons.append(SyntheticStatusWindow.Button(title: DiagnosticText.text("Save local result…", "保存本地结果…"), action: NSSelectorFromString("noop"), enabled: true)) }
    preview.show(title: model.title, introduction: model.introduction, sections: model.sections, progress: model.progress,
                 buttons: buttons, target: inertTarget, busy: model.busy, localEvidence: model.localEvidence)
}
showModel(.proposal(proposal), approval: true)
check(visibleText().contains(proposal.untrustedSummary), "Returned model summary is primary content")
check(visibleText().contains(zh ? "为什么" : "Why:"), "Each allowed action has a rationale")
check(visibleText().contains(zh ? "会发生什么" : "What happens:"), "Each allowed action explains impact")
check(button(zh ? "查看并决定是否批准…" : "Review local approval…").keyEquivalent.isEmpty, "No default Enter approval")
try snapshot("proposal")
let cardScroll = descendants(window().contentView!).compactMap { $0 as? NSScrollView }.first!
if let document = cardScroll.documentView { document.scroll(NSPoint(x: 0, y: document.bounds.height)); pump() }
try snapshot("proposal-actions")
preview.window?.close()
let approval = SyntheticStatusWindow.approval(for: proposal)
approval.layout(); approval.window.orderFront(nil)
check(visibleText().contains(zh ? "不会查明或修复" : "will not find or fix"), "Approval explains the outcome limit")
try snapshot("approval")
approval.window.close()
let started = Date().addingTimeInterval(-30), finish = started.addingTimeInterval(60)
let before = LocalMetricReading(metric: .cpu, value: 0.31, observedAt: RoundtripJSON.timestamp(started), freshness: .fresh)
let after = LocalMetricReading(metric: .cpu, value: 0.24, observedAt: RoundtripJSON.timestamp(finish), freshness: .fresh)
var fullReceipt = LocalTestReceipt(receiptID: "ui-fixture", clientRequestID: proposal.clientRequestID, proposalHash: proposal.proposalHash, manifestHash: proposal.manifestHash, startedAt: RoundtripJSON.timestamp(started), outcome: "started", actionResults: ["activity_monitor_opened; no optimization performed", "observation_started: 60s; existing collectors only"], before: [before], after: [], observations: [])
showModel(.running(proposal, receipt: fullReceipt))
check(visibleText().contains(zh ? "30 秒" : "30 seconds"), "Running view shows elapsed observation time")
try snapshot("running")
fullReceipt.finishedAt = RoundtripJSON.timestamp(finish); fullReceipt.outcome = "completed_local_test"
fullReceipt.actionResults.append("observation_finished; compare timestamps and freshness, not synthetic fixture values")
fullReceipt.after = [after]; fullReceipt.observations = [[after]]
showModel(.receipt(fullReceipt))
check(visibleText().contains(zh ? "已打开" : "Opened:"), "Completion displays per-action outcome")
try snapshot("completed")
if let scroll = descendants(window().contentView!).compactMap({ $0 as? NSScrollView }).first, let document = scroll.documentView { document.scroll(NSPoint(x: 0, y: document.bounds.height)); pump() }
try snapshot("completed-next-step")
fullReceipt.outcome = "interrupted_sleep"; fullReceipt.actionResults.removeLast(); fullReceipt.after = []
showModel(.receipt(fullReceipt))
check(visibleText().contains(zh ? "观测在完成前停止" : "before completion"), "Interrupted view identifies partial outcome")
try snapshot("interrupted")
preview.window?.close()
print("PASS: AppKit \(zh ? "zh-Hans" : "en") status, click, cancel, proposal, approval, running, completed and interrupted render checks")
