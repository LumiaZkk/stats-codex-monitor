// One selected-app action. Cloud text can propose; only local approval authorizes.
import Foundation
import CoreFoundation

enum RealOptimizationError: Error, LocalizedError {
    case ineligible, changed, insufficient, expired, invalid, storage, noConsent
    var errorDescription: String? {
        switch self {
        case .ineligible: return DiagnosticText.text("This app is not eligible. Choose a signed ordinary GUI app in Applications. System apps, terminals and this connection’s apps are excluded.", "该应用不符合条件。请选择“应用程序”中的已签名普通界面应用。系统应用、终端及本次连接依赖的应用均被排除。")
        case .changed: return DiagnosticText.text("The selected app, its measurements or its identity changed. Nothing else will be attempted; measure again.", "所选应用、采样或身份已发生变化。已停止后续操作，请重新测量。")
        case .insufficient: return DiagnosticText.text("Current main-process usage is below the minimum candidate threshold (25% of one CPU core or 512 MiB resident memory). No quit is proposed.", "当前主进程占用未达到候选门槛（单个 CPU 核心的 25%，或 512 MiB 常驻内存），不会建议退出。")
        case .expired: return DiagnosticText.text("The proposal expired or has too little time remaining. Start a new diagnosis.", "建议已过期或剩余时间不足，请重新诊断。")
        case .invalid: return DiagnosticText.text("The reply does not match this request, target or allowed action. No quit was authorized.", "返回结果与本次请求、目标或允许的操作不匹配，未授权退出应用。")
        case .storage: return DiagnosticText.text("The local receipt could not be saved. No further action will run.", "本地结果无法保存，已停止后续操作。")
        case .noConsent: return DiagnosticText.text("Sending real data needs an explicit preview confirmation and the approved real runtime scope.", "发送真实数据需要你明确确认预览，并使用已获准的真实诊断运行会话。")
        }
    }
}

enum RealJSON {
    static func encode(_ value: [String: Any]) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count < SyntheticSocketTransport.maximumBytes, let string = String(data: bytes, encoding: .utf8) else { throw RealOptimizationError.invalid }
        return string
    }
    static func bool(_ value: [String: Any], _ key: String, _ expected: Bool) throws {
        guard let number = value[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID(), number.boolValue == expected else { throw RealOptimizationError.invalid }
    }
    static func integer(_ value: [String: Any], _ key: String, in range: ClosedRange<Double>) throws -> Int64 {
        let number = try RoundtripJSON.number(value, key)
        guard number.rounded() == number, range.contains(number) else { throw RealOptimizationError.invalid }
        return Int64(number)
    }
    static func object(_ value: [String: Any], _ key: String) throws -> [String: Any] {
        guard let object = value[key] as? [String: Any] else { throw RealOptimizationError.invalid }; return object
    }
}

