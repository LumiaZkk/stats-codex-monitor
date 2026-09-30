// Actual Foundation-only production rule tests; run with ./scripts/test-diagnostics.sh.
import Foundation

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
