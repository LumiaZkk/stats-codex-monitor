// Versioned synthetic-only local IPC contract. The result still requires local approval.
import Foundation

enum SyntheticSocketOperation: String { case diagnose = "diagnose_native", result = "result_native", cancel = "cancel_native" }
struct SyntheticSocketBinding: Equatable { let requestID: String; let requestHash: String }
struct SyntheticSocketResponse {
    enum Status: String { case requested, proposed, cancelled, expired }
    let status: Status
    let binding: SyntheticSocketBinding
    let bundle: Data?
}
enum SyntheticSocketProtocol {
    static func command(_ operation: SyntheticSocketOperation, request: SyntheticClientRequest, at now: Date) throws -> Data {
        let client = try RoundtripJSON.object(request.json())
        // A terminal request may still be cancelled, but it can never be resubmitted after expiry.
        _ = try SyntheticClientRequest.parse(client, at: operation == .cancel ? RoundtripJSON.date(request.createdAt) : now)
        return try JSONSerialization.data(withJSONObject: ["schema_version": 1, "op": operation.rawValue, "client_request": client], options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func response(_ data: Data, request: SyntheticClientRequest, at now: Date,
                         expected: SyntheticSocketBinding? = nil, allowExpired: Bool = false) throws -> SyntheticSocketResponse {
        let envelope = try RoundtripJSON.object(data)
        if Set(envelope.keys) == ["error"] {
            // Never show arbitrary server text, paths, URLs or purported instructions.
            _ = try RoundtripJSON.string(envelope, "error", maximum: 80)
            throw RoundtripError.invalid("The local runtime rejected the request. Check that the current native-socket protocol is running; no local action is authorized.")
        }
        try RoundtripJSON.keys(envelope, ["result"])
        guard let value = envelope["result"] as? [String: Any] else { throw SyntheticSocketError.invalidResponse }
        try RoundtripJSON.keys(value, ["schema_version", "kind", "client_request_id", "client_request_hash", "request_id", "request_hash", "status", "bundle"])
        guard try RoundtripJSON.number(value, "schema_version") == 1,
              try RoundtripJSON.string(value, "kind") == "stats_native_socket_status",
              try RoundtripJSON.string(value, "client_request_id") == request.clientRequestID,
              try RoundtripJSON.string(value, "client_request_hash") == request.clientRequestHash,
              let status = SyntheticSocketResponse.Status(rawValue: try RoundtripJSON.string(value, "status")) else { throw SyntheticSocketError.invalidResponse }
        let binding = SyntheticSocketBinding(requestID: try RoundtripJSON.string(value, "request_id"), requestHash: try RoundtripJSON.string(value, "request_hash"))
        try RoundtripJSON.uuid(binding.requestID); try RoundtripJSON.hash(binding.requestHash)
        guard expected == nil || expected == binding else { throw RoundtripError.invalid("The runtime changed this pending request's identity or hash") }
        if !allowExpired, status != .expired, status != .cancelled {
            _ = try SyntheticClientRequest.parse(RoundtripJSON.object(request.json()), at: now)
        }
        var bytes: Data?
        if status == .proposed {
            guard !allowExpired, let bundle = value["bundle"] as? [String: Any] else { throw SyntheticSocketError.invalidResponse }
            let data = try JSONSerialization.data(withJSONObject: bundle, options: [.sortedKeys, .withoutEscapingSlashes])
            let verified = try VerifiedSyntheticProposal.importFile(data, pending: request, at: now)
            let server = try RoundtripJSON.object(RoundtripJSON.string(bundle, "request_canonical_json", maximum: 8192))
            guard verified.requestHash == binding.requestHash, try RoundtripJSON.string(server, "request_id") == binding.requestID else { throw SyntheticSocketError.invalidResponse }
            bytes = data
        } else {
            guard value["bundle"] is NSNull else { throw SyntheticSocketError.invalidResponse }
        }
        return SyntheticSocketResponse(status: status, binding: binding, bundle: bytes)
    }
}
