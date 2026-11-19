// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A background wake gives the app about thirty seconds before iOS suspends
/// it. Work cut off by suspension is redone from scratch on the next wake, so
/// the collector stops at a clean boundary instead of starting a page or an
/// upload it can't finish, and a HealthKit wake reports itself handled only
/// once its sync is done or the time is nearly gone.
final class BackgroundBudgetTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-budget-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    /// Seconds left, as set by the test. Each check is counted, and an
    /// optional script supplies the answer to the first few.
    actor ScriptedBudget: ExecutionBudget {
        private var script: [TimeInterval]
        private var fallback: TimeInterval?
        private(set) var checks = 0

        init(_ script: [TimeInterval] = [], then fallback: TimeInterval?) {
            self.script = script
            self.fallback = fallback
        }

        func set(_ remaining: TimeInterval?) {
            script = []
            fallback = remaining
        }

        func remainingTime() async -> TimeInterval? {
            checks += 1
            return script.isEmpty ? fallback : script.removeFirst()
        }
    }

    // MARK: - Fixtures

    private func pages(_ count: Int) -> [SyncResult] {
        (1 ... count).map { page in
            SyncResult(
                records: [["id": .string("r\(page)")]],
                tableName: "fixture_rows",
                cursor: ["anchor": .string("a\(page)")],
                hasMore: page < count
            )
        }
    }

    private func gateway(_ session: CollectorCoreTests.MockSession) throws -> GatewayClient {
        session.responder = { req in
            let notFound = req.url?.path.hasPrefix("/sync-state/") == true && req.httpMethod == "GET"
            let http = HTTPURLResponse(
                url: req.url!,
                statusCode: notFound ? 404 : 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data((notFound ? "" : "{\"ok\":true}").utf8), http)
        }
        return try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )
    }

    /// Anchors the collector saved, in order.
    private func savedAnchors(_ session: CollectorCoreTests.MockSession) -> [String] {
        session.calls
            .filter { $0.method == "POST" && $0.url.contains("/sync-state/") }
            .compactMap { $0.body.flatMap { String(data: $0, encoding: .utf8) } }
            .compactMap { body in ["a1", "a2", "a3"].first { body.contains("\"\($0)\"") } }
    }

    private func ingestCount(_ session: CollectorCoreTests.MockSession) -> Int {
        session.calls.filter { $0.url.hasSuffix("/analytics/ingest") }.count
    }

    private func enqueue(_ buffer: OfflineBuffer, count: Int) async throws {
        for index in 0 ..< count {
            _ = try await buffer.enqueue(Batch(
                id: Batch.makeId(now: Date().addingTimeInterval(TimeInterval(index))),
                sourceId: "mock:ios-a",
                tableName: "fixture_rows",
                records: [["id": .string("r\(index)")]],
                schema: nil,
                deletedIds: [],
                createdAt: Date()
            ))
        }
    }

    // MARK: - Pages

    // Reading with a budget the uploader shares: DeliveryPaceTests.

    func testAWakeWithNoTimeLeftReadsNothing() async throws {
        let session = CollectorCoreTests.MockSession()
        let gateway = try gateway(session)
        let buffer = OfflineBuffer(directory: directory)
        let source = CollectorCoreTests.MockSource(pages: pages(2))
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            budget: ScriptedBudget(then: 1)
        )

        let summary = await core.sync(sourceId: "mock:ios-a")

        XCTAssertEqual(source.callCount, 0)
        XCTAssertEqual(summary?.batches, 0)
        XCTAssertEqual(savedAnchors(session), [])
    }

    func testAForegroundSyncIsNotLimited() async throws {
        let session = CollectorCoreTests.MockSession()
        let gateway = try gateway(session)
        let buffer = OfflineBuffer(directory: directory)
        let source = CollectorCoreTests.MockSource(pages: pages(3))
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer, budget: ScriptedBudget(then: nil)),
            sources: [source],
            budget: ScriptedBudget(then: nil)
        )

        _ = await core.sync(sourceId: "mock:ios-a")

        XCTAssertEqual(savedAnchors(session), ["a1", "a2", "a3"])
        XCTAssertEqual(ingestCount(session), 3)
    }

    // MARK: - Uploads

    func testDrainStopsBeforeAnUploadItHasNoTimeFor() async throws {
        let session = CollectorCoreTests.MockSession()
        let gateway = try gateway(session)
        let buffer = OfflineBuffer(directory: directory)
        try await enqueue(buffer, count: 3)
        let budget = ScriptedBudget([60], then: ExecutionMargin.upload - 1)

        let stats = try await Uploader(gateway: gateway, buffer: buffer, budget: budget).drain()

        XCTAssertEqual(stats.uploaded, 1)
        XCTAssertEqual(stats.failed, 0, "a batch never sent is not a failed one")
        XCTAssertEqual(stats.remaining, 2)
        XCTAssertTrue(stats.stoppedForTime)
        XCTAssertEqual(ingestCount(session), 1)
        let onDisk = try await buffer.listIds().count
        XCTAssertEqual(onDisk, 2, "the batches left stay queued")

        let next = try await Uploader(gateway: gateway, buffer: buffer).drain()
        XCTAssertEqual(next.uploaded, 2)
        XCTAssertFalse(next.stoppedForTime)
    }

    // MARK: - Follow-up passes

    func testAQueuedWakeCanWaitForItsFollowUpPass() async throws {
        let session = CollectorCoreTests.MockSession()
        let gateway = try gateway(session)
        let buffer = OfflineBuffer(directory: directory)
        let probe = CollectorCoreTests.RerunProbe()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [CollectorCoreTests.RerunSource(probe: probe)]
        )

        let running = Task { await core.sync(sourceId: "mock:rerun") }
        await probe.wait(for: 1)
        let queued = Task { () -> Int in
            _ = await core.sync(sourceId: "mock:rerun", awaitingFollowUp: true)
            return await probe.callCount
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        await probe.releaseFirst()

        let callsWhenQueuedReturned = await queued.value
        _ = await running.value
        XCTAssertEqual(callsWhenQueuedReturned, 2, "the queued wake returns after the pass that covers it")
        let calls = await probe.callCount
        XCTAssertEqual(calls, 2)
    }

    func testAFollowUpPassNeedsTimeToStart() async throws {
        let session = CollectorCoreTests.MockSession()
        let gateway = try gateway(session)
        let buffer = OfflineBuffer(directory: directory)
        let probe = CollectorCoreTests.RerunProbe()
        let budget = ScriptedBudget(then: 30)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [CollectorCoreTests.RerunSource(probe: probe)],
            budget: budget
        )

        let running = Task { await core.sync(sourceId: "mock:rerun") }
        await probe.wait(for: 1)
        let queued = Task { await core.sync(sourceId: "mock:rerun", awaitingFollowUp: true) }
        try await Task.sleep(nanoseconds: 50_000_000)
        await budget.set(1)
        await probe.releaseFirst()

        _ = await running.value
        _ = await queued.value
        let calls = await probe.callCount
        XCTAssertEqual(calls, 1, "the follow-up is left to the next wake, and its waiter still returns")
    }

    // MARK: - Reporting a wake

    actor Gate {
        private var released = false
        private var waiter: CheckedContinuation<Void, Never>?
        private(set) var finished = false

        func wait() async {
            if !released { await withCheckedContinuation { waiter = $0 } }
            finished = true
        }

        func release() {
            released = true
            waiter?.resume()
            waiter = nil
        }
    }

    func testAWakeReportsWhenItsTimeIsNearlyUpAndTheWorkCarriesOn() async throws {
        let gate = Gate()
        let budget = ScriptedBudget(then: 30)
        let report = Task {
            await BackgroundWake.run(budget: budget, pollInterval: .milliseconds(10)) {
                await gate.wait()
            }
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        await budget.set(ExecutionMargin.wakeReport - 1)
        await report.value

        let finishedAtReport = await gate.finished
        XCTAssertFalse(finishedAtReport, "the wake is reported before the work is done")
        await gate.release()
        for _ in 0 ..< 100 where await !gate.finished {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let finished = await gate.finished
        XCTAssertTrue(finished, "the work is not cancelled by the report")
    }

    func testAWakeReportsAsSoonAsItsWorkIsDone() async {
        let gate = Gate()
        await gate.release()
        let started = Date()
        await BackgroundWake.run(budget: ScriptedBudget(then: 30), pollInterval: .seconds(5)) {
            await gate.wait()
        }
        let finished = await gate.finished
        XCTAssertTrue(finished)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "it must not wait out a poll interval")
    }

    func testAForegroundWakeWaitsForItsWork() async {
        let gate = Gate()
        let report = Task {
            await BackgroundWake.run(budget: ScriptedBudget(then: nil), pollInterval: .milliseconds(10)) {
                await gate.wait()
            }
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        await gate.release()
        await report.value
        let finished = await gate.finished
        XCTAssertTrue(finished)
    }
}
