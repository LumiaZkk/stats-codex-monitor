// Actual Foundation-only production rule tests; run with ./scripts/test-diagnostics.sh.
import Foundation
import Darwin

// The Python harness owns fake sockets; this invokes the production Darwin transport.
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--socket-probe" {
    do {
        let cancellation = SyntheticSocketCancellation()
        if CommandLine.arguments[3] == "pre_cancel" { cancellation.cancel() }
        if CommandLine.arguments[3] == "cancel" { DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { cancellation.cancel() } }
        let reply = try SyntheticSocketTransport(directory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)).exchange(Data("{\"probe\":true}".utf8), cancellation: cancellation)
        guard CommandLine.arguments[3] == "success", reply == Data("{\"ok\":true}".utf8) else { exit(2) }
        exit(0)
    } catch {
        guard CommandLine.arguments[3] != "success" else { print(error.localizedDescription); exit(3) }
        if ["cancel", "pre_cancel"].contains(CommandLine.arguments[3]) {
            guard case SyntheticSocketError.cancelled = error else { exit(5) }
        }
        if CommandLine.arguments[3] == "timeout" {
            guard case SyntheticSocketError.timeout = error else { exit(4) }
        }
        exit(0)
    }
}


var passed = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { fatalError("FAIL: \(label)") }
    passed += 1
}
let start = Date(timeIntervalSince1970: 1_700_000_000)
func sample(_ kind: String, _ seconds: Double, _ values: [String: Double]) -> DiagnosticSample {
    DiagnosticSample(date: start.addingTimeInterval(seconds), kind: kind, values: values, processes: [])
}
var rules = DiagnosticsRules()
for minute in 0..<5 {
    check(rules.consume(sample("cpu", Double(minute * 60), ["usage": 0.86])) == nil, "CPU no early alert \(minute)")
}
check(rules.consume(sample("cpu", 300, ["usage": 0.86]))?.kind == "cpu", "CPU five-minute threshold")
for minute in 6..<35 {
    check(rules.consume(sample("cpu", Double(minute * 60), ["usage": 0.99])) == nil, "CPU cooldown \(minute)")
}
check(rules.consume(sample("cpu", 2100, ["usage": 0.99])) != nil, "CPU repeats after 30-minute cooldown")
var rolledBack = rules
_ = rolledBack.consume(sample("cpu", 1200, ["usage": 0.99]))
check(rolledBack.cpu.lastAlert == start.addingTimeInterval(1200), "Rollback clamps future cooldown date")
check(rules.consume(sample("cpu", 2160, ["usage": 0.85])) == nil, "Strict greater-than85 threshold recovers")
for minute in 37..<42 { _ = rules.consume(sample("cpu", Double(minute * 60), ["usage": 0.99])) }
check(rules.consume(sample("cpu", 2520, ["usage": 0.99])) != nil, "Recovery resets cooldown")
rules = DiagnosticsRules()
for minute in 0..<5 { _ = rules.consume(sample("cpu", Double(minute * 60), ["usage": 0.99])) }
check(rules.consume(sample("cpu", 3600, ["usage": 0.99])) == nil, "Sleep/gap cannot fabricate sustained CPU")
check(rules.cpu.since == start.addingTimeInterval(3600), "Gap starts new evidence")
rules.resetContinuity()
check(rules.cpu.since == nil && rules.cpu.lastSample == nil, "Explicit sleep resets evidence")
_ = rules.consume(sample("cpu", 3600, ["usage": 0.99]))
_ = rules.consume(sample("cpu", 3500, ["usage": 0.99]))
check(rules.cpu.since == start.addingTimeInterval(3500), "Backward clock resets evidence")
check(rules.consume(sample("cpu", 3560, ["usage": Double.nan])) == nil, "Invalid CPU rejected")
check(rules.consume(sample("cpu", 3560, ["usage": 1.1])) == nil, "Out-of-range CPU rejected")
rules = DiagnosticsRules()
for minute in 0..<3 {
    check(rules.consume(sample("memory", Double(minute * 60), ["pressure": 2])) == nil, "Memory no early warning \(minute)")
}
check(rules.consume(sample("memory", 180, ["pressure": 2]))?.severity == 1, "Memory warning after 3 minutes")
check(rules.consume(sample("pressure", 181, ["pressure": 4]))?.severity == 2, "Critical escalates immediately despite cooldown")
check(rules.consume(sample("pressure", 182, ["pressure": 4])) == nil, "Repeated critical is cooled down")
_ = rules.consume(sample("pressure", 182.2, ["pressure": 2]))
check(rules.consume(sample("pressure", 182.4, ["pressure": 4])) == nil, "Warning-critical oscillation cannot bypass cooldown")
_ = rules.consume(sample("pressure", 183, ["pressure": 1]))
check(rules.consume(sample("pressure", 184, ["pressure": 4])) != nil, "Recovered memory gets immediate new critical")
check(rules.consume(sample("pressure", 185, ["pressure": 0])) == nil, "Unknown memory pressure ignored")
rules = DiagnosticsRules()
let gib = 1_073_741_824.0
check(rules.consume(sample("disk", 0, ["free": 20*gib])) == nil, "20GiB not low")
check(rules.consume(sample("disk", 300, ["free": 19*gib]))?.severity == 1, "Disk enters low episode")
check(rules.consume(sample("disk", 3900, ["free": 15*gib])) == nil, "No duplicate disk alert beyond cooldown")
check(rules.consume(sample("disk", 4200, ["free": 9*gib]))?.severity == 2, "Disk escalates below10")
check(rules.consume(sample("disk", 4500, ["free": 12*gib])) == nil, "Disk partial recovery keeps episode")
check(rules.consume(sample("disk", 4800, ["free": 9*gib])) == nil, "Disk oscillation cannot spam escalation")
_ = rules.consume(sample("disk", 5100, ["free": 21*gib]))
check(rules.consume(sample("disk", 5400, ["free": 9*gib]))?.severity == 2, "Disk full recovery resets episode")
rules.resetContinuity()
check(rules.consume(sample("disk", 5700, ["free": 9*gib])) == nil, "Sleep does not duplicate disk episode")
let encoded = try JSONEncoder().encode(rules)
var restored = try JSONDecoder().decode(DiagnosticsRules.self, from: encoded)
restored.resetContinuity()
check(restored.consume(sample("disk", 6000, ["free": 9*gib])) == nil, "Restart preserves disk episode")
check(DiagnosticProcess.category(for: "/Users/someone/token-secret/bin/custom") == "Other process", "Unknown names and paths redacted")
check(DiagnosticProcess.category(for: "Safari") == "Web browser", "Known names become fixed categories")
var history = DiagnosticsArchive()
history.samples = [sample("cpu", -604801, ["usage": 0.4]), sample("cpu", -604800, ["usage": 0.4]), sample("cpu", 1, ["usage": 0.4])]
history.prune(at: start)
check(history.samples.count == 1, "Retention excludes older than seven days and future samples")
for i in 0..<100 { history.samples.append(sample("cpu", -Double(i), ["usage": 0.5])) }
let prompt = history.prompt(at: start)
check(prompt.utf8.count < 65_536, "Snapshot bounded")
check(prompt.contains("Do not use tools"), "Read-only instructions included")
let json = String(prompt[prompt.firstIndex(of: "{")!...])
let snapshot = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
check((snapshot["samples"] as! [Any]).count == 90, "Snapshot limits number of samples")
check(!prompt.contains("604800"), "Old history not included in snapshot")
print("PASS: \(passed) production rule/privacy assertions")
let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: temp) }
let store = DiagnosticsStorage(directory: temp)
var persisted = DiagnosticsArchive()
persisted.samples = [sample("cpu", 0, ["usage": 0.5]), sample("disk", 0, ["free": 19*gib])]
_ = persisted.rules.consume(persisted.samples[1])
try store.save(persisted, dirtyHours: [DiagnosticsStorage.hour(start)], at: start)
let roundtrip = try store.load(at: start)
check(roundtrip.samples.count == 2, "Hourly persistence roundtrip")
check(roundtrip.rules.disk.severity == 1, "Episode metadata roundtrip")
let later = start.addingTimeInterval(7 * 86400 + 1)
persisted.prune(at: later)
try store.save(persisted, dirtyHours: [], at: later)
let expired = try store.load(at: later)
check(expired.samples.isEmpty, "Expired persisted samples removed")
print("PASS: \(passed) total assertions including persistence")