struct RealHostSnapshot: Codable, Equatable {
    var cpuBasisPoints: Int?
    var cpuObservedAt: String?
    var memoryPressure: String?
    var swapBytes: UInt64?
    var memoryObservedAt: String?
    var diskFreeBytes: UInt64?
    var diskObservedAt: String?
    var diskReadBytesPerSecond: UInt64?
    var diskWriteBytesPerSecond: UInt64?
    var ioObservedAt: String?
    var json: [String: Any] {
        ["host_cpu_basis_points": cpuBasisPoints as Any? ?? NSNull(), "cpu_observed_at": cpuObservedAt as Any? ?? NSNull(),
         "memory_pressure": memoryPressure as Any? ?? NSNull(), "swap_used_bytes": swapBytes as Any? ?? NSNull(),
         "memory_observed_at": memoryObservedAt as Any? ?? NSNull(), "disk_free_bytes": diskFreeBytes as Any? ?? NSNull(),
         "disk_observed_at": diskObservedAt as Any? ?? NSNull(),
         "disk_read_bytes_per_second": diskReadBytesPerSecond as Any? ?? NSNull(), "disk_write_bytes_per_second": diskWriteBytesPerSecond as Any? ?? NSNull(),
         "io_observed_at": ioObservedAt as Any? ?? NSNull()]
    }
    static let empty = Self()
    static func parse(_ object: [String: Any], at now: Date) throws -> Self {
        try RoundtripJSON.keys(object, ["host_cpu_basis_points", "cpu_observed_at", "memory_pressure", "swap_used_bytes", "memory_observed_at", "disk_free_bytes", "disk_observed_at", "disk_read_bytes_per_second", "disk_write_bytes_per_second", "io_observed_at"])
        func date(_ key: String, age: TimeInterval) throws -> String? {
            if object[key] is NSNull { return nil }
            let stamp = try RoundtripJSON.string(object, key), value = try RoundtripJSON.date(stamp)
            guard (-1...age).contains(now.timeIntervalSince(value)) else { throw RealOptimizationError.invalid }; return stamp
        }
        func integer(_ key: String, maximum: Double = 9_007_199_254_740_991) throws -> Int64? {
            object[key] is NSNull ? nil : try RealJSON.integer(object, key, in: 0...maximum)
        }
        let cpuDate = try date("cpu_observed_at", age: 120), memoryDate = try date("memory_observed_at", age: 120), diskDate = try date("disk_observed_at", age: 600)
        let cpu = try integer("host_cpu_basis_points", maximum: 10000), swap = try integer("swap_used_bytes"), disk = try integer("disk_free_bytes")
        let ioDate = try date("io_observed_at", age: 120), read = try integer("disk_read_bytes_per_second"), write = try integer("disk_write_bytes_per_second")
        let pressure = object["memory_pressure"] is NSNull ? nil : try RoundtripJSON.string(object, "memory_pressure")
        guard (read != nil) == (ioDate != nil), (write != nil) == (ioDate != nil), (cpu != nil) == (cpuDate != nil), (disk != nil) == (diskDate != nil),
              (pressure != nil || swap != nil) == (memoryDate != nil), pressure == nil || ["normal", "warning", "critical"].contains(pressure!) else { throw RealOptimizationError.invalid }
        return Self(cpuBasisPoints: cpu.map(Int.init), cpuObservedAt: cpuDate, memoryPressure: pressure, swapBytes: swap.map(UInt64.init), memoryObservedAt: memoryDate, diskFreeBytes: disk.map(UInt64.init), diskObservedAt: diskDate, diskReadBytesPerSecond: read.map(UInt64.init), diskWriteBytesPerSecond: write.map(UInt64.init), ioObservedAt: ioDate)
    }
}

struct RealCandidate: Codable, Equatable {
    let id: String
    let identity: RealAppIdentity // local only; never included in wire dictionaries
    var usage: RealAppUsage
    func wire(exited: Bool = false, at now: Date? = nil) -> [String: Any] {
        ["candidate_id": id, "display_name": String(String.UnicodeScalarView(identity.displayName.unicodeScalars.prefix(64))), "category": "ordinary_gui_app",
         "cpu_basis_points": exited ? NSNull() : usage.cpuBasisPoints as Any,
         "resident_bytes": exited ? NSNull() : usage.residentBytes as Any,
         "interval_ms": exited ? NSNull() : usage.intervalMS as Any,
         "observed_at": now.map(RoundtripJSON.timestamp) ?? usage.observedAt,
         "measurement_scope": "main_process_only"]
    }
}

