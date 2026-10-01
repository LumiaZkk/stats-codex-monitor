// Explicit synthetic file roundtrip. No network, credentials, shell, or arbitrary actions.
import Foundation
import CryptoKit
import CoreFoundation

enum RoundtripError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

enum RoundtripJSON {
    static let maximumBytes = 16 * 1024
    static let clockSkew: TimeInterval = 120
    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func object(_ data: Data) throws -> [String: Any] {
        guard data.count <= maximumBytes else { throw RoundtripError.invalid("File exceeds 16 KiB") }
        var scanner = UniqueJSONScanner(bytes: Array(data))
        try scanner.scan()
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RoundtripError.invalid("Expected one JSON object")
        }
        return value
    }
    static func object(_ string: String) throws -> [String: Any] { try object(Data(string.utf8)) }
    static func keys(_ object: [String: Any], _ expected: [String]) throws {
        guard Set(object.keys) == Set(expected) else { throw RoundtripError.invalid("Unknown or missing JSON fields") }
    }
    static func string(_ object: [String: Any], _ key: String, maximum: Int = 1000) throws -> String {
        guard let value = object[key] as? String, value.utf16.count <= maximum else {
            throw RoundtripError.invalid("Invalid string field: \(key)")
        }
        return value
    }
    static func number(_ object: [String: Any], _ key: String) throws -> Double {
        guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
            throw RoundtripError.invalid("Invalid numeric field: \(key)")
        }
        return value.doubleValue
    }
    static func truth(_ object: [String: Any], _ key: String) throws {
        guard let value = object[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID(), value.boolValue else {
            throw RoundtripError.invalid("Expected true for \(key)")
        }
    }
    static func match(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    static func uuid(_ value: String) throws {
        guard match(value, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") else {
            throw RoundtripError.invalid("Expected lowercase UUID v4")
        }
    }
    static func hash(_ value: String) throws {
        guard match(value, "^[0-9a-f]{64}$") else { throw RoundtripError.invalid("Expected lowercase SHA-256") }
    }
    static func date(_ value: String) throws -> Date {
        guard match(value, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"),
              let date = formatter.date(from: value), formatter.string(from: date) == value else {
            throw RoundtripError.invalid("Invalid UTC millisecond timestamp")
        }
        return date
    }
    static var formatter: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }
    static func timestamp(_ date: Date) -> String { formatter.string(from: date) }
    static func canonicalASCII(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        guard let result = String(data: data, encoding: .utf8), result.utf8.allSatisfy({ $0 < 128 }) else {
            throw RoundtripError.invalid("Client envelope must be ASCII")
        }
        return result
    }
}

// Reject duplicate object keys before Foundation's decoder can silently collapse them.
// Foundation still validates scalar syntax, Unicode and escape correctness afterward.
private struct UniqueJSONScanner {
    let bytes: [UInt8]
    var index = 0
    var nodes = 0
    mutating func scan() throws {
        try value(depth: 0)
        whitespace()
        guard index == bytes.count else { throw RoundtripError.invalid("Trailing JSON data") }
    }
    mutating func whitespace() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
    mutating func value(depth: Int) throws {
        nodes += 1
        guard depth <= 12, nodes <= 500 else { throw RoundtripError.invalid("JSON nesting/field limit exceeded") }
        whitespace()
        guard index < bytes.count else { throw RoundtripError.invalid("Truncated JSON") }
        switch bytes[index] {
        case 123:
            index += 1; whitespace()
            if take(125) { return }
            var keys: Set<String> = []
            while true {
                whitespace()
                let key = try string()
                guard keys.insert(key).inserted else { throw RoundtripError.invalid("Duplicate JSON key") }
                whitespace(); guard take(58) else { throw RoundtripError.invalid("Invalid JSON object") }
                try value(depth: depth + 1); whitespace()
                if take(125) { return }
                guard take(44) else { throw RoundtripError.invalid("Invalid JSON object separator") }
            }
        case 91:
            index += 1; whitespace()
            if take(93) { return }
            while true {
                try value(depth: depth + 1); whitespace()
                if take(93) { return }
                guard take(44) else { throw RoundtripError.invalid("Invalid JSON array separator") }
            }
        case 34: _ = try string()
        default:
            let start = index
            while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
            guard index > start else { throw RoundtripError.invalid("Invalid JSON value") }
        }
    }
    mutating func take(_ byte: UInt8) -> Bool {
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1; return true
    }
    mutating func string() throws -> String {
        let start = index
        guard take(34) else { throw RoundtripError.invalid("Expected JSON string") }
        while index < bytes.count {
            if bytes[index] == 92 { index += 2; continue }
            if bytes[index] == 34 {
                index += 1
                return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index]))
            }
            index += 1
        }
        throw RoundtripError.invalid("Unterminated JSON string")
    }
}

