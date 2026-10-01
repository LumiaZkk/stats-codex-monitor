// Reads only the dedicated per-user rendezvous directory. Never writes credentials or starts a service.
import Foundation
import Darwin

enum RuntimeDiscoveryError: Error, LocalizedError {
    case unsafeRegistry, invalidDescriptor, tooManyEntries, changed, noRuntime, originalRuntimeGone, incomplete
    var errorDescription: String? {
        switch self {
        case .incomplete: return "Some runtime identities could not be verified. No runtime was selected. Retry, or stop unused foreground runtimes, before sending."
        case .unsafeRegistry: return "The local runtime registry could not be verified safely. Start the updated foreground runtime; no request was sent."
        case .invalidDescriptor: return "The local runtime descriptor is invalid, expired or incompatible."
        case .tooManyEntries: return "Too many runtime entries were found. Stop unused foreground runtimes before retrying."
        case .changed: return "The runtime changed or stopped. No automatic switch to another runtime is allowed for this request."
        case .noRuntime: return "No compatible live runtime was found. Start the updated foreground Tunnel runtime and enter its temporary key directly in Terminal, then click Send again. This app never reads the key or launches a service."
        case .originalRuntimeGone: return "This pending request belongs to a runtime that is no longer available. Cancel it before starting a new diagnosis; it will not be resent to another runtime."
        }
    }
}

struct SyntheticRuntimeDescriptor: Equatable {
    let instanceID: String
    let uid: uid_t
    let pid: pid_t
    let startedAt: String
    let expiresAt: String
    let scopeHash: String
    let socketPath: String
    static let keys = ["schema_version", "kind", "instance_id", "protocol_version", "uid", "runtime_pid", "started_at", "expires_at", "scope_hash", "socket_path"]
    static func parse(_ bytes: Data, at now: Date, owner: uid_t = geteuid()) throws -> Self {
        guard bytes.count <= 4096 else { throw RuntimeDiscoveryError.invalidDescriptor }
        let value = try RoundtripJSON.object(bytes)
        try RoundtripJSON.keys(value, keys)
        guard try RoundtripJSON.number(value, "schema_version") == 1,
              try RoundtripJSON.string(value, "kind") == "stats_runtime_descriptor",
              try RoundtripJSON.number(value, "protocol_version") == 2 else { throw RuntimeDiscoveryError.invalidDescriptor }
        let id = try RoundtripJSON.string(value, "instance_id"), scope = try RoundtripJSON.string(value, "scope_hash")
        try RoundtripJSON.uuid(id); try RoundtripJSON.hash(scope)
        let uid = try RoundtripJSON.number(value, "uid"), pid = try RoundtripJSON.number(value, "runtime_pid")
        guard uid == Double(owner), pid.rounded() == pid, (1...Double(Int32.max)).contains(pid) else { throw RuntimeDiscoveryError.invalidDescriptor }
        let started = try RoundtripJSON.string(value, "started_at"), expires = try RoundtripJSON.string(value, "expires_at")
        let start = try RoundtripJSON.date(started), end = try RoundtripJSON.date(expires)
        guard start <= now.addingTimeInterval(RoundtripJSON.clockSkew), end > now, end > start,
              end.timeIntervalSince(start) <= 3600 else { throw RuntimeDiscoveryError.invalidDescriptor }
        let path = try RoundtripJSON.string(value, "socket_path", maximum: 103)
        let url = URL(fileURLWithPath: path)
        guard path.hasPrefix("/"), path.utf8.count <= 103, !path.utf8.contains(0),
              path == url.standardizedFileURL.path, url.lastPathComponent == "native.sock" else { throw RuntimeDiscoveryError.invalidDescriptor }
        return Self(instanceID: id, uid: uid_t(uid), pid: pid_t(pid), startedAt: started, expiresAt: expires, scopeHash: scope, socketPath: path)
    }
    func hello(nonce: String) throws -> Data {
        try RoundtripJSON.uuid(nonce)
        return try JSONSerialization.data(withJSONObject: ["schema_version": 2, "op": "hello_native", "expected_instance_id": instanceID, "nonce": nonce], options: [.sortedKeys])
    }
    func verifyHello(_ bytes: Data, nonce: String) throws {
        let envelope = try RoundtripJSON.object(bytes)
        try RoundtripJSON.keys(envelope, ["result"])
        guard let value = envelope["result"] as? [String: Any] else { throw RuntimeDiscoveryError.changed }
        try RoundtripJSON.keys(value, ["schema_version", "kind", "instance_id", "protocol_version", "uid", "runtime_pid", "started_at", "expires_at", "scope_hash", "nonce"])
        guard try RoundtripJSON.number(value, "schema_version") == 2,
              try RoundtripJSON.string(value, "kind") == "stats_runtime_hello",
              try RoundtripJSON.string(value, "instance_id") == instanceID,
              try RoundtripJSON.number(value, "protocol_version") == 2,
              try RoundtripJSON.number(value, "uid") == Double(uid),
              try RoundtripJSON.number(value, "runtime_pid") == Double(pid),
              try RoundtripJSON.string(value, "started_at") == startedAt,
              try RoundtripJSON.string(value, "expires_at") == expiresAt,
              try RoundtripJSON.string(value, "scope_hash") == scopeHash,
              try RoundtripJSON.string(value, "nonce") == nonce else { throw RuntimeDiscoveryError.changed }
    }
}

