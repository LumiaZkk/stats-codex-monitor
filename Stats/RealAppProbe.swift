// Read-only identity and two-point usage measurement for a user-selected GUI app.
import Cocoa
import Darwin
import Security

struct RealAppIdentity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let bundleID: String
    let bundlePath: String
    let executablePath: String
    let codeHash: String
    let teamID: String
    let displayName: String
    var fingerprint: String {
        let values = [String(pid), String(uid), String(startedSeconds), String(startedMicroseconds), bundleID, bundlePath, executablePath, codeHash, teamID]
        return RoundtripJSON.digest(values.map { "\($0.utf8.count):\($0)" }.joined())
    }
}

struct RealAppUsage: Codable, Equatable {
    let cpuBasisPoints: Int
    let residentBytes: UInt64
    let intervalMS: Int
    let observedAt: String
    var isHigh: Bool { cpuBasisPoints >= 2500 || residentBytes >= 512 * 1024 * 1024 }
    func isFresh(at now: Date) -> Bool {
        guard let date = try? RoundtripJSON.date(observedAt) else { return false }
        return (0...5).contains(now.timeIntervalSince(date)) && (1500...5000).contains(intervalMS)
    }
}

struct RealAppCounter {
    let user: UInt64
    let system: UInt64
    let resident: UInt64
    let uptime: TimeInterval
    let date: Date
    static func usage(_ before: Self, _ after: Self, maximumCores: Int) throws -> RealAppUsage {
        let elapsed = after.uptime - before.uptime
        guard (1.5...5).contains(elapsed), abs(after.date.timeIntervalSince(before.date) - elapsed) <= 0.5,
              after.user >= before.user, after.system >= before.system else { throw RealOptimizationError.changed }
        let nanos = Double(after.user - before.user) + Double(after.system - before.system)
        let bp = nanos / (elapsed * 1_000_000_000) * 10_000
        guard bp.isFinite, bp >= 0, bp <= Double(maximumCores) * 10_000 * 1.05 else { throw RealOptimizationError.changed }
        return RealAppUsage(cpuBasisPoints: Int(bp.rounded()), residentBytes: after.resident,
                            intervalMS: Int((elapsed * 1000).rounded()), observedAt: RoundtripJSON.timestamp(after.date))
    }
}

enum RealAppPolicy {
    static func allowed(bundleID: String, name: String, bundlePath: String, home: String) -> Bool {
        let lower = (bundleID + " " + name).lowercased()
        guard !bundleID.hasPrefix("com.apple."), !bundleID.hasPrefix("com.openai."),
              !["chatgpt", "codex", "tunnel", "statsdiagnostics", "stats diagnostics", "terminal", "iterm", "warp", "ssh", "remote desktop"].contains(where: lower.contains) else { return false }
        let root = "/Applications/", personal = home + "/Applications/"
        guard bundlePath.hasPrefix(root) || bundlePath.hasPrefix(personal), bundlePath.hasSuffix(".app"),
              !bundlePath.contains("/Contents/"), !bundlePath.contains("/Utilities/") else { return false }
        return true
    }
}

protocol RealAppProbing {
    func candidates() -> [RealAppIdentity]
    func identity(pid: Int32) throws -> RealAppIdentity
    func counter(for identity: RealAppIdentity) throws -> RealAppCounter
    func requestNormalQuit(_ identity: RealAppIdentity, notAfter: Date) throws -> Bool
    func hasExited(_ identity: RealAppIdentity) -> Bool
}