struct SyntheticClientRequest: Codable, Equatable {
    let clientRequestID: String
    let createdAt: String
    let expiresAt: String
    let clientRequestHash: String
    var fields: [String: Any] {
        ["schema_version": 1, "kind": "stats_synthetic_request", "client_request_id": clientRequestID,
         "fixture": "high-cpu-v1", "created_at": createdAt, "expires_at": expiresAt]
    }
    func json() throws -> String {
        var value = fields
        value["client_request_hash"] = clientRequestHash
        return try RoundtripJSON.canonicalASCII(value)
    }
    static func create(at now: Date, id: String = UUID().uuidString.lowercased()) throws -> Self {
        try RoundtripJSON.uuid(id)
        let seed = Self(clientRequestID: id, createdAt: RoundtripJSON.timestamp(now),
                        expiresAt: RoundtripJSON.timestamp(now.addingTimeInterval(1800)), clientRequestHash: "")
        return Self(clientRequestID: id, createdAt: seed.createdAt, expiresAt: seed.expiresAt,
                    clientRequestHash: RoundtripJSON.digest(try RoundtripJSON.canonicalASCII(seed.fields)))
    }
    static func parse(_ object: [String: Any], at now: Date) throws -> Self {
        try RoundtripJSON.keys(object, ["schema_version", "kind", "client_request_id", "fixture", "created_at", "expires_at", "client_request_hash"])
        guard try RoundtripJSON.number(object, "schema_version") == 1,
              try RoundtripJSON.string(object, "kind") == "stats_synthetic_request",
              try RoundtripJSON.string(object, "fixture") == "high-cpu-v1" else { throw RoundtripError.invalid("Not a supported synthetic request") }
        let result = Self(clientRequestID: try RoundtripJSON.string(object, "client_request_id"),
                          createdAt: try RoundtripJSON.string(object, "created_at"), expiresAt: try RoundtripJSON.string(object, "expires_at"),
                          clientRequestHash: try RoundtripJSON.string(object, "client_request_hash"))
        try RoundtripJSON.uuid(result.clientRequestID); try RoundtripJSON.hash(result.clientRequestHash)
        let created = try RoundtripJSON.date(result.createdAt), expiry = try RoundtripJSON.date(result.expiresAt)
        guard created <= now.addingTimeInterval(RoundtripJSON.clockSkew), expiry > now, expiry > created, expiry.timeIntervalSince(created) <= 1800 else {
            throw RoundtripError.invalid("Client request expired or has invalid dates")
        }
        guard result.clientRequestHash == RoundtripJSON.digest(try RoundtripJSON.canonicalASCII(result.fields)) else {
            throw RoundtripError.invalid("Client request integrity mismatch")
        }
        return result
    }
}

enum LocalMetric: String, Codable, CaseIterable { case cpu = "cpu_utilization", memory = "memory_pressure", disk = "disk_free_gib" }
struct LocalTestAction: Codable, Equatable {
    enum Kind: String, Codable { case openActivityMonitor = "open_activity_monitor", observeMetrics = "observe_metrics" }
    let kind: Kind
    let metrics: [LocalMetric]
    let durationSeconds: Int
    var description: String {
        switch kind {
        case .openActivityMonitor: return "Open Apple's Activity Monitor on this Mac. No process is stopped or changed."
        case .observeMetrics: return "Observe existing local \(metrics.map { $0.rawValue }.joined(separator: ", ")) readings for \(durationSeconds) seconds. No additional collector starts."
        }
    }
    static func parse(_ object: [String: Any]) throws -> Self {
        let type = try RoundtripJSON.string(object, "type")
        try RoundtripJSON.truth(object, "dry_run")
        if type == Kind.openActivityMonitor.rawValue {
            try RoundtripJSON.keys(object, ["type", "target", "dry_run"])
            guard try RoundtripJSON.string(object, "target") == "current_device" else { throw RoundtripError.invalid("Invalid activity-monitor target") }
            return Self(kind: .openActivityMonitor, metrics: [], durationSeconds: 0)
        }
        guard type == Kind.observeMetrics.rawValue else { throw RoundtripError.invalid("Unsupported action; no execution permitted") }
        try RoundtripJSON.keys(object, ["type", "metrics", "duration_seconds", "dry_run"])
        guard let names = object["metrics"] as? [String], (1...3).contains(names.count), Set(names).count == names.count else { throw RoundtripError.invalid("Invalid or repeated metric") }
        let metrics = try names.map { name -> LocalMetric in
            guard let metric = LocalMetric(rawValue: name) else { throw RoundtripError.invalid("Unknown metric") }; return metric
        }
        let duration = try RoundtripJSON.number(object, "duration_seconds")
        guard duration.rounded() == duration, (60...120).contains(duration) else { throw RoundtripError.invalid("Observation must last 60–120 seconds") }
        return Self(kind: .observeMetrics, metrics: metrics, durationSeconds: Int(duration))
    }
}