struct RealDiagnosticRequest: Equatable {
    let id: String
    let createdAt: String
    let expiresAt: String
    let json: String
    let hash: String
    let candidateIDs: [String]
    var envelope: [String: Any] { ["schema_version": 1, "kind": "stats_real_request", "client_request_json": json, "client_request_hash": hash] }
    static func create(sample: RealGlobalSample, snapshot: RealHostSnapshot, recent: [[String: Any]], consentAt: Date, at now: Date, intent: RealCollectionIntent? = nil) throws -> Self {
        guard sample.candidates.allSatisfy({ candidate in
            guard let observed = try? RoundtripJSON.date(candidate.usage.observedAt) else { return false }
            return (0...30).contains(now.timeIntervalSince(observed))
        }), sample.consumers.allSatisfy({ row in
            guard let stamp = row["observed_at"] as? String, let observed = try? RoundtripJSON.date(stamp) else { return false }
            return (0...30).contains(now.timeIntervalSince(observed))
        }), consentAt <= now, now.timeIntervalSince(consentAt) < 600 else { throw RealOptimizationError.noConsent }
        if let intent { try intent.validate(at: now); guard consentAt >= (try RoundtripJSON.date(intent.createdAt)) else { throw RealOptimizationError.noConsent } }
        let id = intent?.id ?? UUID().uuidString.lowercased(), created = RoundtripJSON.timestamp(now)
        let expires = RoundtripJSON.timestamp(min(now.addingTimeInterval(600), try intent.map { try RoundtripJSON.date($0.expiresAt) } ?? now.addingTimeInterval(600)))
        let body: [String: Any] = ["schema_version": 1, "kind": "stats_real_diagnostic", "client_request_id": id, "created_at": created, "expires_at": expires,
                                   "consent": ["scope": "global_diagnostics_v1", "confirmed_at": RoundtripJSON.timestamp(consentAt)], "snapshot": snapshot.json, "candidates": sample.candidates.map { $0.wire() }, "consumers": sample.consumers, "coverage": sample.coverage, "recent_samples": recent, "capabilities": ["quit_app", "observe_metrics"]]
        let json = try RealJSON.encode(body)
        return Self(id: id, createdAt: created, expiresAt: expires, json: json, hash: RoundtripJSON.digest(json), candidateIDs: sample.candidates.map(\.id))
    }
}

// The request inbox carries only a one-shot intent. It never carries host readings,
// process names, commands, targets, or approval for collection or execution.
struct RealCollectionIntent: Equatable {
    let id: String
    let createdAt: String
    let expiresAt: String
    let hash: String
    func validate(at now: Date) throws {
        try RoundtripJSON.uuid(id); try RoundtripJSON.hash(hash)
        let start = try RoundtripJSON.date(createdAt), end = try RoundtripJSON.date(expiresAt)
        guard start <= now.addingTimeInterval(RoundtripJSON.clockSkew), end > now, end > start,
              end.timeIntervalSince(start) <= 600 else { throw RealOptimizationError.expired }
    }
    static func parsePoll(_ bytes: Data, at now: Date) throws -> Self? {
        guard bytes.count <= 4096 else { throw RealOptimizationError.invalid }
        let wrapper = try RoundtripJSON.object(bytes); try RoundtripJSON.keys(wrapper, ["result"])
        let value = try RealJSON.object(wrapper, "result")
        try RoundtripJSON.keys(value, ["schema_version", "kind", "intent", "intent_hash"])
        guard try RoundtripJSON.number(value, "schema_version") == 1,
              try RoundtripJSON.string(value, "kind") == "stats_global_collection_poll" else { throw RealOptimizationError.invalid }
        if value["intent"] is NSNull {
            guard value["intent_hash"] is NSNull else { throw RealOptimizationError.invalid }; return nil
        }
        let body = try RealJSON.object(value, "intent")
        try RoundtripJSON.keys(body, ["schema_version", "kind", "intent_id", "created_at", "expires_at", "consent_scope"])
        guard try RoundtripJSON.number(body, "schema_version") == 1,
              try RoundtripJSON.string(body, "kind") == "stats_global_collection_intent",
              try RoundtripJSON.string(body, "consent_scope") == "global_diagnostics_v1" else { throw RealOptimizationError.invalid }
        let intent = Self(id: try RoundtripJSON.string(body, "intent_id"), createdAt: try RoundtripJSON.string(body, "created_at"),
                          expiresAt: try RoundtripJSON.string(body, "expires_at"), hash: try RoundtripJSON.string(value, "intent_hash"))
        try intent.validate(at: now)
        guard intent.hash == (try RoundtripJSON.digest(RealJSON.encode(body))) else { throw RealOptimizationError.invalid }
        return intent
    }
    static func pollCommand(endpointID: String, sessionID: String) throws -> Data {
        try command("next_global_collection_intent", endpointID: endpointID, sessionID: sessionID)
    }
    func declineCommand(endpointID: String, sessionID: String) throws -> Data {
        try Self.command("resolve_global_collection_intent", endpointID: endpointID, sessionID: sessionID,
                         fields: ["intent_id": id, "intent_hash": hash, "decision": "declined"])
    }
    func diagnoseCommand(request: RealDiagnosticRequest, endpointID: String, sessionID: String, at now: Date) throws -> Data {
        try validate(at: now)
        let body = try RoundtripJSON.object(request.json), consent = try RealJSON.object(body, "consent")
        guard request.id == id, request.hash == RoundtripJSON.digest(request.json),
              try RoundtripJSON.string(body, "client_request_id") == id,
              try RoundtripJSON.date(request.createdAt) >= RoundtripJSON.date(createdAt),
              try RoundtripJSON.date(request.expiresAt) <= RoundtripJSON.date(expiresAt),
              try RoundtripJSON.date(RoundtripJSON.string(consent, "confirmed_at")) >= RoundtripJSON.date(createdAt) else { throw RealOptimizationError.noConsent }
        return try Self.command("diagnose_real_for_intent", endpointID: endpointID, sessionID: sessionID,
                                fields: ["intent_id": id, "intent_hash": hash, "client_request": request.envelope])
    }
    private static func command(_ operation: String, endpointID: String, sessionID: String, fields: [String: Any] = [:]) throws -> Data {
        try RoundtripJSON.uuid(endpointID); try RoundtripJSON.uuid(sessionID)
        var command = fields
        command["schema_version"] = 2; command["op"] = operation; command["expected_instance_id"] = endpointID; command["native_session_id"] = sessionID
        return Data(try RealJSON.encode(command).utf8)
    }
}

