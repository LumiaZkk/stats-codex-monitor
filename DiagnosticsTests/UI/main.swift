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
        check(rect.minY >= -1 && rect.maxY <= view.bounds.maxY + 1 && rect.minX >= -1 && rect.maxX <= view.bounds.maxX + 1, "Visible label fits the status window: " + field.stringValue.prefix(30))
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
check(visibleText().contains(zh ? "测试与 dot 的连接" : "Test the connection with dot"), "App language applied")
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
check(visibleText().contains(zh ? "真实本地读数" : "Real local readings"), "Receipt and synthetic fixture clearly distinguished")
check(!visibleText().contains("92%"), "Real receipt does not show synthetic numbers as evidence")
try snapshot("receipt")
window().close(); receiptController.stop()
print("PASS: AppKit \(zh ? "zh-Hans" : "en") status, repeat-click, cancel and receipt smoke/render checks")