struct VerifiedSyntheticProposal: Codable, Equatable {
    let clientRequestID: String
    let planID: String
    let proposalHash: String
    let requestHash: String
    let expiresAt: String
    let untrustedSummary: String
    let actions: [LocalTestAction]
    let manifestHash: String
    static func importFile(_ data: Data, pending: SyntheticClientRequest, at now: Date) throws -> Self {
        let wrapper = try RoundtripJSON.object(data)
        try RoundtripJSON.keys(wrapper, ["schema_version", "kind", "integrity", "client_request", "request_canonical_json", "request_hash", "status", "proposal_canonical_json", "proposal_hash", "exported_at"])
        guard try RoundtripJSON.number(wrapper, "schema_version") == 1,
              try RoundtripJSON.string(wrapper, "kind") == "stats_synthetic_result",
              try RoundtripJSON.string(wrapper, "integrity") == "unsigned_sha256",
              try RoundtripJSON.string(wrapper, "status") == "proposed",
              let clientObject = wrapper["client_request"] as? [String: Any] else { throw RoundtripError.invalid("Unsupported result envelope") }
        guard try SyntheticClientRequest.parse(clientObject, at: now) == pending else { throw RoundtripError.invalid("Result does not match this Mac's pending request") }
        let requestJSON = try RoundtripJSON.string(wrapper, "request_canonical_json", maximum: 8192)
        let proposalJSON = try RoundtripJSON.string(wrapper, "proposal_canonical_json", maximum: 8192)
        let requestHash = try RoundtripJSON.string(wrapper, "request_hash"), proposalHash = try RoundtripJSON.string(wrapper, "proposal_hash")
        try RoundtripJSON.hash(requestHash); try RoundtripJSON.hash(proposalHash)
        guard RoundtripJSON.digest(requestJSON) == requestHash, RoundtripJSON.digest(proposalJSON) == proposalHash else { throw RoundtripError.invalid("Request or proposal bytes changed: integrity check failed") }
        let request = try RoundtripJSON.object(requestJSON), proposal = try RoundtripJSON.object(proposalJSON)
        try RoundtripJSON.keys(request, ["schema_version", "request_id", "stream_id", "fixture", "synthetic", "snapshot", "created_at", "expires_at", "client_request"])
        guard try RoundtripJSON.number(request, "schema_version") == 1,
              try RoundtripJSON.string(request, "stream_id") == "synthetic-smoke-v1",
              try RoundtripJSON.string(request, "fixture") == "high-cpu-v1",
              let nestedClient = request["client_request"] as? [String: Any],
              let snapshot = request["snapshot"] as? [String: Any],
              try SyntheticClientRequest.parse(nestedClient, at: now) == pending else { throw RoundtripError.invalid("Unsupported server request") }
        try RoundtripJSON.truth(request, "synthetic")
        try RoundtripJSON.keys(snapshot, ["source", "cpu_utilization", "memory_pressure", "disk_free_gib"])
        guard try RoundtripJSON.string(snapshot, "source") == "synthetic", try RoundtripJSON.number(snapshot, "cpu_utilization") == 0.92,
              try RoundtripJSON.string(snapshot, "memory_pressure") == "normal", try RoundtripJSON.number(snapshot, "disk_free_gib") == 80 else { throw RoundtripError.invalid("Only the fixed synthetic fixture is accepted; no live telemetry") }
        let requestID = try RoundtripJSON.string(request, "request_id")
        try RoundtripJSON.uuid(requestID)
        let created = try RoundtripJSON.date(try RoundtripJSON.string(request, "created_at"))
        let requestExpiry = try RoundtripJSON.date(try RoundtripJSON.string(request, "expires_at"))
        let clientCreated = try RoundtripJSON.date(pending.createdAt), clientExpiry = try RoundtripJSON.date(pending.expiresAt)
        let exported = try RoundtripJSON.date(try RoundtripJSON.string(wrapper, "exported_at"))
        guard created >= clientCreated.addingTimeInterval(-RoundtripJSON.clockSkew), created <= now.addingTimeInterval(RoundtripJSON.clockSkew), requestExpiry > now,
              requestExpiry <= clientExpiry, exported >= created, exported <= now.addingTimeInterval(RoundtripJSON.clockSkew), exported < requestExpiry else { throw RoundtripError.invalid("Invalid request/export expiration") }
        try RoundtripJSON.keys(proposal, ["schema_version", "request_id", "request_hash", "plan_id", "expires_at", "dry_run", "summary", "actions"])
        try RoundtripJSON.truth(proposal, "dry_run")
        guard try RoundtripJSON.number(proposal, "schema_version") == 1, try RoundtripJSON.string(proposal, "request_id") == requestID,
              try RoundtripJSON.string(proposal, "request_hash") == requestHash, let actionObjects = proposal["actions"] as? [[String: Any]],
              (1...2).contains(actionObjects.count) else { throw RoundtripError.invalid("Invalid proposal binding/actions") }
        let planID = try RoundtripJSON.string(proposal, "plan_id"); try RoundtripJSON.uuid(planID)
        let expiresAt = try RoundtripJSON.string(proposal, "expires_at"), expiry = try RoundtripJSON.date(expiresAt)
        guard expiry > now, expiry <= requestExpiry, exported < expiry else { throw RoundtripError.invalid("Proposal expired or expiration exceeds request") }
        let actions = try actionObjects.map(LocalTestAction.parse)
        guard Set(actions.map { $0.kind.rawValue }).count == actions.count else { throw RoundtripError.invalid("Repeated action types are not allowed") }
        let summary = try RoundtripJSON.string(proposal, "summary")
        // Locally deterministic manifest, deliberately separate from cloud dry_run=true.
        let manifest = "local-test-v1\n\(pending.clientRequestID)\n\(proposalHash)\n\(expiresAt)\n" + actions.map { "\($0.kind.rawValue)|\($0.metrics.map { $0.rawValue }.joined(separator: ","))|\($0.durationSeconds)" }.joined(separator: "\n")
        return Self(clientRequestID: pending.clientRequestID, planID: planID, proposalHash: proposalHash, requestHash: requestHash,
                    expiresAt: expiresAt, untrustedSummary: summary, actions: actions, manifestHash: RoundtripJSON.digest(manifest))
    }
}