struct RealPlan: Equatable {
    let id: String
    let hash: String
    let serverID: String
    let serverHash: String
    let expiresAt: String
    let summary: String
    let decision: String
    let candidateID: String?
    var recommendsQuit: Bool { decision == "recommend_quit" }
    func manifest(candidate: RealCandidate?, request: RealDiagnosticRequest) -> String {
        RoundtripJSON.digest([hash, serverHash, request.hash, candidate?.id ?? "none", candidate?.identity.fingerprint ?? "none", "local_capabilities_v1:15:60"].joined(separator: "|"))
    }
    func permitsStart(at now: Date) -> Bool {
        guard let expiry = try? RoundtripJSON.date(expiresAt) else { return false }
        return expiry.timeIntervalSince(now) > 80
    }
    static func parse(_ bundle: [String: Any], pending: RealDiagnosticRequest, at now: Date) throws -> Self {
        try RoundtripJSON.keys(bundle, ["schema_version", "kind", "request_json", "request_hash", "proposal_json", "proposal_hash"])
        guard try RoundtripJSON.number(bundle, "schema_version") == 1, try RoundtripJSON.string(bundle, "kind") == "stats_real_result" else { throw RealOptimizationError.invalid }
        let requestJSON = try RoundtripJSON.string(bundle, "request_json", maximum: 14000), requestHash = try RoundtripJSON.string(bundle, "request_hash")
        let planJSON = try RoundtripJSON.string(bundle, "proposal_json", maximum: 4096), planHash = try RoundtripJSON.string(bundle, "proposal_hash")
        guard RoundtripJSON.digest(requestJSON) == requestHash, RoundtripJSON.digest(planJSON) == planHash else { throw RealOptimizationError.invalid }
        let request = try RoundtripJSON.object(requestJSON), plan = try RoundtripJSON.object(planJSON)
        try RoundtripJSON.keys(request, ["schema_version", "request_id", "stream_id", "synthetic", "created_at", "expires_at", "client_request"])
        try RealJSON.bool(request, "synthetic", false)
        guard try RoundtripJSON.number(request, "schema_version") == 2, try RoundtripJSON.string(request, "stream_id") == "global-device-v1",
              NSDictionary(dictionary: try RealJSON.object(request, "client_request")).isEqual(to: pending.envelope) else { throw RealOptimizationError.invalid }
        let serverID = try RoundtripJSON.string(request, "request_id"); try RoundtripJSON.uuid(serverID)
        let serverCreated = try RoundtripJSON.date(RoundtripJSON.string(request, "created_at")), serverExpiry = try RoundtripJSON.date(RoundtripJSON.string(request, "expires_at"))
        let localCreated = try RoundtripJSON.date(pending.createdAt), localExpiry = try RoundtripJSON.date(pending.expiresAt)
        guard serverCreated >= localCreated.addingTimeInterval(-120), serverCreated <= now.addingTimeInterval(120), serverExpiry <= localExpiry, serverExpiry > now, serverExpiry > serverCreated else { throw RealOptimizationError.expired }
        try RoundtripJSON.keys(plan, ["schema_version", "request_id", "request_hash", "plan_id", "expires_at", "dry_run", "requires_local_approval", "policy_id", "decision", "summary", "actions"])
        try RealJSON.bool(plan, "dry_run", false); try RealJSON.bool(plan, "requires_local_approval", true)
        guard try RoundtripJSON.number(plan, "schema_version") == 2, try RoundtripJSON.string(plan, "request_id") == serverID,
              try RoundtripJSON.string(plan, "request_hash") == requestHash, try RoundtripJSON.string(plan, "policy_id") == "local_capabilities_v1" else { throw RealOptimizationError.invalid }
        let id = try RoundtripJSON.string(plan, "plan_id"), expiry = try RoundtripJSON.string(plan, "expires_at"), decision = try RoundtripJSON.string(plan, "decision")
        try RoundtripJSON.uuid(id)
        guard let actions = plan["actions"] as? [[String: Any]], ["recommend_quit", "observe", "no_action"].contains(decision),
              try RoundtripJSON.date(expiry) > now, try RoundtripJSON.date(expiry) <= serverExpiry else { throw RealOptimizationError.expired }
        var candidateID: String?
        if decision == "recommend_quit" {
            guard actions.count == 1 else { throw RealOptimizationError.invalid }
            try RoundtripJSON.keys(actions[0], ["type", "candidate_id"])
            guard try RoundtripJSON.string(actions[0], "type") == "quit_app", pending.candidateIDs.contains(try RoundtripJSON.string(actions[0], "candidate_id")) else { throw RealOptimizationError.invalid }
        candidateID = try RoundtripJSON.string(actions[0], "candidate_id")
        } else if decision == "observe" {
            guard actions.count == 1 else { throw RealOptimizationError.invalid }
            try RoundtripJSON.keys(actions[0], ["type"])
            guard try RoundtripJSON.string(actions[0], "type") == "observe_metrics" else { throw RealOptimizationError.invalid }
        } else { guard actions.isEmpty else { throw RealOptimizationError.invalid } }
        let summary = try RoundtripJSON.string(plan, "summary", maximum: 2000)
        guard summary.unicodeScalars.count <= 1000 else { throw RealOptimizationError.invalid }
        return Self(id: id, hash: planHash, serverID: serverID, serverHash: requestHash, expiresAt: expiry,
                    summary: summary, decision: decision, candidateID: candidateID)
    }
}