final class RealAppProbe: RealAppProbing {
    func candidates() -> [RealAppIdentity] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated && $0.processIdentifier != getpid() }
            .prefix(64).compactMap { try? identity(pid: $0.processIdentifier) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }
    private func bsd(_ pid: Int32) throws -> proc_bsdinfo {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
              info.pbi_uid == geteuid(), info.pbi_ruid == geteuid(), info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0 else { throw RealOptimizationError.ineligible }
        return info
    }
    func identity(pid: Int32) throws -> RealAppIdentity {
        guard pid > 1, pid != getpid(), let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated, app.activationPolicy == .regular,
              let bundle = app.bundleIdentifier, let url = app.bundleURL?.resolvingSymlinksInPath(),
              let executable = app.executableURL?.resolvingSymlinksInPath(), let name = app.localizedName,
              name.utf16.count <= 120, !name.isEmpty, name.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format }),
              executable.path.hasPrefix(url.path + "/Contents/MacOS/"),
              RealAppPolicy.allowed(bundleID: bundle, name: name, bundlePath: url.path, home: FileManager.default.homeDirectoryForCurrentUser.path) else { throw RealOptimizationError.ineligible }
        let before = try bsd(pid)
        var code: SecCode?, requirement: SecRequirement?, staticCode: SecStaticCode?, information: CFDictionary?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
              let code,
              SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess,
              SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let values = information as? [String: Any],
              let identifier = values[kSecCodeInfoIdentifier as String] as? String, identifier == bundle,
              let hash = values[kSecCodeInfoUnique as String] as? Data, !hash.isEmpty,
              let team = values[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else { throw RealOptimizationError.ineligible }
        let after = try bsd(pid)
        guard before.pbi_start_tvsec == after.pbi_start_tvsec, before.pbi_start_tvusec == after.pbi_start_tvusec, !app.isTerminated else { throw RealOptimizationError.changed }
        return RealAppIdentity(pid: pid, uid: after.pbi_uid, startedSeconds: after.pbi_start_tvsec, startedMicroseconds: after.pbi_start_tvusec,
                               bundleID: bundle, bundlePath: url.path, executablePath: executable.path,
                               codeHash: hash.map { String(format: "%02x", $0) }.joined(), teamID: team, displayName: name)
    }
    func counter(for expected: RealAppIdentity) throws -> RealAppCounter {
        guard try identity(pid: expected.pid) == expected else { throw RealOptimizationError.changed }
        var info = proc_taskinfo()
        guard proc_pidinfo(expected.pid, PROC_PIDTASKINFO, 0, &info, Int32(MemoryLayout<proc_taskinfo>.size)) == Int32(MemoryLayout<proc_taskinfo>.size) else { throw RealOptimizationError.changed }
        let after = try bsd(expected.pid)
        guard after.pbi_start_tvsec == expected.startedSeconds, after.pbi_start_tvusec == expected.startedMicroseconds else { throw RealOptimizationError.changed }
        return RealAppCounter(user: info.pti_total_user, system: info.pti_total_system, resident: info.pti_resident_size,
                              uptime: ProcessInfo.processInfo.systemUptime, date: Date())
    }
    func requestNormalQuit(_ expected: RealAppIdentity, notAfter: Date) throws -> Bool {
        guard let app = NSRunningApplication(processIdentifier: expected.pid), !app.isTerminated,
              try identity(pid: expected.pid) == expected, !app.isTerminated else { throw RealOptimizationError.changed }
        // One normal quit request. No forceTerminate, signal, AppleScript, shell or retries.
        guard Date() <= notAfter else { throw RealOptimizationError.changed }
        return app.terminate()
    }
    func hasExited(_ expected: RealAppIdentity) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: expected.pid), !app.isTerminated else { return true }
        guard let info = try? bsd(expected.pid) else { return false }
        return info.pbi_start_tvsec != expected.startedSeconds || info.pbi_start_tvusec != expected.startedMicroseconds
    }
}

struct RealProcessTable {
    let counters: [Int32: RealAppCounter]
    let uids: [Int32: UInt32]
    let starts: [Int32: String]
    let reportedCount: Int
    let unreadable: Int
    let truncated: Bool
}
struct RealGlobalSample {
    let candidates: [RealCandidate]
    let consumers: [[String: Any]]
    let coverage: [String: Any]
}

