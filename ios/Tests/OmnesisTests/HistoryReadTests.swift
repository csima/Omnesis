// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Reading a source's pending history in one long background task: what
/// counts as pending, when the read stops, and that an expired task stops
/// at a page boundary rather than failing the source.
final class HistoryReadTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-history-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Apple Health

    private let catalog = ["HKQuantityTypeIdentifierStepCount", "HKQuantityTypeIdentifierHeartRate"]

    func testAppleHealthHistoryIsPendingUntilEveryTypeHasCaughtUp() {
        let schedule = AppleHealthSchedule(catalog: catalog, pageLimit: 2)
        XCTAssertTrue(schedule.hasHistoryPending(AppleHealthCursor.decode(from: nil)), "never synced")

        var cursor = AppleHealthCursor.decode(from: nil)
        cursor.caughtUp = [catalog[0]]
        XCTAssertTrue(schedule.hasHistoryPending(cursor))

        cursor.caughtUp = Set(catalog)
        XCTAssertFalse(schedule.hasHistoryPending(cursor))
    }

    /// A cursor from before `caughtUp` existed counts by what the old
    /// rotation had finished.
    func testAnOldCursorCountsAsCaughtUpOnceItsCycleCompleted() {
        let schedule = AppleHealthSchedule(catalog: catalog, pageLimit: 2)
        var cursor = AppleHealthCursor.decode(from: nil)
        cursor.setAnchor("a", for: catalog[0])
        cursor.setAnchor("b", for: catalog[1])
        XCTAssertTrue(schedule.hasHistoryPending(cursor), "first cycle still running")

        cursor.lastCycleCompletedAt = "2026-01-01T00:00:00.000Z"
        XCTAssertFalse(schedule.hasHistoryPending(cursor))
    }

    func testNoCatalogMeansNoHistory() {
        let schedule = AppleHealthSchedule(catalog: [], pageLimit: 2)
        XCTAssertFalse(schedule.hasHistoryPending(AppleHealthCursor.decode(from: nil)))
    }

    // MARK: - Collector

    /// A source with `total` pages of history, one page per pass, counting
    /// down in its cursor. `stuck` never moves the cursor; `cancelOnPage`
    /// expires the running task after building that page.
    final class HistorySource: OmnesisSource, @unchecked Sendable {
        let id = "mock:history"
        let displayName = "History"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        let total: Int
        let pagesPerPass: Int
        let stuck: Bool
        let cancelOnPage: Int?
        let throwCancellation: Bool
        private let lock = NSLock()
        private var calls = 0

        init(
            total: Int,
            pagesPerPass: Int = 1,
            stuck: Bool = false,
            cancelOnPage: Int? = nil,
            throwCancellation: Bool = false
        ) {
            self.total = total
            self.pagesPerPass = pagesPerPass
            self.stuck = stuck
            self.cancelOnPage = cancelOnPage
            self.throwCancellation = throwCancellation
        }

        var callCount: Int {
            lock.withLock { calls }
        }

        func left(_ cursor: SyncCursor?) -> Int {
            if case .int(let left) = cursor?["left"] { return Int(left) }
            return total
        }

        func hasHistoryPending(cursor: SyncCursor?) -> Bool {
            left(cursor) > 0
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            let call = lock.withLock {
                calls += 1
                return calls
            }
            if throwCancellation { throw CancellationError() }
            if stuck {
                return SyncResult(records: [], tableName: nil, cursor: cursor ?? [:], hasMore: false)
            }
            let left = max(0, left(cursor) - 1)
            if call == cancelOnPage {
                withUnsafeCurrentTask { $0?.cancel() }
            }
            return SyncResult(
                records: [["id": .string("r\(call)")]],
                tableName: "fixture_rows",
                cursor: ["left": .int(Int64(left))],
                hasMore: left > 0 && call % pagesPerPass != 0
            )
        }
    }

    /// A gateway that keeps the last cursor saved for each source and
    /// accepts every upload. While `cursorReads` holds a status, reading a
    /// cursor answers with it instead.
    private func gateway(
        _ session: CollectorCoreTests.MockSession,
        cursorReads: CursorReads = CursorReads()
    ) throws
        -> GatewayClient {
        let saved = SavedCursors()
        session.responder = { req in
            var status = 200
            var body = #"{"ok":true}"#
            if req.url?.path.hasPrefix("/sync-state/") == true {
                if req.httpMethod != "POST", let failure = cursorReads.failure {
                    status = failure
                    body = #"{"error":"unavailable"}"#
                } else if req.httpMethod == "POST", let data = req.httpBody {
                    saved.set(data)
                } else if let cursor = saved.get() {
                    body = #"{"cursor":"# + cursor + "}"
                } else {
                    status = 404
                    body = ""
                }
            }
            let http = HTTPURLResponse(
                url: req.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), http)
        }
        return try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )
    }

    final class CursorReads: @unchecked Sendable {
        private let lock = NSLock()
        private var status: Int?

        var failure: Int? {
            get { lock.withLock { status } }
            set { lock.withLock { status = newValue } }
        }
    }

    private final class SavedCursors: @unchecked Sendable {
        private let lock = NSLock()
        private var cursor: String?

        func set(_ body: Data) {
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let cursor = object["cursor"],
                  let data = try? JSONSerialization.data(withJSONObject: cursor) else { return }
            lock.withLock { self.cursor = String(data: data, encoding: .utf8) }
        }

        func get() -> String? {
            lock.withLock { cursor }
        }
    }

    private actor LifecycleRecorder {
        private(set) var events: [CollectorCore.Lifecycle] = []
        func record(_ event: CollectorCore.Lifecycle) {
            events.append(event)
        }
    }

    private func core(
        _ source: HistorySource,
        session: CollectorCoreTests.MockSession,
        recorder: LifecycleRecorder? = nil,
        cursorReads: CursorReads = CursorReads()
    ) throws
        -> (CollectorCore, OfflineBuffer) {
        let gateway = try gateway(session, cursorReads: cursorReads)
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            onLifecycle: { await recorder?.record($0) }
        )
        return (core, buffer)
    }

    func testReadsPassAfterPassUntilNoHistoryIsLeft() async throws {
        let session = CollectorCoreTests.MockSession()
        let source = HistorySource(total: 4)
        let (core, buffer) = try core(source, session: session)

        let before = await core.historyStatus(sourceId: source.id)
        XCTAssertEqual(before, .pending)
        let after = await core.readPendingHistory(sourceId: source.id)

        XCTAssertEqual(after, .finished)
        XCTAssertEqual(source.callCount, 4, "one page per pass, four passes")
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 0, "each pass drained what it read")
    }

    func testAPassThatDoesNotMoveTheCursorEndsTheRead() async throws {
        let session = CollectorCoreTests.MockSession()
        let source = HistorySource(total: 4, stuck: true)
        let (core, _) = try core(source, session: session)

        let status = await core.readPendingHistory(sourceId: source.id)

        XCTAssertEqual(status, .pending, "the history is still there for the next run")
        XCTAssertEqual(source.callCount, 1, "no second pass over a phone that can't read it")
    }

    func testASourceThisCoreDoesNotDriveHasNoHistory() async throws {
        let session = CollectorCoreTests.MockSession()
        let (core, _) = try core(HistorySource(total: 4), session: session)

        let status = await core.historyStatus(sourceId: "apple-health:local")
        XCTAssertEqual(status, .finished)
        let read = await core.readPendingHistory(sourceId: "apple-health:local")
        XCTAssertEqual(read, .finished)
    }

    /// A cursor that can't be read says nothing about the history: the
    /// run must not be taken as finished, or the processing task would
    /// withdraw its successor over one failed request.
    func testACursorThatCannotBeReadIsNotFinishedHistory() async throws {
        let session = CollectorCoreTests.MockSession()
        let cursorReads = CursorReads()
        cursorReads.failure = 503
        let source = HistorySource(total: 4)
        let (core, _) = try core(source, session: session, cursorReads: cursorReads)

        let status = await core.historyStatus(sourceId: source.id)
        let read = await core.readPendingHistory(sourceId: source.id)

        XCTAssertEqual(status, .unknown)
        XCTAssertEqual(read, .unknown)
        XCTAssertTrue(read.wantsHistoryRun, "the scheduled run stays")
        XCTAssertEqual(source.callCount, 0, "no pass without a cursor")

        // Once the gateway answers again, the read carries on.
        cursorReads.failure = nil
        let later = await core.readPendingHistory(sourceId: source.id)
        XCTAssertEqual(later, .finished)
        XCTAssertEqual(source.callCount, 4)
    }

    func testOnlyAFinishedHistoryWithdrawsTheRun() {
        XCTAssertTrue(CollectorCore.HistoryStatus.pending.wantsHistoryRun)
        XCTAssertTrue(CollectorCore.HistoryStatus.unknown.wantsHistoryRun)
        XCTAssertFalse(CollectorCore.HistoryStatus.finished.wantsHistoryRun)
    }

    /// iOS expiring the task stops the read before its next page. The
    /// pages already read are buffered with their cursor saved, the drain
    /// that every request would be cut off from is skipped, and the source
    /// ends idle rather than in error.
    func testAnExpiredTaskStopsAtAPageBoundary() async throws {
        let session = CollectorCoreTests.MockSession()
        let recorder = LifecycleRecorder()
        let source = HistorySource(total: 6, pagesPerPass: 6, cancelOnPage: 2)
        let (core, buffer) = try core(source, session: session, recorder: recorder)

        let status = await Task { await core.readPendingHistory(sourceId: source.id) }.value

        XCTAssertEqual(status, .pending)
        XCTAssertEqual(source.callCount, 2, "no page after the task was expired")
        let saved = session.calls.filter { $0.method == "POST" && $0.url.contains("/sync-state/") }
        XCTAssertEqual(saved.count, 2, "both pages' cursors saved")
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 2, "both pages buffered for the next drain")
        XCTAssertFalse(session.calls.contains { $0.url.hasSuffix("/analytics/ingest") })
        let lastSync = await core.lastSync(sourceId: source.id)
        XCTAssertNil(lastSync)
        let events = await recorder.events
        guard case .idle = events.last else {
            return XCTFail("An expired pass ends idle: \(events)")
        }
    }

    /// The same expiry arriving inside a source's read, as the
    /// `CancellationError` a cancelled task throws.
    func testCancellationInsideAReadIsNotASyncError() async throws {
        let session = CollectorCoreTests.MockSession()
        let recorder = LifecycleRecorder()
        let source = HistorySource(total: 2, throwCancellation: true)
        let (core, _) = try core(source, session: session, recorder: recorder)

        let summary = await core.sync(sourceId: source.id)

        XCTAssertNil(summary?.error)
        let events = await recorder.events
        XCTAssertFalse(events.contains { if case .error = $0 { true } else { false } }, "\(events)")
    }
}