struct RealSocketStatus {
    let status: String
    let serverID: String
    let serverHash: String
    let plan: RealPlan?
    let receipt: [String: Any]?
    static func command(_ operation: String, request: RealDiagnosticRequest, endpointID: String, receipt: [String: Any]? = nil, server: (String, String)? = nil) throws -> Data {
        guard ["diagnose_real", "result_real", "cancel_real", "receipt_real"].contains(operation), (operation == "receipt_real") == (receipt != nil) else { throw RealOptimizationError.invalid }
        try RoundtripJSON.uuid(endpointID)
        var command: [String: Any] = ["schema_version": 2, "op": operation, "expected_instance_id": endpointID, "client_request": request.envelope]
        if let receipt {
            guard let server else { throw RealOptimizationError.invalid }
            try RoundtripJSON.uuid(server.0); try RoundtripJSON.hash(server.1)
            command.removeValue(forKey: "client_request")
            command["client_request_id"] = request.id; command["client_request_hash"] = request.hash
            command["request_id"] = server.0; command["request_hash"] = server.1; command["receipt"] = receipt
        }
        return Data(try RealJSON.encode(command).utf8)
    }
    static func parse(_ bytes: Data, request: RealDiagnosticRequest, expected: (String, String)?, at now: Date) throws -> Self {
        let wrapper = try RoundtripJSON.object(bytes)
        if let error = wrapper["error"] as? String { throw RoundtripError.invalid("Real runtime: " + String(error.prefix(120))) }
        try RoundtripJSON.keys(wrapper, ["result"])
        let value = try RealJSON.object(wrapper, "result")
        try RoundtripJSON.keys(value, ["schema_version", "kind", "client_request_id", "client_request_hash", "request_id", "request_hash", "status", "bundle", "receipt"])
        let status = try RoundtripJSON.string(value, "status"), id = try RoundtripJSON.string(value, "request_id"), hash = try RoundtripJSON.string(value, "request_hash")
        try RoundtripJSON.uuid(id); try RoundtripJSON.hash(hash)
        guard try RoundtripJSON.number(value, "schema_version") == 1, try RoundtripJSON.string(value, "kind") == "stats_real_socket_status",
              try RoundtripJSON.string(value, "client_request_id") == request.id, try RoundtripJSON.string(value, "client_request_hash") == request.hash,
              ["requested", "proposed", "cancelled", "expired"].contains(status), expected == nil || (expected!.0 == id && expected!.1 == hash) else { throw RealOptimizationError.invalid }
        var plan: RealPlan?
        if status == "proposed" {
            plan = try RealPlan.parse(RealJSON.object(value, "bundle"), pending: request, at: now)
            guard plan?.serverID == id, plan?.serverHash == hash else { throw RealOptimizationError.invalid }
        } else { guard value["bundle"] is NSNull else { throw RealOptimizationError.invalid } }
        guard value["receipt"] is NSNull || value["receipt"] is [String: Any] else { throw RealOptimizationError.invalid }
        return Self(status: status, serverID: id, serverHash: hash, plan: plan, receipt: value["receipt"] as? [String: Any])
    }
}