// Native synthetic-file boundary tests use unchanged JS golden vectors.
let fixtureDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("DiagnosticsTests/Fixtures")
let requestBytes = try Data(contentsOf: fixtureDirectory.appendingPathComponent("native-request-v1.json"))
let resultBytes = try Data(contentsOf: fixtureDirectory.appendingPathComponent("native-result-v1.json"))
let testNow = try RoundtripJSON.date("2026-09-30T09:18:00.000Z")
let goldenRequest = try SyntheticClientRequest.parse(RoundtripJSON.object(requestBytes), at: testNow)
let goldenResult = try VerifiedSyntheticProposal.importFile(resultBytes, pending: goldenRequest, at: testNow)
check(goldenRequest.clientRequestHash == "01a04252d767ba642bc2dda18661fca82562c35fb0e63b00c7978f72a9f6ea93", "JS-Swift client hash vector")
check(goldenResult.requestHash == "f50df3dc65d0acecb21fbefe77a341114803022c9ed6700ab501267d7486316a", "JS-Swift request hash vector")
check(goldenResult.proposalHash == "26a8866e8661d9360958432b78a0b0d05d4ee046be74be35351ee5aa1d8546ba", "JS-Swift proposal Unicode/newline byte vector")
check(goldenResult.actions.count == 2 && goldenResult.actions[1].durationSeconds == 60, "Exact allowlisted actions decoded")
let generatedClient = try SyntheticClientRequest.create(at: RoundtripJSON.date("2026-09-30T09:15:00.000Z"), id: goldenRequest.clientRequestID)
check(generatedClient == goldenRequest, "Native-generated client envelope matches JS canonical vector")
func rejects(_ label: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError("FAIL: accepted \(label)") }
    catch { passed += 1 }
}
func mutatedResult(_ mutate: (inout [String: Any]) throws -> Void) throws -> Data {
    var object = try RoundtripJSON.object(resultBytes)
    try mutate(&object)
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}
func mutatedPlan(_ mutate: (inout [String: Any]) -> Void) throws -> Data {
    try mutatedResult { wrapper in
        var plan = try RoundtripJSON.object(RoundtripJSON.string(wrapper, "proposal_canonical_json"))
        mutate(&plan)
        let bytes = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys, .withoutEscapingSlashes])
        let string = String(data: bytes, encoding: .utf8)!
        wrapper["proposal_canonical_json"] = string
        wrapper["proposal_hash"] = RoundtripJSON.digest(string)
    }
}
rejects("expired result") { _ = try VerifiedSyntheticProposal.importFile(resultBytes, pending: goldenRequest, at: RoundtripJSON.date("2026-09-30T09:45:00.000Z")) }
rejects("different local request") {
    let other = try SyntheticClientRequest.create(at: testNow)
    _ = try VerifiedSyntheticProposal.importFile(resultBytes, pending: other, at: testNow)
}
rejects("oversized file") { _ = try RoundtripJSON.object(Data(repeating: 32, count: 16 * 1024 + 1)) }
rejects("duplicate escaped JSON key") { _ = try RoundtripJSON.object("{\"x\":1,\"\\u0078\":2}") }
rejects("trailing object") { _ = try RoundtripJSON.object("{} {}") }
rejects("unknown wrapper property") { _ = try VerifiedSyntheticProposal.importFile(mutatedResult { $0["command"] = "not allowed" }, pending: goldenRequest, at: testNow) }
rejects("boolean schema version") { _ = try VerifiedSyntheticProposal.importFile(mutatedResult { $0["schema_version"] = true }, pending: goldenRequest, at: testNow) }
rejects("altered proposal bytes without matching hash") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedResult { $0["proposal_canonical_json"] = "{}" }, pending: goldenRequest, at: testNow)
}
rejects("claim of authenticated integrity") { _ = try VerifiedSyntheticProposal.importFile(mutatedResult { $0["integrity"] = "authenticated" }, pending: goldenRequest, at: testNow) }
rejects("cancelled server status") { _ = try VerifiedSyntheticProposal.importFile(mutatedResult { $0["status"] = "cancelled" }, pending: goldenRequest, at: testNow) }
rejects("non-dry-run proposal even rehashed") { _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["dry_run"] = false }, pending: goldenRequest, at: testNow) }
rejects("shell action even rehashed") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "run_shell", "command": "echo denied", "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
rejects("arbitrary application target") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "open_activity_monitor", "target": "/tmp/evil.app", "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
rejects("extra path parameter") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "open_activity_monitor", "target": "current_device", "path": "/tmp/evil", "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
for duration in [0, 59, 121, 300, 999] {
    rejects("out of range duration \(duration)") {
        _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "observe_metrics", "metrics": ["cpu_utilization"], "duration_seconds": duration, "dry_run": true]] }, pending: goldenRequest, at: testNow)
    }
}
rejects("non-integer duration") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "observe_metrics", "metrics": ["cpu_utilization"], "duration_seconds": 60.5, "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
rejects("unknown metric") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "observe_metrics", "metrics": ["environment"], "duration_seconds": 60, "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
rejects("duplicate metrics") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = [["type": "observe_metrics", "metrics": ["cpu_utilization", "cpu_utilization"], "duration_seconds": 60, "dry_run": true]] }, pending: goldenRequest, at: testNow)
}
rejects("duplicate action types") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["actions"] = Array(repeating: ["type": "open_activity_monitor", "target": "current_device", "dry_run": true], count: 2) }, pending: goldenRequest, at: testNow)
}
rejects("proposal exceeds request expiry") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["expires_at"] = "2026-09-30T10:00:00.000Z" }, pending: goldenRequest, at: testNow)
}
rejects("request hash binding mismatch") {
    _ = try VerifiedSyntheticProposal.importFile(mutatedPlan { $0["request_hash"] = String(repeating: "0", count: 64) }, pending: goldenRequest, at: testNow)
}
var localState = LocalRoundtripState()
_ = try localState.create(at: RoundtripJSON.date("2026-09-30T09:15:00.000Z"), id: goldenRequest.clientRequestID)
_ = try localState.receive(resultBytes, at: testNow)
rejects("duplicate import") { _ = try localState.receive(resultBytes, at: testNow) }
rejects("approval of stale/changed manifest") { _ = try localState.authorize(manifestHash: String(repeating: "0", count: 64), before: [], at: testNow) }
var cancelledState = localState
try cancelledState.cancel(at: testNow)
rejects("approval after cancellation") { _ = try cancelledState.authorize(manifestHash: goldenResult.manifestHash, before: [], at: testNow) }
rejects("late approval") { _ = try localState.authorize(manifestHash: goldenResult.manifestHash, before: [], at: RoundtripJSON.date("2026-09-30T09:45:00.000Z")) }
let localReading = LocalMetricReading(metric: .cpu, value: 0.2, observedAt: RoundtripJSON.timestamp(testNow), freshness: .fresh)
_ = try localState.authorize(manifestHash: goldenResult.manifestHash, before: [localReading], at: testNow)
check(localState.phase == .executing && localState.activeReceipt?.originAuthenticated == false, "Separate explicit local authorization creates unverified-origin receipt")
check(localState.activeReceipt?.optimizationPerformed == false, "Receipt cannot claim optimization")
rejects("second approval while executing") { _ = try localState.authorize(manifestHash: goldenResult.manifestHash, before: [], at: testNow) }
rejects("replace request while running") { _ = try localState.create(at: testNow) }
var interruptedState = localState
interruptedState.recoverAfterRestart(at: testNow.addingTimeInterval(30))
check(interruptedState.phase == .interrupted && interruptedState.activeReceipt == nil, "Restart never resumes local actions")
try localState.finish(outcome: "completed_local_test", after: [localReading], at: testNow.addingTimeInterval(60))
check(localState.receipts.count == 1 && localState.receipts[0].before.count == 1 && localState.receipts[0].after.count == 1, "Before/after receipt retained")
rejects("completed proposal replay") { _ = try localState.receive(resultBytes, at: testNow) }
let stateDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: stateDirectory) }
let localStorage = LocalRoundtripStorage(directory: stateDirectory)
try localStorage.save(localState)
var restoredState = try localStorage.load(at: testNow.addingTimeInterval(60))
rejects("replay after persisted restart") { _ = try restoredState.receive(resultBytes, at: testNow.addingTimeInterval(60)) }
restoredState.prune(at: testNow.addingTimeInterval(7 * 86400 + 1))
check(restoredState.receipts.isEmpty, "Local receipt retention bounded to7days")
print("PASS: \(passed) total production assertions including synthetic roundtrip")
// Server/local clocks may differ by up to120s; hash/request identity stays exact.
func resultWithServerTimes(created: String, exported: String) throws -> Data {
    try mutatedResult { wrapper in
        var request = try RoundtripJSON.object(RoundtripJSON.string(wrapper, "request_canonical_json"))
        request["created_at"] = created
        let raw = String(data: try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
        wrapper["request_canonical_json"] = raw; wrapper["request_hash"] = RoundtripJSON.digest(raw)
        var plan = try RoundtripJSON.object(RoundtripJSON.string(wrapper, "proposal_canonical_json"))
        plan["request_hash"] = RoundtripJSON.digest(raw)
        let planRaw = String(data: try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
        wrapper["proposal_canonical_json"] = planRaw; wrapper["proposal_hash"] = RoundtripJSON.digest(planRaw)
        wrapper["exported_at"] = exported
    }
}
let behindServer = try resultWithServerTimes(created: "2026-09-30T09:13:30.000Z", exported: "2026-09-30T09:17:00.000Z")
_ = try VerifiedSyntheticProposal.importFile(behindServer, pending: goldenRequest, at: testNow)
check(true, "Server clock90s behind client request accepted")
let aheadServer = try resultWithServerTimes(created: "2026-09-30T09:19:00.000Z", exported: "2026-09-30T09:19:30.000Z")
_ = try VerifiedSyntheticProposal.importFile(aheadServer, pending: goldenRequest, at: testNow)
check(true, "Server clock90s ahead of client current time accepted")
rejects("server created more than120s before client") {
    _ = try VerifiedSyntheticProposal.importFile(resultWithServerTimes(created: "2026-09-30T09:12:59.000Z", exported: "2026-09-30T09:17:00.000Z"), pending: goldenRequest, at: testNow)
}
rejects("server export more than120s in future") {
    _ = try VerifiedSyntheticProposal.importFile(resultWithServerTimes(created: "2026-09-30T09:19:00.000Z", exported: "2026-09-30T09:20:01.000Z"), pending: goldenRequest, at: testNow)
}
print("PASS: \(passed) total production assertions including clock-skew vectors")
var nearExpiryState = LocalRoundtripState()
_ = try nearExpiryState.create(at: RoundtripJSON.date("2026-09-30T09:15:00.000Z"), id: goldenRequest.clientRequestID)
_ = try nearExpiryState.receive(resultBytes, at: testNow)
_ = try nearExpiryState.authorize(manifestHash: goldenResult.manifestHash, before: [], at: RoundtripJSON.date("2026-09-30T09:44:59.000Z"))
let justBeforeExpiry = try RoundtripJSON.date("2026-09-30T09:44:59.500Z")
let exactlyExpiry = try RoundtripJSON.date("2026-09-30T09:45:00.000Z")
check(nearExpiryState.mayContinueExecution(at: justBeforeExpiry), "Actions permitted only while approval unexpired")
check(!nearExpiryState.mayContinueExecution(at: exactlyExpiry), "Next action/ongoing observation forbidden at expiry")
try localStorage.save(nearExpiryState)
let interruptedReload = try localStorage.load(at: RoundtripJSON.date("2026-09-30T09:44:59.500Z"))
check(interruptedReload.phase == .interrupted && !interruptedReload.mayContinueExecution(at: testNow), "Persisted mid-action restart cannot resume")
try nearExpiryState.cancel(at: RoundtripJSON.date("2026-09-30T09:44:59.600Z"))
check(nearExpiryState.phase == .cancelled && nearExpiryState.activeReceipt == nil, "Cancellation terminates local execution state")
check(!nearExpiryState.mayContinueExecution(at: testNow), "Cancelled local execution cannot continue")
print("PASS: \(passed) total production assertions including interrupted execution")

// Native socket envelope uses the same byte-level JS/Swift golden vectors.
let socketBinding = SyntheticSocketBinding(requestID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestHash: goldenResult.requestHash)
func socketEnvelope(status: String = "requested", bundle: Any = NSNull(), mutate: ((inout [String: Any]) -> Void)? = nil) throws -> Data {
    var body: [String: Any] = ["schema_version": 1, "kind": "stats_native_socket_status",
        "client_request_id": goldenRequest.clientRequestID, "client_request_hash": goldenRequest.clientRequestHash,
        "request_id": socketBinding.requestID, "request_hash": socketBinding.requestHash, "status": status, "bundle": bundle]
    mutate?(&body)
    return try JSONSerialization.data(withJSONObject: ["result": body], options: [.sortedKeys, .withoutEscapingSlashes])
}
let socketWaiting = try SyntheticSocketProtocol.response(socketEnvelope(), request: goldenRequest, at: testNow)
check(socketWaiting.status == .requested && socketWaiting.bundle == nil && socketWaiting.binding == socketBinding, "Socket requested response pins request identity without actions")
let socketProposed = try SyntheticSocketProtocol.response(socketEnvelope(status: "proposed", bundle: RoundtripJSON.object(resultBytes)), request: goldenRequest, at: testNow, expected: socketBinding)
check(socketProposed.status == .proposed && socketProposed.bundle != nil, "Socket result validates existing cross-language bundle")
let socketCommand = try RoundtripJSON.object(SyntheticSocketProtocol.command(.diagnose, request: goldenRequest, at: testNow))
check(Set(socketCommand.keys) == ["schema_version", "op", "client_request"] && socketCommand["op"] as? String == "diagnose_native", "Outbound socket request contains only frozen synthetic envelope")
let socketRetry = try SyntheticSocketProtocol.command(.diagnose, request: goldenRequest, at: testNow.addingTimeInterval(1))
let socketOriginal = try SyntheticSocketProtocol.command(.diagnose, request: goldenRequest, at: testNow)
check(socketRetry == socketOriginal, "Retry uses byte-identical idempotent client envelope")
for status in ["requested", "cancelled", "expired"] {
    let result = try SyntheticSocketProtocol.response(socketEnvelope(status: status), request: goldenRequest, at: testNow)
    check(result.status.rawValue == status && result.bundle == nil, "No bundle for \(status) status")
}
rejects("socket unknown field") { _ = try SyntheticSocketProtocol.response(socketEnvelope { $0["command"] = "anything" }, request: goldenRequest, at: testNow) }
rejects("socket unknown status") { _ = try SyntheticSocketProtocol.response(socketEnvelope(status: "execute"), request: goldenRequest, at: testNow) }
rejects("socket wrong client ID") { _ = try SyntheticSocketProtocol.response(socketEnvelope { $0["client_request_id"] = UUID().uuidString.lowercased() }, request: goldenRequest, at: testNow) }
rejects("socket wrong client hash") { _ = try SyntheticSocketProtocol.response(socketEnvelope { $0["client_request_hash"] = String(repeating: "0", count: 64) }, request: goldenRequest, at: testNow) }
rejects("socket server identity changed after acceptance") { _ = try SyntheticSocketProtocol.response(socketEnvelope { $0["request_id"] = UUID().uuidString.lowercased() }, request: goldenRequest, at: testNow, expected: socketBinding) }
rejects("socket server hash changed after acceptance") { _ = try SyntheticSocketProtocol.response(socketEnvelope { $0["request_hash"] = String(repeating: "0", count: 64) }, request: goldenRequest, at: testNow, expected: socketBinding) }
rejects("socket proposed missing bundle") { _ = try SyntheticSocketProtocol.response(socketEnvelope(status: "proposed"), request: goldenRequest, at: testNow) }
rejects("socket waiting includes action bundle") { _ = try SyntheticSocketProtocol.response(socketEnvelope(bundle: RoundtripJSON.object(resultBytes)), request: goldenRequest, at: testNow) }
rejects("socket wrapper/bundle binding mismatch") { _ = try SyntheticSocketProtocol.response(socketEnvelope(status: "proposed", bundle: RoundtripJSON.object(resultBytes)) { $0["request_hash"] = String(repeating: "0", count: 64) }, request: goldenRequest, at: testNow) }
rejects("socket rejects legacy unbound runtime result") { _ = try SyntheticSocketProtocol.response(Data("{\"result\":{\"status\":\"requested\"}}".utf8), request: goldenRequest, at: testNow) }
rejects("socket duplicate outer key") { _ = try SyntheticSocketProtocol.response(Data("{\"error\":\"a\",\"error\":\"b\"}".utf8), request: goldenRequest, at: testNow) }
rejects("socket cannot submit expired request") { _ = try SyntheticSocketProtocol.command(.diagnose, request: goldenRequest, at: testNow.addingTimeInterval(3600)) }
_ = try SyntheticSocketProtocol.command(.cancel, request: goldenRequest, at: testNow.addingTimeInterval(3600))
check(true, "Local cancellation may request remote acknowledgement after expiry")
var socketState = LocalRoundtripState()
_ = try socketState.create(at: RoundtripJSON.date(goldenRequest.createdAt), id: goldenRequest.clientRequestID)
_ = try socketState.receive(socketProposed.bundle!, at: testNow)
check(socketState.phase == .reviewing && socketState.activeReceipt == nil, "Retrieving a proposal never authorizes or executes it")
try socketState.cancel(at: testNow)
rejects("late socket proposal after local cancellation") { _ = try socketState.receive(socketProposed.bundle!, at: testNow) }
var pendingRestart = LocalRoundtripState()
_ = try pendingRestart.create(at: RoundtripJSON.date(goldenRequest.createdAt), id: goldenRequest.clientRequestID)
try localStorage.save(pendingRestart)
let pendingReload = try localStorage.load(at: testNow)
check(pendingReload.phase == .waiting && pendingReload.request == goldenRequest && pendingReload.activeReceipt == nil, "Pending restart preserves only immutable data, no transport or approval")
print("PASS: \(passed) total production assertions including socket protocol")

let runtimeSocketGolden = try Data(contentsOf: URL(fileURLWithPath: "DiagnosticsTests/Fixtures/native-socket-status-v1.json"))
let decodedRuntimeSocketGolden = try SyntheticSocketProtocol.response(runtimeSocketGolden, request: goldenRequest, at: testNow)
check(decodedRuntimeSocketGolden.status == .proposed && decodedRuntimeSocketGolden.binding == socketBinding, "Actual runtime-generated socket golden fixture is compatible")
print("PASS: \(passed) total production assertions including shared runtime socket vector")
