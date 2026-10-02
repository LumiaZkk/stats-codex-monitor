// Bounded, owner-only Unix IPC. No IP sockets, credentials, subprocesses or retries.
import Foundation
import Darwin

enum SyntheticSocketError: Error, LocalizedError {
    case unavailable, notListening, unsafeEndpoint, timeout, invalidResponse, cancelled
    var errorDescription: String? {
        switch self {
        case .cancelled: return DiagnosticText.text("Local request cancelled. A request already sent to the runtime may still need remote cancellation.", "本地请求已取消。已经发往运行端的请求，仍可能需要运行端确认取消。")
        case .unavailable, .notListening: return DiagnosticText.text("The temporary local runtime is unavailable. Start the updated foreground runtime, keep its Terminal open, and retry automatic discovery.", "本机运行端暂不可用。请启动更新后的前台运行端，保持终端会话运行，然后重试。")
        case .unsafeEndpoint: return DiagnosticText.text("The runtime folder/socket must be owned by this user with permissions 0700/0600 and a same-user peer. No data was sent.", "本机连接的归属、权限或进程身份未通过安全校验。请使用已批准的运行端重新建立连接；此次未发送数据。")
        case .timeout: return DiagnosticText.text("The local runtime did not finish within 5 seconds. Submission may have reached it. Retry reuses the same request; Cancel blocks local actions.", "运行端未在 5 秒内回应。请求可能已送达；重试会复用本次请求，取消则会阻止本地操作。")
        case .invalidResponse: return DiagnosticText.text("The local runtime returned an invalid or oversized response. No local action is authorized.", "运行端返回的数据无效或过大，未授权任何本地操作。")
        }
    }
}

final class SyntheticSocketCancellation {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw SyntheticSocketError.cancelled }
    }
}

struct SyntheticSocketPeer {
    let pid: pid_t
    let device: dev_t
    let inode: ino_t
}

struct SyntheticSocketTransport {
    static let maximumBytes = 16 * 1024
    let directory: URL
    private func attributes(_ path: String, type: mode_t, permissions: mode_t) throws -> stat {
        var info = stat()
        guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == type,
              info.st_uid == geteuid(), (info.st_mode & 0o777) == permissions else {
            throw SyntheticSocketError.unsafeEndpoint
        }
        return info
    }
    func validateEndpoint() throws {
        guard directory.isFileURL else { throw SyntheticSocketError.unsafeEndpoint }
        _ = try attributes(directory.path, type: S_IFDIR, permissions: 0o700)
        _ = try attributes(directory.appendingPathComponent("native.sock").path, type: S_IFSOCK, permissions: 0o600)
    }
    func peerExpectation(pid: pid_t) throws -> SyntheticSocketPeer {
        try validateEndpoint()
        let info = try attributes(directory.appendingPathComponent("native.sock").path, type: S_IFSOCK, permissions: 0o600)
        return SyntheticSocketPeer(pid: pid, device: info.st_dev, inode: info.st_ino)
    }
    func exchange(_ request: Data, cancellation: SyntheticSocketCancellation? = nil, peer: SyntheticSocketPeer? = nil,
                  deadline suppliedDeadline: TimeInterval? = nil, beforeSend: (() throws -> Void)? = nil) throws -> Data {
        try cancellation?.check()
        guard !request.isEmpty, request.count < Self.maximumBytes, !request.contains(10) else { throw SyntheticSocketError.invalidResponse }
        try validateEndpoint()
        let path = directory.appendingPathComponent("native.sock").path
        let initial = try attributes(path, type: S_IFSOCK, permissions: 0o600)
        if let peer { guard peer.device == initial.st_dev, peer.inode == initial.st_ino else { throw SyntheticSocketError.unsafeEndpoint } }
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path), !bytes.contains(0) else { throw SyntheticSocketError.unsafeEndpoint }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes + [0]) }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SyntheticSocketError.unavailable }
        defer { Darwin.close(fd) }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0, fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw SyntheticSocketError.unavailable }
        var enabled: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw SyntheticSocketError.unavailable }
        let deadline = min(suppliedDeadline ?? .greatestFiniteMagnitude, ProcessInfo.processInfo.systemUptime + 5)
        try cancellation?.check()
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if connected != 0 {
            if errno == ECONNREFUSED || errno == ENOENT { throw SyntheticSocketError.notListening }
            guard errno == EINPROGRESS else { throw SyntheticSocketError.unavailable }
            try wait(fd, event: Int16(POLLOUT), until: deadline, cancellation: cancellation)
            var error: Int32 = 0, size = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 else { throw SyntheticSocketError.unavailable }
            if error == ECONNREFUSED || error == ENOENT { throw SyntheticSocketError.notListening }
            guard error == 0 else { throw SyntheticSocketError.unavailable }
        }
        var peerUID: uid_t = 0, peerGID: gid_t = 0
        guard getpeereid(fd, &peerUID, &peerGID) == 0, peerUID == geteuid() else { throw SyntheticSocketError.unsafeEndpoint }
        if let peer {
            var pid: pid_t = 0, size = socklen_t(MemoryLayout<pid_t>.size)
            guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, size == socklen_t(MemoryLayout<pid_t>.size), pid == peer.pid else {
                throw SyntheticSocketError.unsafeEndpoint
            }
        }
        try validateEndpoint()
        let current = try attributes(path, type: S_IFSOCK, permissions: 0o600)
        guard initial.st_dev == current.st_dev, initial.st_ino == current.st_ino else { throw SyntheticSocketError.unsafeEndpoint }
        try cancellation?.check()
        try beforeSend?()
        let payload = Array(request) + [10]
        var sent = 0
        while sent < payload.count {
            try wait(fd, event: Int16(POLLOUT), until: deadline, cancellation: cancellation)
            let count = payload.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: sent), payload.count - sent) }
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw SyntheticSocketError.unavailable }; sent += count
        }
        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            try wait(fd, event: Int16(POLLIN), until: deadline, cancellation: cancellation)
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count >= 0 else { throw SyntheticSocketError.unavailable }
            if count == 0 { break }
            response.append(contentsOf: buffer.prefix(count))
            guard response.count <= Self.maximumBytes else { throw SyntheticSocketError.invalidResponse }
        }
        // Exactly one newline-terminated frame, with EOF; never accept trailing frames.
        guard response.last == 10, response.dropLast().contains(10) == false, response.count > 1 else { throw SyntheticSocketError.invalidResponse }
        response.removeLast()
        return response
    }
    private func wait(_ fd: Int32, event: Int16, until deadline: TimeInterval, cancellation: SyntheticSocketCancellation?) throws {
        while true {
            try cancellation?.check()
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw SyntheticSocketError.timeout }
            var item = pollfd(fd: fd, events: event, revents: 0)
            let result = poll(&item, 1, Int32(ceil(min(remaining, 0.25) * 1000)))
            if result < 0 && errno == EINTR { continue }
            if result == 0 { continue }
            guard result > 0 else { throw SyntheticSocketError.unavailable }
            guard item.revents & Int16(POLLNVAL) == 0 else { throw SyntheticSocketError.unavailable }
            if item.revents & (event | Int16(POLLHUP) | Int16(POLLERR)) != 0 { return }
        }
    }
}
