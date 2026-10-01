import Foundation
import Cocoa

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) { assertions += 1; if !condition() { fatalError(message) } }
func rejects(_ message: String, _ block: () throws -> Void) { assertions += 1; do { try block(); fatalError("Accepted: " + message) } catch {} }
let root = URL(fileURLWithPath: "RealOptimizationTests/fixtures")
let vectors = try RoundtripJSON.object(Data(contentsOf: root.appendingPathComponent("real-vectors-v1.json")))
let now = try RoundtripJSON.date(vectors["test_clock"] as! String)
let envelope = try RoundtripJSON.object(Data(contentsOf: root.appendingPathComponent("real-request-v1.json")))
let bodyString = envelope["client_request_json"] as! String
let body = try RoundtripJSON.object(bodyString)
let candidates = body["candidates"] as! [[String: Any]]
let request = RealDiagnosticRequest(id: body["client_request_id"] as! String, createdAt: body["created_at"] as! String, expiresAt: body["expires_at"] as! String,
    json: bodyString, hash: envelope["client_request_hash"] as! String, candidateIDs: candidates.map { $0["candidate_id"] as! String })
check(RoundtripJSON.digest(bodyString) == vectors["client_request_hash"] as? String, "JS request digest matches UTF8")
let recanonical = try RealJSON.encode(body)
check(recanonical == bodyString, "Swift canonical Unicode request matches JS bytes")
let result = try RoundtripJSON.object(Data(contentsOf: root.appendingPathComponent("real-result-v1.json")))
let plan = try RealPlan.parse(result, pending: request, at: now)
check(plan.hash == vectors["proposal_hash"] as? String, "JS proposal hash matches")
check(plan.recommendsQuit, "Fixture proposes real quit")
check(plan.candidateID == request.candidateIDs[0], "Plan binds eligible opaque target")
let originalSummary = try RoundtripJSON.object(result["proposal_json"] as! String)["summary"] as? String
check(plan.summary == originalSummary, "Model summary is preserved as plain text")
check(plan.permitsStart(at: now), "Fresh plan has full bounded run time")
let nearExpiry = try RoundtripJSON.date(plan.expiresAt).addingTimeInterval(-79)
check(!plan.permitsStart(at: nearExpiry), "Near-expiry cannot begin")
func mutatePlan(_ modify: (inout [String: Any]) -> Void) throws -> [String: Any] {
    var changed = result, proposal = try RoundtripJSON.object(result["proposal_json"] as! String)
    modify(&proposal); let json = try RealJSON.encode(proposal); changed["proposal_json"] = json; changed["proposal_hash"] = RoundtripJSON.digest(json); return changed
}
for key in ["command", "path", "pid", "extra"] {
    rejects("unknown plan field") { _ = try RealPlan.parse(mutatePlan { $0[key] = "arbitrary" }, pending: request, at: now) }
}
rejects("different target") { _ = try RealPlan.parse(mutatePlan { $0["actions"] = [["type": "quit_app", "candidate_id": UUID().uuidString.lowercased()]] }, pending: request, at: now) }
rejects("force kill") { _ = try RealPlan.parse(mutatePlan { $0["actions"] = [["type": "force_kill", "candidate_id": request.candidateIDs[0]]] }, pending: request, at: now) }
rejects("two actions") { _ = try RealPlan.parse(mutatePlan { $0["actions"] = [["type": "quit_app", "candidate_id": request.candidateIDs[0]], ["type": "observe_metrics"]] }, pending: request, at: now) }
rejects("no approval flag") { _ = try RealPlan.parse(mutatePlan { $0["requires_local_approval"] = false }, pending: request, at: now) }
rejects("synthetic plan") { _ = try RealPlan.parse(mutatePlan { $0["dry_run"] = true }, pending: request, at: now) }
rejects("expired") { _ = try RealPlan.parse(result, pending: request, at: now.addingTimeInterval(700)) }
var tampered = result; tampered["proposal_hash"] = String(repeating: "0", count: 64)
rejects("tampered hash") { _ = try RealPlan.parse(tampered, pending: request, at: now) }
let observe = try RealPlan.parse(mutatePlan { $0["decision"] = "observe"; $0["actions"] = [["type": "observe_metrics"]] }, pending: request, at: now)
let noAction = try RealPlan.parse(mutatePlan { $0["decision"] = "no_action"; $0["actions"] = [] as [[String: Any]] }, pending: request, at: now)
check(observe.decision == "observe" && observe.candidateID == nil, "Observe needs no target")
check(noAction.decision == "no_action" && noAction.candidateID == nil, "No action needs no target")
let identity = RealAppIdentity(pid: 900001, uid: 501, startedSeconds: 42, startedMicroseconds: 12, bundleID: "com.example.editor", bundlePath: "/Applications/Editor.app", executablePath: "/Applications/Editor.app/Contents/MacOS/Editor", codeHash: "abcd", teamID: "TEAM", displayName: "Example Editor")
let usage = RealAppUsage(cpuBasisPoints: 3000, residentBytes: 512 * 1024 * 1024, intervalMS: 2000, observedAt: RoundtripJSON.timestamp(now))
let candidate = RealCandidate(id: request.candidateIDs[0], identity: identity, usage: usage)
let manifest = plan.manifest(candidate: candidate, request: request)
var gate = RealExecutionGate(manifest: manifest)
rejects("quit without approval") { try gate.takeQuitPermission() }
rejects("changed displayed manifest") { try gate.approve(displayed: "wrong", plan: plan, candidate: candidate, fresh: usage, now: now) }
try gate.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: usage, now: now)
try gate.takeQuitPermission()
rejects("replayed quit") { try gate.takeQuitPermission() }
try gate.didExit(); gate.finish()
rejects("completed plan replay") { try gate.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: usage, now: now) }
var cancelled = RealExecutionGate(manifest: manifest); cancelled.cancel()
rejects("cancelled approval") { try cancelled.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: usage, now: now) }
var stale = RealExecutionGate(manifest: manifest)
rejects("stale fresh precondition") { try stale.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: usage, now: now.addingTimeInterval(6)) }
var low = RealExecutionGate(manifest: manifest)
rejects("usage fell below threshold") { try low.approve(displayed: manifest, plan: plan, candidate: candidate, fresh: RealAppUsage(cpuBasisPoints: 100, residentBytes: 1024, intervalMS: 2000, observedAt: usage.observedAt), now: now) }
for blocked in ["com.apple.finder", "com.openai.chat", "com.vendor.codex", "io.statsdiagnostics", "com.iterm2", "app.warp"] {
    check(!RealAppPolicy.allowed(bundleID: blocked, name: "App", bundlePath: "/Applications/App.app", home: "/Users/test"), "Protected app excluded")
}
check(!RealAppPolicy.allowed(bundleID: "com.example.app", name: "App", bundlePath: "/tmp/App.app", home: "/Users/test"), "Unknown install location excluded")
check(RealAppPolicy.allowed(bundleID: "com.example.app", name: "App", bundlePath: "/Applications/App.app", home: "/Users/test"), "Ordinary GUI path allowed for further signature validation")
let c1 = RealAppCounter(user: 1_000_000_000, system: 0, resident: 1, uptime: 10, date: now)
let c2 = RealAppCounter(user: 2_000_000_000, system: 0, resident: 2048, uptime: 12, date: now.addingTimeInterval(2))
let measured = try RealAppCounter.usage(c1, c2, maximumCores: 8)
check(measured.cpuBasisPoints == 5000 && measured.residentBytes == 2048, "CPU delta is50% of one core over2s")
rejects("counter rollback") { _ = try RealAppCounter.usage(c2, c1, maximumCores: 8) }
let before = try RealHostSnapshot.parse(body["snapshot"] as! [String: Any], at: try RoundtripJSON.date(request.createdAt))
check(before.cpuBasisPoints != nil, "Timestamped host cache parses")
let socketBytes = try Data(contentsOf: root.appendingPathComponent("real-socket-status-v1.json"))
let socket = try RealSocketStatus.parse(socketBytes, request: request, expected: nil, at: now)
check(socket.plan == plan, "Actual shared outer status parses")
rejects("server binding mismatch") { _ = try RealSocketStatus.parse(socketBytes, request: request, expected: (UUID().uuidString.lowercased(), plan.serverHash), at: now) }
let command = try RealSocketStatus.command("diagnose_real", request: request, endpointID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
check(command.count < 16384 && !command.contains(10), "One bounded frame")
rejects("unknown socket operation") { _ = try RealSocketStatus.command("execute", request: request, endpointID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd") }
let localOnly = ["bundlePath", "executablePath", "codeHash", "startedSeconds", "pid", "teamID"]
let wire = try RealJSON.encode(candidate.wire())
check(localOnly.allSatisfy { !wire.contains("\"" + $0 + "\"") }, "Wire target has no local identity fields")
let receiptEnvelope = try RoundtripJSON.object(Data(contentsOf: root.appendingPathComponent("real-receipt-v1.json")))
let compactReceipt = try RealSocketStatus.command("receipt_real", request: request, endpointID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", receipt: receiptEnvelope, server: (plan.serverID, plan.serverHash))
let compactObject = try RoundtripJSON.object(compactReceipt)
check(compactObject["client_request"] == nil && compactObject["client_request_hash"] as? String == request.hash, "Receipt uses compact immutable binding")
check(compactReceipt.count < 16384, "Receipt fits complete frame")
var unavailable = before.json; unavailable["host_cpu_basis_points"] = NSNull()
rejects("timestamp claims absent CPU value") { _ = try RealHostSnapshot.parse(unavailable, at: now) }
let storeURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let store = RealReceiptStorage(directory: storeURL)
var durable = RealLocalReceipt(id: UUID().uuidString.lowercased(), requestID: request.id, clientRequestHash: request.hash, planID: plan.id, planHash: plan.hash, manifest: manifest, targetFingerprint: identity.fingerprint, appName: "Fixture", startedAt: RoundtripJSON.timestamp(now), outcome: "quit_dispatch_pending", quitRequested: false, exitConfirmed: false, before: before, beforeUsage: usage)
durable.dispatchAttempted = true; durable.dispatchOutcomeKnown = false
try store.save([durable])
let recovered = try store.load(at: now.addingTimeInterval(3))
check(recovered.count == 1 && recovered[0].outcome == "interrupted_by_restart", "Restart never resumes a saved approval")
check(recovered[0].dispatchAttempted && !recovered[0].dispatchOutcomeKnown, "Unknown dispatch survives restart honestly")
check(RealReceiptStorage.pruned(recovered, at: now.addingTimeInterval(7 * 86400 + 1)).isEmpty, "Real receipts expire after7days")
try FileManager.default.removeItem(at: storeURL)
// Read-only Darwin integration: two actual kernel counter reads, no target app or quit call.
let nativeProbe = RealAppProbe()
let tableBefore = nativeProbe.processTable()
Thread.sleep(forTimeInterval: 2)
let tableAfter = nativeProbe.processTable()
check(tableBefore.counters[getpid()] != nil && tableAfter.counters[getpid()] != nil, "Darwin reads this test process without elevated access")
let global = nativeProbe.globalSample(before: tableBefore, after: tableAfter)
check(global.consumers.count <= 10 && global.candidates.count <= 5, "Actual global sampling respects top-N limits")
check(global.coverage["helpers_aggregated"] as? Bool == false, "Coverage discloses unaggregated helpers")
let actualWire = try RealJSON.encode(["consumers": global.consumers, "candidates": global.candidates.map { $0.wire() }, "coverage": global.coverage])
check(localOnly.allSatisfy { !actualWire.contains("\"" + $0 + "\"") }, "Actual sampling keeps kernel identity fields local")
print("PASS real optimization: \(assertions) assertions; no process quit or network was invoked")