struct LocalMetricReading: Codable {
    enum Freshness: String, Codable { case fresh, stale, unavailable }
    let metric: LocalMetric
    let value: Double?
    let observedAt: String?
    let freshness: Freshness
}

struct LocalTestReceipt: Codable {
    let receiptID: String
    let clientRequestID: String
    let proposalHash: String
    let manifestHash: String
    let startedAt: String
    var finishedAt: String?
    let syntheticSuggestion = true
    let originAuthenticated = false
    let optimizationPerformed = false
    let measurementSource = "existing_local_stats_collectors"
    let requestFixture = "high-cpu-v1"
    var outcome: String
    var actionResults: [String]
    let before: [LocalMetricReading]
    var after: [LocalMetricReading]
    var observations: [[LocalMetricReading]]
}

struct LocalRoundtripState: Codable {
    enum Phase: String, Codable { case empty, waiting, reviewing, executing, completed, cancelled, interrupted }
    var schemaVersion = 1
    var installationScope = UUID().uuidString.lowercased()
    var phase: Phase = .empty
    var request: SyntheticClientRequest?
    var runtimeInstanceID: String?
    var proposal: VerifiedSyntheticProposal?
    var activeReceipt: LocalTestReceipt?
    var receipts: [LocalTestReceipt] = []

