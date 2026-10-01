// Display-only language and interaction state. Wire fields and stored evidence stay unchanged.
import Foundation

enum DiagnosticText {
    static func usesSimplifiedChinese(_ preferences: [String]) -> Bool {
        // Locale honors macOS per-app AppleLanguages, then the system language order.
        Bundle.preferredLocalizations(from: ["en", "zh-Hans"], forPreferences: preferences).first == "zh-Hans"
    }
    static func text(_ english: String, _ chinese: String) -> String {
        usesSimplifiedChinese(Locale.preferredLanguages) ? chinese : english
    }
    static func metric(_ value: LocalMetric) -> String {
        switch value {
        case .cpu: return text("CPU usage", "CPU 使用率")
        case .memory: return text("Memory pressure", "内存压力")
        case .disk: return text("Free disk space", "磁盘可用空间")
        }
    }
    static func error(_ error: Error) -> String {
        if error is RuntimeDiscoveryError || error is SyntheticSocketError { return error.localizedDescription }
        if case RoundtripError.invalid(let reason) = error {
            if reason.lowercased().contains("expired") {
                return text("This request has expired or its dates could not be verified. Cancel it and start a new test.", "请求已过期，或时间信息未通过校验。请取消本次请求，再开始新的测试。")
            }
            return text("The request or local state could not be verified safely. No new action was authorized. Review the technical details; cancel this request before starting another.", "请求或本地状态未通过安全校验，未授权新的操作。可查看技术详情；开始新测试前请先取消本次请求。")
        }
        return text("The operation could not finish. Review the technical details and try again.", "操作未完成。请查看技术详情后重试。")
    }
    static func safeUntrusted(_ text: String) -> String {
        // Render markup as text; neutralize invisible direction/control overrides.
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            if (CharacterSet.controlCharacters.contains(scalar) && scalar != "\n" && scalar != "\t") || (0x202A...0x202E).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value) { return UnicodeScalar(0xFFFD)! }
            return scalar
        }))
    }
    static func reading(_ value: LocalMetricReading) -> String {
        guard value.freshness != .unavailable, let numeric = value.value, numeric.isFinite,
              let stamp = value.observedAt, let date = try? RoundtripJSON.date(stamp) else {
            return text("No usable reading or timestamp", "暂无可用读数或采样时间")
        }
        let freshness: String
        switch value.freshness {
        case .fresh: freshness = text("fresh", "有效")
        case .stale: freshness = text("stale", "已过时")
        case .unavailable: freshness = text("unavailable", "暂无数据")
        }
        let number: String
        if let valueNumber = value.value {
            switch value.metric {
            case .cpu: number = String(format: "%.1f%%", valueNumber * 100)
            case .disk: number = String(format: "%.2f GiB", valueNumber)
            case .memory:
                number = valueNumber == 4 ? text("critical", "严重") : valueNumber == 2 ? text("warning", "警告") : valueNumber == 1 ? text("normal", "正常") : text("unknown", "未知")
            }
        } else { number = "—" }
        return "\(number) · \(freshness) · " + text("sampled at ", "采样于 ") + DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .medium)
    }
    static func outcome(_ code: String) -> String {
        switch code {
        case "completed_local_test": return text("Local test completed", "本地测试已完成")
        case "cancelled": return text("Cancelled", "已取消")
        case "failed_local_test": return text("Local test did not finish", "本地测试未完成")
        default: return text("Local test interrupted or expired", "本地测试已中断或过期")
        }
    }
}

struct SyntheticControlState {
    let phase: LocalRoundtripState.Phase
    let discovering: Bool
    let exchanging: Bool
    let polling: Bool
    let checkingApproval: Bool
    let hasReceipt: Bool
    var busy: Bool { discovering || exchanging || polling || checkingApproval || phase == .executing }
    var canSend: Bool { !busy && phase != .reviewing }
    var canRetry: Bool { canSend && phase == .waiting }
    var canCheck: Bool { !busy && phase != .reviewing }
    var canApprove: Bool { !busy && phase == .reviewing }
    var canCancel: Bool { busy || [.waiting, .reviewing, .executing].contains(phase) }
}
