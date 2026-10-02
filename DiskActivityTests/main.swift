import Foundation

private var checks = 0

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    if !condition() { fatalError(message) }
}

private func expectRate(_ value: DiskActivityRate.Rate?, read: Int64, write: Int64, _ message: String) {
    expect(value?.read == read && value?.write == write, message)
}

// A large since-boot total is only a baseline. Actual elapsed time defines B/s.
var normal = DiskActivityRate()
expect(normal.update(readBytes: 9_000_000, writeBytes: 4_000_000, at: 100) == nil, "First sample must not show cumulative counters")
expectRate(normal.update(readBytes: 9_000_600, writeBytes: 4_000_300, at: 101.5), read: 400, write: 200, "A delayed 1.5s tick must be normalized")
expectRate(normal.update(readBytes: 9_000_700, writeBytes: 4_000_500, at: 101.75), read: 400, write: 800, "Subsecond ticks must also be normalized")
expectRate(normal.update(readBytes: 9_000_700, writeBytes: 4_000_500, at: 102.75), read: 0, write: 0, "Idle disk reports zero rates")

// Zero is a real cumulative baseline, not an uninitialized sentinel.
var zero = DiskActivityRate()
expect(zero.update(readBytes: 0, writeBytes: 0, at: 0) == nil, "Zero baseline is accepted")
expectRate(zero.update(readBytes: 512, writeBytes: 1_024, at: 1), read: 512, write: 1_024, "First I/O after a zero baseline must be shown")

// Lifecycle resets represent pause/resume, disable/enable, sleep/wake and a
// temporarily missing device/counter. Each needs two fresh valid samples.
for reason in ["pause/resume", "disable/enable", "sleep/wake", "missing counters", "removed/replaced device"] {
    normal.reset()
    expect(normal.update(readBytes: 50_000_000, writeBytes: 25_000_000, at: 500) == nil, "\(reason) must require a fresh baseline")
    expectRate(normal.update(readBytes: 50_000_900, writeBytes: 25_000_450, at: 501.5), read: 600, write: 300, "\(reason) must recover after fresh elapsed time")
}

// A long observation gap cannot average paused/sleeping I/O into a live point.
var gaps = DiskActivityRate()
_ = gaps.update(readBytes: 100, writeBytes: 100, at: 0)
expectRate(gaps.update(readBytes: 600, writeBytes: 350, at: 5), read: 100, write: 50, "Maximum accepted gap is inclusive")
expect(gaps.update(readBytes: 10_000, writeBytes: 10_000, at: 11) == nil, "A gap over five seconds resets continuity")
expectRate(gaps.update(readBytes: 10_200, writeBytes: 10_100, at: 12), read: 200, write: 100, "A gap sample becomes the new baseline")

// Either counter rolling back invalidates the whole observation, avoiding a
// negative rate or a mixed old/new device sample.
for rollbackRead in [true, false] {
    var rollback = DiskActivityRate()
    _ = rollback.update(readBytes: 1_000, writeBytes: 1_000, at: 1)
    let read: Int64 = rollbackRead ? 50 : 1_500
    let write: Int64 = rollbackRead ? 1_500 : 50
    expect(rollback.update(readBytes: read, writeBytes: write, at: 2) == nil, "A counter rollback invalidates both rates")
    expectRate(rollback.update(readBytes: read + 200, writeBytes: write + 100, at: 3), read: 200, write: 100, "Rolled-back counters rebase cleanly")
}

var clock = DiskActivityRate()
_ = clock.update(readBytes: 100, writeBytes: 100, at: 10)
expect(clock.update(readBytes: 200, writeBytes: 200, at: 10) == nil, "Repeated timestamp cannot divide by zero")
expectRate(clock.update(readBytes: 300, writeBytes: 400, at: 11), read: 100, write: 200, "Repeated timestamp rebases counters")
expect(clock.update(readBytes: 400, writeBytes: 500, at: 9) == nil, "Backwards time invalidates a sample")
expectRate(clock.update(readBytes: 450, writeBytes: 600, at: 10), read: 50, write: 100, "Backwards time recovers with fresh samples")

for invalidTime in [TimeInterval.nan, .infinity, -.infinity] {
    expect(clock.update(readBytes: 500, writeBytes: 700, at: invalidTime) == nil, "Nonfinite time is rejected")
    expect(clock.update(readBytes: 1_000, writeBytes: 1_000, at: 20) == nil, "Nonfinite time clears the old baseline")
    expectRate(clock.update(readBytes: 1_100, writeBytes: 1_200, at: 21), read: 100, write: 200, "Valid sampling recovers after nonfinite time")
}

for negativeRead in [true, false] {
    expect(clock.update(readBytes: negativeRead ? -1 : 2_000, writeBytes: negativeRead ? 2_000 : -1, at: 22) == nil, "Negative counters are rejected")
    expect(clock.update(readBytes: 3_000, writeBytes: 3_000, at: 23) == nil, "Invalid counters clear both baselines")
    expectRate(clock.update(readBytes: 3_100, writeBytes: 3_200, at: 24), read: 100, write: 200, "Valid counters recover")
}

// Int64 conversion is bounded even for extreme counters or a tiny interval.
var overflow = DiskActivityRate()
_ = overflow.update(readBytes: 0, writeBytes: 0, at: 0)
expectRate(overflow.update(readBytes: Int64.max, writeBytes: Int64.max, at: 0.5), read: Int64.max, write: Int64.max, "Overflowing B/s must clamp without trapping")
overflow.reset()
_ = overflow.update(readBytes: 0, writeBytes: 0, at: 0)
expectRate(overflow.update(readBytes: 1, writeBytes: 0, at: .leastNonzeroMagnitude), read: Int64.max, write: 0, "Tiny elapsed time must not trap on infinity")

// The reader keeps independent baselines per disk, including a mutable default
// dictionary entry. Removing a disk must not reuse its prior counter baseline.
var disks: [String: DiskActivityRate] = [:]
expect(disks["disk0", default: DiskActivityRate()].update(readBytes: 1_000, writeBytes: 500, at: 1) == nil, "First disk establishes its baseline")
expect(disks["disk1", default: DiskActivityRate()].update(readBytes: 10, writeBytes: 20, at: 1) == nil, "Second disk has an independent baseline")
expectRate(disks["disk0", default: DiskActivityRate()].update(readBytes: 1_200, writeBytes: 600, at: 2), read: 200, write: 100, "Dictionary stores the first disk baseline")
expectRate(disks["disk1", default: DiskActivityRate()].update(readBytes: 70, writeBytes: 50, at: 2), read: 60, write: 30, "Second disk rates are independent")
disks.removeValue(forKey: "disk0")
expect(disks["disk0", default: DiskActivityRate()].update(readBytes: 100_000, writeBytes: 100_000, at: 3) == nil, "A reattached disk establishes a fresh baseline")

print("Passed \(checks) disk activity rate checks")