extension RealAppProbe {
    func processTable() -> RealProcessTable {
        let limit = 4096
        var pids = [Int32](repeating: 0, count: limit)
        let reported = Int(proc_listallpids(nil, 0))
        let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        var counters: [Int32: RealAppCounter] = [:], uids: [Int32: UInt32] = [:]
        var starts: [Int32: String] = [:]
        var unreadable = 0
        for pid in pids.prefix(min(limit, max(0, Int(count)))) where pid > 0 {
            var bsd = proc_bsdinfo(), task = proc_taskinfo()
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
                  proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, Int32(MemoryLayout<proc_taskinfo>.size)) == Int32(MemoryLayout<proc_taskinfo>.size) else { unreadable += 1; continue }
            // Never read argv, environment, paths, window titles or raw process names.
            counters[pid] = RealAppCounter(user: task.pti_total_user, system: task.pti_total_system, resident: task.pti_resident_size,
                                            uptime: ProcessInfo.processInfo.systemUptime, date: Date())
            uids[pid] = bsd.pbi_uid
            starts[pid] = "\(bsd.pbi_start_tvsec):\(bsd.pbi_start_tvusec)"
        }
        return RealProcessTable(counters: counters, uids: uids, starts: starts, reportedCount: reported, unreadable: unreadable, truncated: reported >= limit || count >= limit)
    }
    func globalSample(before: RealProcessTable, after: RealProcessTable) -> RealGlobalSample {
        let apps = Dictionary(NSWorkspace.shared.runningApplications.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { first, _ in first })
        var usages: [Int32: RealAppUsage] = [:]
        for (pid, end) in after.counters {
            guard let start = before.counters[pid], before.uids[pid] == after.uids[pid], before.starts[pid] == after.starts[pid],
                  let usage = try? RealAppCounter.usage(start, end, maximumCores: ProcessInfo.processInfo.activeProcessorCount) else { continue }
            usages[pid] = usage
        }
        let cpuTop = usages.keys.sorted { usages[$0]!.cpuBasisPoints > usages[$1]!.cpuBasisPoints }.prefix(5)
        let memoryTop = usages.keys.sorted { usages[$0]!.residentBytes > usages[$1]!.residentBytes }.prefix(5)
        var top = Array(cpuTop)
        for pid in memoryTop where !top.contains(pid) { top.append(pid) }
        let gui = usages.keys.filter { apps[$0]?.activationPolicy == .regular && usages[$0]!.isHigh }
            .sorted { max(Double(usages[$0]!.cpuBasisPoints) / 2500, Double(usages[$0]!.residentBytes) / 536870912) > max(Double(usages[$1]!.cpuBasisPoints) / 2500, Double(usages[$1]!.residentBytes) / 536870912) }
        var targets: [RealCandidate] = []
        for pid in gui.prefix(32) {
            if let identity = try? identity(pid: pid), let usage = usages[pid],
               after.starts[pid] == "\(identity.startedSeconds):\(identity.startedMicroseconds)" {
                targets.append(RealCandidate(id: UUID().uuidString.lowercased(), identity: identity, usage: usage))
            }
            if targets.count == 5 { break }
        }
        let consumers: [[String: Any]] = top.compactMap { pid in
            guard let usage = usages[pid] else { return nil }
            let candidate = targets.first { $0.identity.pid == pid }
            let recognized = candidate?.identity ?? (try? identity(pid: pid))
            let sameIdentity = recognized.map { after.starts[pid] == "\($0.startedSeconds):\($0.startedMicroseconds)" } ?? false
            let category: String
            let name: String
            if let recognized, sameIdentity { category = "ordinary_gui_app"; name = String(String.UnicodeScalarView(recognized.displayName.unicodeScalars.prefix(64))) }
            else if after.uids[pid] != geteuid() { category = "system_process"; name = "System process" }
            else if let app = apps[pid], app.activationPolicy == .regular {
                category = "protected_app"; name = "Protected app"
            } else { category = "unknown_process"; name = "Other process" }
            return ["consumer_id": UUID().uuidString.lowercased(), "display_name": name, "category": category,
                    "cpu_basis_points": usage.cpuBasisPoints, "resident_bytes": usage.residentBytes, "interval_ms": usage.intervalMS,
                    "observed_at": usage.observedAt, "measurement_scope": "single_process", "quit_candidate_id": candidate?.id as Any? ?? NSNull()]
        }
        return RealGlobalSample(candidates: targets, consumers: consumers,
                                coverage: ["scope": "visible_processes_bounded", "pid_limit": 4096, "sampled_processes": usages.count,
                                           "unavailable_processes": min(4096 - usages.count, max(before.unreadable, after.unreadable)), "truncated": before.truncated || after.truncated, "helpers_aggregated": false])
    }
}
