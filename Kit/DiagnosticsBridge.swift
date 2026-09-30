// Local-only bridge for the Stats Diagnostics fork. MIT; see LICENSE.
import Foundation

public enum DiagnosticsBridge {
    public static let notification = Notification.Name("ai.personal.StatsDiagnostics.sample")
    public static var enabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: "StatsDiagnosticsFork") as? Bool == true
    }
    public static var dataFolder: String { enabled ? "StatsDiagnostics" : "Stats" }
    public static func post(_ kind: String, values: [String: Double], processes: [TopProcess] = []) {
        guard enabled else { return }
        // Names are mapped to fixed categories by the consumer before persistence/export.
        let info: [String: Any] = ["kind": kind, "values": values,
                                  "processes": Array(processes.prefix(5)), "date": Date()]
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: notification, object: nil, userInfo: info)
        }
    }
    public static func interval(module: ModuleType, reader: String, requested: Int) -> Int {
        guard enabled else { return requested }
        if reader == "ProcessReader" || module == .disk { return 300 }
        return 60
    }
}