    mutating func create(at now: Date, id: String = UUID().uuidString.lowercased()) throws -> SyntheticClientRequest {
        guard phase != .executing else { throw RoundtripError.invalid("Finish or cancel the current local check first") }
        let next = try SyntheticClientRequest.create(at: now, id: id)
        request = next; runtimeInstanceID = nil; proposal = nil; activeReceipt = nil; phase = .waiting
        prune(at: now)
        return next
    }
    mutating func bindRuntime(_ instanceID: String) throws {
        try RoundtripJSON.uuid(instanceID)
        guard phase == .waiting, request != nil, runtimeInstanceID == nil || runtimeInstanceID == instanceID else {
            throw RoundtripError.invalid("This request is already bound to another runtime; cancel before starting a new request")
        }
        runtimeInstanceID = instanceID
    }
    mutating func receive(_ data: Data, at now: Date) throws -> VerifiedSyntheticProposal {
        guard phase == .waiting, let request else {
            throw RoundtripError.invalid("No matching pending request: cancelled, already imported, or replayed result")
        }
        let result = try VerifiedSyntheticProposal.importFile(data, pending: request, at: now)
        proposal = result; phase = .reviewing
        return result
    }
    mutating func authorize(manifestHash: String, before: [LocalMetricReading], at now: Date) throws -> VerifiedSyntheticProposal {
        guard phase == .reviewing, let request, let proposal, proposal.manifestHash == manifestHash,
              proposal.clientRequestID == request.clientRequestID else { throw RoundtripError.invalid("The reviewed local manifest is no longer current") }
        guard try RoundtripJSON.date(proposal.expiresAt) > now, try RoundtripJSON.date(request.expiresAt) > now,
              try RoundtripJSON.date(request.createdAt) <= now else { throw RoundtripError.invalid("Request expired or system clock changed; create a new synthetic request") }
        phase = .executing
        activeReceipt = LocalTestReceipt(receiptID: UUID().uuidString.lowercased(), clientRequestID: request.clientRequestID,
                                        proposalHash: proposal.proposalHash, manifestHash: manifestHash,
                                        startedAt: RoundtripJSON.timestamp(now), outcome: "started", actionResults: [],
                                        before: before, after: [], observations: [])
        return proposal
    }
    func mayContinueExecution(at now: Date) -> Bool {
        guard phase == .executing, let proposal, let request,
              let expiry = try? RoundtripJSON.date(proposal.expiresAt),
              let created = try? RoundtripJSON.date(request.createdAt) else { return false }
        return now < expiry && now >= created
    }
    mutating func finish(outcome: String, after: [LocalMetricReading], at now: Date) throws {
        guard phase == .executing, var receipt = activeReceipt else { throw RoundtripError.invalid("No running local check") }
        receipt.finishedAt = RoundtripJSON.timestamp(now); receipt.outcome = outcome; receipt.after = after
        receipts.append(receipt); activeReceipt = nil
        phase = outcome == "cancelled" ? .cancelled : .completed
        prune(at: now)
    }
    mutating func cancel(at now: Date) throws {
        if phase == .executing { try finish(outcome: "cancelled", after: [], at: now) }
        else { phase = .cancelled; proposal = nil }
    }
    mutating func recoverAfterRestart(at now: Date) {
        // Never resume action execution or trust a saved approval after restart.
        if phase == .executing, var receipt = activeReceipt {
            receipt.finishedAt = RoundtripJSON.timestamp(now)
            receipt.outcome = "interrupted_by_app_restart"
            receipts.append(receipt); activeReceipt = nil; phase = .interrupted
        } else if phase == .reviewing { phase = .cancelled; proposal = nil }
        prune(at: now)
    }
    mutating func prune(at now: Date) {
        receipts = Array(receipts.filter { receipt in
            guard let date = try? RoundtripJSON.date(receipt.startedAt) else { return false }
            return date <= now && now.timeIntervalSince(date) <= 7 * 86400
        }.suffix(20))
    }
}

final class LocalRoundtripStorage {
    let url: URL
    init(directory: URL) { url = directory.appendingPathComponent("synthetic-roundtrip-v1.json") }
    func load(at now: Date) throws -> LocalRoundtripState {
        guard FileManager.default.fileExists(atPath: url.path) else { return LocalRoundtripState() }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 256 * 1024 else { throw RoundtripError.invalid("Local roundtrip state exceeds its safety limit") }
        var state = try JSONDecoder().decode(LocalRoundtripState.self, from: Data(contentsOf: url))
        guard state.schemaVersion == 1 else { throw RoundtripError.invalid("Unsupported local state version") }
        state.recoverAfterRestart(at: now)
        return state
    }
    func save(_ state: LocalRoundtripState) throws {
        let directory = url.deletingLastPathComponent(), manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try JSONEncoder().encode(state)
        guard data.count <= 256 * 1024 else { throw RoundtripError.invalid("Local receipt storage reached its safety limit") }
        try data.write(to: url, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