struct RuntimeFileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t
    init(_ info: stat) { device = info.st_dev; inode = info.st_ino }
}

struct SyntheticRuntimeEndpoint {
    let descriptor: SyntheticRuntimeDescriptor
    let registry: URL
    let registryIdentity: RuntimeFileIdentity
    let fileIdentity: RuntimeFileIdentity
    let bytes: Data
    let peer: SyntheticSocketPeer
    var label: String {
        let name = URL(fileURLWithPath: descriptor.socketPath).deletingLastPathComponent().lastPathComponent
            .unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? "_" : String($0) }.joined()
        return "\(name.prefix(48)) · \(descriptor.startedAt) · scope \(descriptor.scopeHash.prefix(8)) · \(descriptor.instanceID.prefix(8))"
    }
    var transport: SyntheticSocketTransport { SyntheticSocketTransport(directory: URL(fileURLWithPath: descriptor.socketPath).deletingLastPathComponent()) }
    func validateCurrent() throws {
        let read = try SyntheticRuntimeDiscovery.read(registry: registry, name: descriptor.instanceID + ".json")
        guard read.registry == registryIdentity, read.file == fileIdentity, read.bytes == bytes,
              try SyntheticRuntimeDescriptor.parse(read.bytes, at: Date()) == descriptor else { throw RuntimeDiscoveryError.changed }
    }
    func exchange(_ operation: SyntheticSocketOperation, request: SyntheticClientRequest, cancellation: SyntheticSocketCancellation? = nil) throws -> Data {
        try validateCurrent()
        let command = try SyntheticSocketProtocol.command(operation, request: request, at: Date(), expectedInstanceID: descriptor.instanceID)
        return try transport.exchange(command, cancellation: cancellation, peer: peer, beforeSend: validateCurrent)
    }
    func verifyLive(until deadline: TimeInterval, cancellation: SyntheticSocketCancellation) throws {
        try validateCurrent()
        let nonce = UUID().uuidString.lowercased()
        let reply = try transport.exchange(descriptor.hello(nonce: nonce), cancellation: cancellation, peer: peer, deadline: deadline, beforeSend: validateCurrent)
        try descriptor.verifyHello(reply, nonce: nonce)
        try validateCurrent()
    }
}

final class RuntimeDiscoveryResults {
    private let lock = NSLock()
    private var values: [SyntheticRuntimeEndpoint] = []
    private var incomplete = false
    func append(_ value: SyntheticRuntimeEndpoint) { lock.lock(); values.append(value); lock.unlock() }
    func failed() { lock.lock(); incomplete = true; lock.unlock() }
    func isIncomplete() -> Bool { lock.lock(); defer { lock.unlock() }; return incomplete }
    func snapshot() -> [SyntheticRuntimeEndpoint] { lock.lock(); defer { lock.unlock() }; return values }
}

