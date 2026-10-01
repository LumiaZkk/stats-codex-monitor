// Display-only interpretation of verified local state. Never authorizes an action.
import Foundation

struct SyntheticSection {
    let title: String
    let body: String
}
struct SyntheticExperience {
    let title: String
    let introduction: String
    let sections: [SyntheticSection]
    let localEvidence: Bool
    let busy: Bool
    let progress: String

    static func action(_ action: LocalTestAction) -> SyntheticSection {
        switch action.kind {
        case .openActivityMonitor:
            return SyntheticSection(title: DiagnosticText.text("Open Activity Monitor", "打开活动监视器"), body: DiagnosticText.text(
                "Why: lets you inspect the Mac’s process list yourself.\nWhat happens: Apple’s Activity Monitor opens. No process is stopped or changed.\nLimit: opening it does not identify a cause or improve performance.",
                "为什么：让你自己查看 Mac 的进程列表。\n会发生什么：打开 Apple 活动监视器，不会终止或修改进程。\n能说明什么：仅打开工具，不能据此找出卡顿原因或改善性能。"))
        case .observeMetrics:
            let names = action.metrics.map(DiagnosticText.metric).joined(separator: DiagnosticText.text(", ", "、"))
            return SyntheticSection(title: DiagnosticText.text("Observe for \(action.durationSeconds) seconds", "只读观测 \(action.durationSeconds) 秒"), body: DiagnosticText.text(
                "Why: checks whether existing readings update during this local test.\nWhat happens: reads cached \(names); no extra collector starts and no readings are uploaded. You can cancel.\nLimit: a value changing does not prove an optimization. Disk readings update every 5 minutes, so a short test may get no new disk sample.",
                "为什么：检查测试期间已有读数是否更新。\n会发生什么：查看缓存中的\(names)，不增加采集器，不上传读数；可以随时取消。\n能说明什么：数值变化不代表优化有效。磁盘每 5 分钟采样一次，短时间观测可能没有新数据。"))
        }
    }
    static func proposal(_ proposal: VerifiedSyntheticProposal) -> Self {
        var sections = [SyntheticSection(title: DiagnosticText.text("Returned model summary · unverified source", "返回的模型摘要 · 来源未经验证"), body: DiagnosticText.safeUntrusted(proposal.untrustedSummary))]
        sections += proposal.actions.map(action)
        sections.append(SyntheticSection(title: DiagnosticText.text("Your decision", "由你决定"), body: DiagnosticText.text(
            "Approve only if you want these exact local tests. They are real local actions, separate from the cloud simulation. The content checksum does not authenticate the author. You can cancel without running anything.",
            "只有你愿意进行上述本地测试时才批准。它们会在本机实际发生，与云端模拟建议分开授权。内容校验不能证明作者身份；你可以直接取消，不执行任何操作。")))
        return Self(title: DiagnosticText.text("Simulated suggestion · review before acting", "模拟建议已返回，请先看结论"), introduction: DiagnosticText.text(
            "This sample assumes CPU usage of 92%. It does not diagnose this Mac or establish why it is slow. The steps below demonstrate receiving a suggestion, choosing whether to approve it, and viewing a local result.",
            "这个样例假设 CPU 使用率为 92%，并未诊断这台 Mac，也没有查明它变慢的原因。下面演示：收到建议 → 由你批准 → 查看本地结果。"), sections: sections, localEvidence: false, busy: false, progress: DiagnosticText.text("1 Sent  ✓    2 Suggestion received  ✓    3 Awaiting your approval", "1 已发送 ✓    2 已收到建议 ✓    3 等你决定是否批准"))
    }
    static func running(_ proposal: VerifiedSyntheticProposal?, receipt: LocalTestReceipt?, at now: Date = Date()) -> Self {
        let elapsed = receipt.flatMap { try? RoundtripJSON.date($0.startedAt) }.map { max(0, Int(now.timeIntervalSince($0))) } ?? 0
        let results = receipt?.actionResults ?? []
        let sections = (proposal?.actions ?? []).map { action -> SyntheticSection in
            switch action.kind {
            case .openActivityMonitor:
                return SyntheticSection(title: DiagnosticText.text("Activity Monitor", "活动监视器"), body: results.contains("activity_monitor_opened; no optimization performed") ? DiagnosticText.text("macOS confirmed the app opened. No process was changed.", "macOS 已确认打开应用，没有修改任何进程。") : DiagnosticText.text("Waiting for macOS to confirm the open request.", "正在等待 macOS 确认打开结果。"))
            case .observeMetrics:
                let finished = results.contains("observation_finished; compare timestamps and freshness, not synthetic fixture values")
                return SyntheticSection(title: DiagnosticText.text("\(action.durationSeconds)-second observation", "\(action.durationSeconds) 秒只读观测"), body: finished ? DiagnosticText.text("Observation finished. Preparing the local result.", "观测已结束，正在整理本地结果。") : DiagnosticText.text("Local test elapsed: \(elapsed) seconds. Existing cached readings are being checked; fresh values may arrive less often. You can cancel this observation.", "本地测试已进行 \(elapsed) 秒。正在查看已有缓存读数，新的采样不一定每秒到达；你可以取消观测。"))
            }
        }
        return Self(title: DiagnosticText.text("Running only the local tests you approved", "正在进行你批准的本地测试"), introduction: DiagnosticText.text("No performance optimization is being performed. Real readings stay on this Mac. Opening Activity Monitor cannot be undone by cancelling observation.", "本次没有执行性能优化，真实读数留在本机。取消观测不会撤回已经打开的活动监视器。"), sections: sections, localEvidence: false, busy: true, progress: DiagnosticText.text("3 Approval received  ✓    4 Local test running    5 Result next", "3 已获你批准 ✓    4 正在本地测试    5 稍后显示结果"))
    }
    static func receipt(_ receipt: LocalTestReceipt) -> Self {
        let results = receipt.actionResults
        var sections: [SyntheticSection] = []
        if results.contains(where: { $0.hasPrefix("activity_monitor_") }) {
            let message: String
            if results.contains("activity_monitor_opened; no optimization performed") { message = DiagnosticText.text("Opened: macOS confirmed Activity Monitor launched. No process was stopped or changed.", "已打开：macOS 确认活动监视器启动成功，没有终止或修改任何进程。") }
            else if results.contains("activity_monitor_unavailable") || results.contains("activity_monitor_open_failed; no optimization performed") { message = DiagnosticText.text("Did not open. The test could not complete this action.", "未能打开，本次测试没有完成此操作。") }
            else { message = DiagnosticText.text("Open was requested, but the outcome is unconfirmed. Check whether Activity Monitor is open.", "已请求打开，但结果尚未确认。请查看活动监视器是否已经打开。") }
            sections.append(SyntheticSection(title: DiagnosticText.text("Activity Monitor result", "活动监视器的结果"), body: message))
        }
        if results.contains(where: { $0.hasPrefix("observation_started:") }) {
            let finished = results.contains("observation_finished; compare timestamps and freshness, not synthetic fixture values")
            let count = newReadingCount(receipt)
            sections.append(SyntheticSection(title: DiagnosticText.text("Observation result", "只读观测的结果"), body: (finished ? DiagnosticText.text("The approved observation period finished.", "已完成批准的观测时段。") : DiagnosticText.text("Observation stopped before completion.", "观测在完成前停止。")) + DiagnosticText.text(" \(count) new valid metric readings were recorded. This checks data updates; it does not demonstrate an optimization.", " 共记录 \(count) 条新的有效指标读数。这只说明读数是否更新，不代表优化有效。")))
        }
        if sections.isEmpty { sections.append(SyntheticSection(title: DiagnosticText.text("Action outcomes unavailable", "暂无可确认的操作结果"), body: DiagnosticText.text("The saved record has no recognized action outcome. Do not treat its completion label as proof that an action succeeded.", "保存的记录中没有可识别的操作结果，不能仅凭“完成”状态认定操作成功。"))) }
        let metrics = LocalMetric.allCases.filter { metric in receipt.before.contains { $0.metric == metric } || receipt.after.contains { $0.metric == metric } }
        for metric in metrics {
            let before = receipt.before.first { $0.metric == metric }, after = receipt.after.first { $0.metric == metric }
            let body = DiagnosticText.text("Before: ", "测试前：") + reading(before) + "\n" + DiagnosticText.text("After: ", "测试后：") + reading(after) + "\n" + comparison(before, after)
            sections.append(SyntheticSection(title: DiagnosticText.metric(metric), body: body))
        }
        sections.append(SyntheticSection(title: DiagnosticText.text("What to do next", "接下来可以做什么"), body: DiagnosticText.text(
            "For this Mac’s real readings, open SD → History (7 days). This version has not analyzed your real telemetry with dot and has not found or fixed a performance cause. You do not need to open the technical log to understand this result.",
            "想查看这台 Mac 的真实情况，可打开 SD → 历史记录（7 天）。当前版本尚未让 dot 分析真实监控数据，也没有找出或修复性能问题。理解本次结果不需要查看技术日志。")))
        let completed = receipt.outcome == "completed_local_test"
        return Self(title: completed ? DiagnosticText.text("Local demo finished · no optimization performed", "本地体验已结束，未执行性能优化") : DiagnosticText.text("Local demo stopped · check the partial results", "本地体验已停止，请查看已完成部分"), introduction: DiagnosticText.text(
            "These are real local test outcomes following a simulated suggestion. They do not establish a diagnosis, cause, or performance improvement. “Valid” means a cached reading was recent enough when captured, not that the Mac is healthy.",
            "以下是模拟建议之后，在本机实际发生的测试结果；它们不能证明故障原因或性能改善。“有效”只表示当时的缓存读数足够新，不表示电脑健康。"), sections: sections, localEvidence: true, busy: false, progress: completed ? DiagnosticText.text("5 Local result available", "5 已生成本地结果") : DiagnosticText.text("Stopped · no automatic retry", "已停止 · 不会自动重试"))
    }
    static func reading(_ reading: LocalMetricReading?) -> String {
        guard let reading else { return DiagnosticText.text("No reading captured", "没有采集到读数") }
        return DiagnosticText.reading(reading)
    }
    static func comparison(_ before: LocalMetricReading?, _ after: LocalMetricReading?) -> String {
        guard let before, let after, before.freshness == .fresh, after.freshness == .fresh,
              before.value?.isFinite == true, after.value?.isFinite == true,
              let first = before.observedAt.flatMap({ try? RoundtripJSON.date($0) }),
              let last = after.observedAt.flatMap({ try? RoundtripJSON.date($0) }), last > first else {
            return DiagnosticText.text("No comparable new reading. Missing, old, or reused cache entries cannot show a change.", "没有可比较的新采样。缺失、过时或重复使用同一缓存的读数，不能说明变化。")
        }
        return DiagnosticText.text("A newer reading arrived. A difference alone cannot show a cause or an optimization effect.", "有新的采样到达。仅凭数值差异，不能判断原因或优化效果。")
    }
    static func newReadingCount(_ receipt: LocalTestReceipt) -> Int {
        let previous = Set(receipt.before.compactMap { reading -> String? in
            guard let stamp = reading.observedAt else { return nil }; return reading.metric.rawValue + ":" + stamp
        })
        guard let started = try? RoundtripJSON.date(receipt.startedAt), let finishedAt = receipt.finishedAt,
              let finished = try? RoundtripJSON.date(finishedAt) else { return 0 }
        return Set((receipt.observations.flatMap { $0 } + receipt.after).compactMap { reading -> String? in
            guard reading.freshness == .fresh, reading.value?.isFinite == true, let stamp = reading.observedAt,
                  let date = try? RoundtripJSON.date(stamp), date >= started, date <= finished else { return nil }
            let key = reading.metric.rawValue + ":" + stamp
            return previous.contains(key) ? nil : key
        }).count
    }
}
