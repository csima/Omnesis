// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How much longer the process may run before iOS suspends it.
///
/// A background wake — a HealthKit observer, a background refresh, the grace
/// window after the user leaves the app — lasts about thirty seconds, and iOS
/// suspends the app mid-request when it ends. A request cut off that way is
/// not lost (the batch stays queued, the cursor stays put), but the time spent
/// on it is, and the next wake starts the same request over. So the collector
/// asks before each unit of work whether that unit can still finish, and stops
/// cleanly when it can't.
public protocol ExecutionBudget: Sendable {
    /// Seconds left before suspension, or `nil` while nothing limits it (the
    /// app is in the foreground).
    func remainingTime() async -> TimeInterval?
}

/// The least time each kind of work needs left before it is started.
public enum ExecutionMargin {
    /// One page of a source: a local read (an anchored HealthKit query, a
    /// Photos fetch), writing the batch to disk, and saving the cursor, which
    /// is one small gateway request.
    public static let page: TimeInterval = 5
    /// One batch upload. Most finish in well under a second, but a large
    /// batch on a weak uplink has been seen to take twenty; this leaves room
    /// for the common case without starting uploads that are bound to be cut.
    public static let upload: TimeInterval = 10
    /// What reading a page needs left: the page, and an upload after it.
    /// A wake that reads a page it then has no time to deliver has moved
    /// the source's cursor past samples that are only on the phone, and a
    /// run of such wakes reads ever further ahead of what reaches the
    /// gateway.
    public static let pageAndUpload: TimeInterval = page + upload
    /// How close to the end a wake reports itself finished even though its
    /// work is still running, so iOS hears back before it suspends the app.
    public static let wakeReport: TimeInterval = 2
}

extension ExecutionBudget {
    /// True while there is at least `margin` seconds left (or no limit).
    func allows(_ margin: TimeInterval) async -> Bool {
        guard let remaining = await remainingTime() else { return true }
        return remaining >= margin
    }
}

/// Runs the work a background wake triggered, returning when it has finished
/// or when the wake's time is about to run out — whichever comes first.
///
/// HealthKit treats an observer wake as handled once its completion handler is
/// called, and iOS may suspend the app soon after. Calling it before the work
/// finishes ends the wake early; never calling it makes HealthKit back off and
/// eventually stop waking the app. So the caller calls it when this returns.
/// Work still running at that point carries on until iOS suspends it; it has
/// been checking the same budget and stops at a clean boundary.
public enum BackgroundWake {
    public static func run(
        budget: (any ExecutionBudget)?,
        reportWithin margin: TimeInterval = ExecutionMargin.wakeReport,
        pollInterval: Duration = .milliseconds(500),
        _ work: @escaping @Sendable () async -> Void
    ) async {
        guard let budget else {
            await work()
            return
        }
        // Not a task group: a group waits for every child, and the work must
        // be able to outlive this call.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let finish = FinishOnce(continuation)
            Task {
                await work()
                finish.resume()
            }
            Task {
                while !finish.isDone, await budget.allows(margin) {
                    try? await Task.sleep(for: pollInterval)
                }
                finish.resume()
            }
        }
    }

    private final class FinishOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?

        init(_ continuation: CheckedContinuation<Void, Never>) {
            self.continuation = continuation
        }

        var isDone: Bool {
            lock.withLock { continuation == nil }
        }

        func resume() {
            let pending = lock.withLock {
                defer { continuation = nil }
                return continuation
            }
            pending?.resume()
        }
    }
}
