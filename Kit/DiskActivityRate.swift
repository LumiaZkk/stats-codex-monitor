// Live disk I/O rate calculation, independent of the sampling/UI implementation.
// MIT; see LICENSE.
import Foundation

public struct DiskActivityRate {
    public struct Rate: Equatable {
        public let read: Int64
        public let write: Int64
    }

    private struct Sample {
        let read: Int64
        let write: Int64
        let time: TimeInterval
    }

    // The live reader runs every second. Five seconds accommodates ordinary
    // scheduling jitter, but does not turn a pause into a misleading live rate.
    private let maximumGap: TimeInterval
    private var previous: Sample?

    public init(maximumGap: TimeInterval = 5) {
        self.maximumGap = maximumGap
    }

    public mutating func reset() {
        self.previous = nil
    }

    // nil means baseline/unavailable, never a rate since boot or since sleep.
    // The caller supplies monotonic time; wall-clock changes cannot affect rates.
    public mutating func update(readBytes: Int64, writeBytes: Int64, at time: TimeInterval) -> Rate? {
        guard readBytes >= 0, writeBytes >= 0, time.isFinite else {
            self.reset()
            return nil
        }
        let sample = Sample(read: readBytes, write: writeBytes, time: time)
        defer { self.previous = sample }
        guard let previous = self.previous else { return nil }
        let elapsed = time - previous.time
        guard elapsed > 0, elapsed <= self.maximumGap,
              readBytes >= previous.read, writeBytes >= previous.write else { return nil }

        return Rate(
            read: Self.bytesPerSecond(readBytes - previous.read, elapsed: elapsed),
            write: Self.bytesPerSecond(writeBytes - previous.write, elapsed: elapsed)
        )
    }

    private static func bytesPerSecond(_ bytes: Int64, elapsed: TimeInterval) -> Int64 {
        let rate = Double(bytes) / elapsed
        // Int64(Double(Int64.max)) traps because the Double rounds up to 2^63.
        guard rate < Double(Int64.max) else { return Int64.max }
        return Int64(rate)
    }
}