enum SyntheticRuntimeDiscovery {
    static var registry: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("stats-codex-monitor", isDirectory: true).appendingPathComponent("runtime-v1", isDirectory: true)
    }
    static func privateDirectory(_ url: URL) throws -> (Int32, RuntimeFileIdentity) {
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw RuntimeDiscoveryError.unsafeRegistry }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o777) == 0o700 else {
            Darwin.close(fd); throw RuntimeDiscoveryError.unsafeRegistry
        }
        return (fd, RuntimeFileIdentity(info))
    }
    static func openRegistry(_ url: URL) throws -> (Int32, RuntimeFileIdentity) {
        // Both dedicated directory components are private; no scanning of temp/home trees.
        let (parent, _) = try privateDirectory(url.deletingLastPathComponent()); defer { Darwin.close(parent) }
        let fd = openat(parent, url.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw RuntimeDiscoveryError.unsafeRegistry }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o777) == 0o700 else {
            Darwin.close(fd); throw RuntimeDiscoveryError.unsafeRegistry
        }
        return (fd, RuntimeFileIdentity(info))
    }
    static func read(registry: URL, name: String) throws -> (registry: RuntimeFileIdentity, file: RuntimeFileIdentity, bytes: Data) {
        guard RoundtripJSON.match(name, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$") else { throw RuntimeDiscoveryError.invalidDescriptor }
        let (directory, identity) = try openRegistry(registry); defer { Darwin.close(directory) }
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw RuntimeDiscoveryError.invalidDescriptor }; defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == geteuid(),
              (info.st_mode & 0o777) == 0o600, info.st_nlink == 1, info.st_size > 0, info.st_size <= 4096 else { throw RuntimeDiscoveryError.invalidDescriptor }
        var buffer = [UInt8](repeating: 0, count: 4097), count = 0
        while count < buffer.count {
            let available = buffer.count - count
            let received = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: count), available) }
            if received == 0 { break }
            if received < 0 && errno == EINTR { continue }
            guard received > 0 else { throw RuntimeDiscoveryError.invalidDescriptor }; count += received
        }
        var after = stat(), path = stat()
        guard count <= 4096, fstat(fd, &after) == 0, fstatat(directory, name, &path, AT_SYMLINK_NOFOLLOW) == 0,
              RuntimeFileIdentity(info) == RuntimeFileIdentity(after), RuntimeFileIdentity(info) == RuntimeFileIdentity(path),
              info.st_size == after.st_size, info.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              info.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw RuntimeDiscoveryError.changed }
        return (identity, RuntimeFileIdentity(info), Data(buffer.prefix(count)))
    }
    static func candidates(in registry: URL, at now: Date = Date()) throws -> [SyntheticRuntimeEndpoint] {
        if !FileManager.default.fileExists(atPath: registry.path) { return [] }
        let (fd, identity) = try openRegistry(registry)
        guard let directory = fdopendir(fd) else { Darwin.close(fd); throw RuntimeDiscoveryError.unsafeRegistry }
        defer { closedir(directory) }
        var names: [String] = [], seen = 0
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
            if name == "." || name == ".." { continue }
            seen += 1; guard seen <= 32 else { throw RuntimeDiscoveryError.tooManyEntries }
            if name.hasSuffix(".json") { names.append(name) }
            guard names.count <= 8 else { throw RuntimeDiscoveryError.tooManyEntries }
        }
        var result: [SyntheticRuntimeEndpoint] = []
        for name in names.sorted() {
            do {
                let value = try read(registry: registry, name: name)
                let descriptor = try SyntheticRuntimeDescriptor.parse(value.bytes, at: now)
                guard name == descriptor.instanceID + ".json", identity == value.registry else { continue }
                let transport = SyntheticSocketTransport(directory: URL(fileURLWithPath: descriptor.socketPath).deletingLastPathComponent())
                let peer = try transport.peerExpectation(pid: descriptor.pid)
                result.append(SyntheticRuntimeEndpoint(descriptor: descriptor, registry: registry, registryIdentity: identity, fileIdentity: value.file, bytes: value.bytes, peer: peer))
            } catch { continue } // Stale/invalid entries cannot select a runtime.
        }
        return result
    }
    static func find(in registry: URL = SyntheticRuntimeDiscovery.registry, cancellation: SyntheticSocketCancellation) throws -> [SyntheticRuntimeEndpoint] {
        try cancellation.check()
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        let candidates = try candidates(in: registry)
        let group = DispatchGroup(), results = RuntimeDiscoveryResults()
        for candidate in candidates {
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { group.leave() }
                do { try candidate.verifyLive(until: deadline, cancellation: cancellation); results.append(candidate) }
                catch SyntheticSocketError.notListening { } // Definitively dead socket, not an unresolved live identity.
                catch { results.failed() }
            }
        }
        group.wait() // At most8 bounded local exchanges share the same five-second deadline.
        try cancellation.check()
        guard !results.isIncomplete() else { throw RuntimeDiscoveryError.incomplete }
        return results.snapshot().sorted { $0.descriptor.instanceID < $1.descriptor.instanceID }
    }
}
