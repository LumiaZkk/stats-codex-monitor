// Owner-private bounded receipts. Restarts never restore pending requests or approvals.
import Foundation
import Darwin

final class RealReceiptStorage {
    let directory: URL
    private let name = "real-optimization-receipts-v1.json"
    init(directory: URL) { self.directory = directory }
    private func openDirectory() throws -> Int32 {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var info = stat()
        guard fd >= 0 else { throw RealOptimizationError.storage }
        guard fstat(fd, &info) == 0, info.st_uid == geteuid(), (info.st_mode & 0o777) == 0o700 else { Darwin.close(fd); throw RealOptimizationError.storage }
        return fd
    }
    func load(at now: Date) throws -> [RealLocalReceipt] {
        let directory = try openDirectory(); defer { Darwin.close(directory) }
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return [] }
        guard fd >= 0 else { throw RealOptimizationError.storage }; defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o777) == 0o600,
              info.st_uid == geteuid(), info.st_nlink == 1, info.st_size <= 256 * 1024 else { throw RealOptimizationError.storage }
        var buffer = [UInt8](repeating: 0, count: 256 * 1024 + 1), count = 0
        while count < buffer.count {
            let n = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: count), $0.count - count) }
            if n == 0 { break }; if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw RealOptimizationError.storage }; count += n
        }
        guard count <= 256 * 1024 else { throw RealOptimizationError.storage }
        var receipts = try JSONDecoder().decode([RealLocalReceipt].self, from: Data(buffer.prefix(count)))
        for index in receipts.indices where receipts[index].completedAt == nil {
            receipts[index].completedAt = RoundtripJSON.timestamp(now)
            receipts[index].outcome = "interrupted_by_restart"
        }
        receipts = Self.pruned(receipts, at: now)
        return receipts
    }
    static func pruned(_ receipts: [RealLocalReceipt], at now: Date) -> [RealLocalReceipt] {
        Array(receipts.filter { value in
            guard let date = try? RoundtripJSON.date(value.startedAt) else { return false }
            return (0...(7 * 86400)).contains(now.timeIntervalSince(date))
        }.suffix(20))
    }
    func save(_ receipts: [RealLocalReceipt]) throws {
        let data = try JSONEncoder().encode(receipts)
        guard data.count <= 256 * 1024, receipts.count <= 20 else { throw RealOptimizationError.storage }
        let directory = try openDirectory(); defer { Darwin.close(directory) }
        let temporary = ".real-receipt-" + UUID().uuidString.lowercased()
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw RealOptimizationError.storage }
        defer { Darwin.close(fd); unlinkat(directory, temporary, 0) }
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), $0.count - offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw RealOptimizationError.storage }; offset += n
        }
        guard fsync(fd) == 0, renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else { throw RealOptimizationError.storage }
    }
}