struct RealLocalReceipt: Codable {
    let id: String
    let requestID: String
    let clientRequestHash: String
    var runtimeInstanceID: String?
    let planID: String
    let planHash: String
    let manifest: String
    let targetFingerprint: String
    let appName: String
    let startedAt: String
    var completedAt: String?
    var approvalAt: String?
    var outcome: String
    var quitRequested: Bool
    var dispatchAttempted = false
    var dispatchOutcomeKnown = false
    var exitConfirmed: Bool
    let before: RealHostSnapshot
    let beforeUsage: RealAppUsage?
    var after: RealHostSnapshot?
    var cloudReceiptJSON: String?
    var cloudReceiptHash: String?
    var cloudReceiptConfirmed = false
}

struct RealExecutionGate {
    enum Phase { case reviewing, approved, quitRequested, observing, finished, cancelled }
    private(set) var phase = Phase.reviewing
    let manifest: String
    mutating func approve(displayed: String, plan: RealPlan, candidate: RealCandidate?, fresh: RealAppUsage?, now: Date) throws {
        guard phase == .reviewing, manifest == displayed else { throw RealOptimizationError.invalid }
        guard plan.permitsStart(at: now) else { throw RealOptimizationError.expired }
        if plan.recommendsQuit {
            guard let candidate, let fresh, candidate.id == plan.candidateID, fresh.isFresh(at: now), fresh.isHigh else { throw RealOptimizationError.insufficient }
        } else { guard plan.decision == "observe" else { throw RealOptimizationError.invalid } }
        phase = .approved
    }
    mutating func takeQuitPermission() throws {
        guard phase == .approved else { throw RealOptimizationError.invalid }; phase = .quitRequested
    }
    mutating func observeOnly() throws { guard phase == .approved else { throw RealOptimizationError.invalid }; phase = .observing }
    mutating func didExit() throws {
        guard phase == .quitRequested else { throw RealOptimizationError.invalid }; phase = .observing
    }
    mutating func cancel() { phase = .cancelled }
    mutating func finish() { phase = .finished }
}
