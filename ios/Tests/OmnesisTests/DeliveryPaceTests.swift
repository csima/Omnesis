// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Reading never runs ahead of delivery. Every page the collector buffers
/// moves its source's cursor past samples that then exist only on the
/// phone, so a wake that reads pages it can't deliver, wake after wake,
/// leaves a growing backlog the gateway never sees. These run the real
/// collector, uploader and buffer against one clock that pages and uploads
/// both spend, as a short background wake does.
final class DeliveryPaceTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-pace-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Fixtures

    /// One background wake's time, spent by pages and uploads alike.
    final class WakeClock: ExecutionBudget, @unchecked Sendable {
        private let lock = NSLock()
        private var left: TimeInterval?

        /// A wake with `seconds` left, or the foreground with `nil`.
        func startWake(_ seconds: TimeInterval?) {
            lock.withLock { left = seconds }
        }

        func spend(_ seconds: TimeInterval) {
            lock.withLock { left = left.map { $0 - seconds } }
        }

        func remainingTime() async -> TimeInterval? {
            lock.withLock { left }
        }
    }

    /// A source with `total` pages of history, one row each, resuming from
    /// the anchor in its cursor. Each page read costs `pageCost` seconds.
    final class BackfillSource: OmnesisSource, @unchecked Sendable {
        let id: String
        let displayName = "Backfill"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        private let total: Int
        private let clock: WakeClock
        private let pageCost: TimeInterval
        private let lock = NSLock()
        private var reads = 0

        init(id: String = "mock:backfill", total: Int, clock: WakeClock, pageCost: TimeInterval) {
            self.id = id
            self.total = total
            self.clock = clock
            self.pageCost = pageCost
        }

        var readCount: Int {
            lock.withLock { reads }
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            lock.withLock { reads += 1 }
            clock.spend(pageCost)
            var done = 0
            if case .int(let anchor) = cursor?["anchor"] { done = Int(anchor) }
            let page = done + 1
            return SyncResult(
                records: [["id": .string("\(id)#\(page)")]],
                tableName: "pace_rows",
                cursor: ["anchor": .int(Int64(page))],
                hasMore: page < total
            )
        }
    }

    /// A gateway that keeps each source's saved cursor, and answers ingests
    /// with `ingestStatus` (per source), spending `uploadCost` on each.
    final class Gateway: @unchecked Sendable {
        let session = CollectorCoreTests.MockSession()
        private let lock = NSLock()
        private var cursors: [String: Data] = [:]
        private var events: [String] = []
        private(set) var ingestedRows: [String] = []
        var ingestStatus: @Sendable (String) -> Int = { _ in 200 }

        init(clock: WakeClock, uploadCost: TimeInterval) {
            session.responder = { [unowned self] request in
                try self.answer(request, clock: clock, uploadCost: uploadCost)
            }
        }

        var log: [String] {
            lock.withLock { events }
        }

        func savedAnchors(_ sourceId: String) -> [Int] {
            session.calls
                .filter { call in
                    call.method == "POST" && call.url.contains("/sync-state/")
                        && URL(string: call.url)?.lastPathComponent == sourceId
                }
                .compactMap { call -> Int? in
                    guard let body = call.body,
                          let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                          let cursor = object["cursor"] as? [String: Any] else { return nil }
                    return cursor["anchor"] as? Int
                }
        }

        func client() throws -> GatewayClient {
            try GatewayClient(
                baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
                token: "omn_test",
                session: session
            )
        }

        private func answer(
            _ request: URLRequest,
            clock: WakeClock,
            uploadCost: TimeInterval
        ) throws
            -> (Data, URLResponse) {
            let url = try XCTUnwrap(request.url)
            var status = 200
            var body = #"{"ok":true}"#
            if url.path.hasPrefix("/sync-state/") {
                let key = url.lastPathComponent
                if request.httpMethod == "POST", let data = request.httpBody,
                   let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let cursor = object["cursor"] {
                    lock.withLock {
                        cursors[key] = try? JSONSerialization.data(withJSONObject: cursor)
                        events.append("save")
                    }
                } else if let saved = lock.withLock({ cursors[key] }) {
                    body = #"{"cursor":"# + (String(bytes: saved, encoding: .utf8) ?? "null") + "}"
                } else {
                    status = 404
                    body = ""
                }
            } else if url.path == "/analytics/ingest" {
                clock.spend(uploadCost)
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
                )
                let sourceId = object["sourceId"] as? String ?? ""
                status = ingestStatus(sourceId)
                if status == 200 {
                    let rows = (object["records"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
                    lock.withLock {
                        ingestedRows += rows
                        events.append("ingest")
                    }
                    body = #"{"ingested":\#(rows.count)}"#
                }
            }
            let http = try XCTUnwrap(HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            ))
            return (Data(body.utf8), http)
        }
    }

    private func collector(
        _ gateway: Gateway,
        sources: [any OmnesisSource],
        clock: WakeClock,
        bufferBytes: Int = 1_000_000
    ) throws
        -> (CollectorCore, OfflineBuffer) {
        let client = try gateway.client()
        let buffer = OfflineBuffer(
            directory: directory,
            config: OfflineBuffer.Config(maxSizeBytes: bufferBytes, warningSizeBytes: bufferBytes / 2)
        )
        let core = CollectorCore(
            gateway: client,
            buffer: buffer,
            cursorStore: CursorStore(gateway: client),
            uploader: Uploader(gateway: client, buffer: buffer, budget: clock),
            sources: sources,
            budget: clock
        )
        return (core, buffer)
    }

    /// Rows still on the phone: queued in the buffer.
    private func queuedRows(_ buffer: OfflineBuffer) async throws -> [String] {
        var rows: [String] = []
        for id in try await buffer.listIds() {
            let batch = try await buffer.load(id: id)
            rows += batch?.records.compactMap { record -> String? in
                if case .string(let row) = record["id"] { return row }
                return nil
            } ?? []
        }
        return rows
    }

    // MARK: - Short wakes

    /// One short wake: reading stops while there's still time to upload
    /// what it read, and the pages it read reach the gateway in the same
    /// wake. The uploader spends the same clock as the reader.
    func testAShortWakeDeliversThePagesItReads() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 1)
        let source = BackfillSource(total: 10, clock: clock, pageCost: 3)
        let (core, buffer) = try collector(gateway, sources: [source], clock: clock)

        clock.startWake(20)
        let summary = await core.sync(sourceId: source.id)

        XCTAssertNil(summary?.error)
        let saved = gateway.savedAnchors(source.id)
        XCTAssertFalse(saved.isEmpty, "the wake reads something")
        XCTAssertEqual(
            gateway.ingestedRows,
            saved.map { "\(source.id)#\($0)" },
            "every page the wake read was delivered in it"
        )
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 0)
        XCTAssertEqual(summary?.uploaded, saved.count)
    }

    /// Wake after wake of a long backfill into a small buffer. Every row
    /// whose anchor was saved is either delivered or still queued; none is
    /// dropped to make room, and delivery keeps pace with reading.
    func testSustainedBackfillInShortWakesLosesNothing() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 1)
        let source = BackfillSource(total: 40, clock: clock, pageCost: 2)
        // Room for about three batches.
        let (core, buffer) = try collector(gateway, sources: [source], clock: clock, bufferBytes: 1500)

        for _ in 0 ..< 8 {
            clock.startWake(18)
            _ = await core.sync(sourceId: source.id)
        }

        let saved = gateway.savedAnchors(source.id)
        let lastAnchor = try XCTUnwrap(saved.last)
        XCTAssertGreaterThanOrEqual(lastAnchor, 8, "the backfill moves forward every wake")
        let delivered = gateway.ingestedRows
        let queued = try await queuedRows(buffer)
        XCTAssertEqual(
            Set(delivered + queued),
            Set((1 ... lastAnchor).map { "\(source.id)#\($0)" }),
            "every row behind the saved anchor is delivered or still on the phone"
        )
        XCTAssertGreaterThanOrEqual(delivered.count, lastAnchor - CollectorCore.maxUndeliveredBatches)
    }

    /// What an earlier wake left queued is sent before this wake reads.
    func testAWakeDeliversWhatIsQueuedBeforeItReads() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 1)
        let source = BackfillSource(total: 10, clock: clock, pageCost: 3)
        let (core, buffer) = try collector(gateway, sources: [source], clock: clock)
        try await buffer.enqueue(Batch(
            id: Batch.makeId(now: Date(timeIntervalSinceNow: -60)),
            sourceId: "mock:earlier",
            tableName: "pace_rows",
            records: [["id": .string("earlier#1")]],
            schema: nil,
            deletedIds: [],
            createdAt: Date()
        ))

        clock.startWake(18)
        _ = await core.sync(sourceId: source.id)

        XCTAssertEqual(gateway.log.first, "ingest", "the queued batch goes before the first page is saved")
        XCTAssertEqual(gateway.ingestedRows.first, "earlier#1")
    }

    // MARK: - Backlog

    /// With the gateway refusing for now, a source reads no more than a few
    /// pages ahead of delivery, and its anchor stays behind the rest.
    func testReadingStopsWhileASourcesBatchesAreUndelivered() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 0)
        gateway.ingestStatus = { _ in 503 }
        let source = BackfillSource(total: 20, clock: clock, pageCost: 0)
        let (core, buffer) = try collector(gateway, sources: [source], clock: clock)

        clock.startWake(nil)
        let summary = await core.sync(sourceId: source.id)

        XCTAssertNil(summary?.error, "a backlog pauses reading; it is not a sync error")
        XCTAssertEqual(source.readCount, CollectorCore.maxUndeliveredBatches)
        XCTAssertEqual(gateway.savedAnchors(source.id), Array(1 ... CollectorCore.maxUndeliveredBatches))
        let queued = try await buffer.count()
        XCTAssertEqual(queued, CollectorCore.maxUndeliveredBatches)

        // Once the gateway takes them, reading carries on from that anchor.
        gateway.ingestStatus = { _ in 200 }
        _ = await core.sync(sourceId: source.id)
        XCTAssertEqual(gateway.savedAnchors(source.id).last, 20)
        XCTAssertEqual(gateway.ingestedRows.count, 20)
    }

    /// Another source's undelivered batches don't hold this one back.
    func testAnotherSourcesBacklogDoesNotStopThisOne() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 0)
        // Refused for its scope: the drain skips it and carries on.
        gateway.ingestStatus = { $0 == "mock:stuck" ? 403 : 200 }
        let stuck = BackfillSource(id: "mock:stuck", total: 20, clock: clock, pageCost: 0)
        let source = BackfillSource(total: 6, clock: clock, pageCost: 0)
        let (core, _) = try collector(gateway, sources: [stuck, source], clock: clock)

        clock.startWake(nil)
        _ = await core.sync(sourceId: stuck.id)
        _ = await core.sync(sourceId: source.id)

        XCTAssertEqual(source.readCount, 6)
        XCTAssertEqual(gateway.ingestedRows, (1 ... 6).map { "\(source.id)#\($0)" })
    }

    /// A page that doesn't fit in the buffer is not buffered and its anchor
    /// is not saved; nothing already queued is dropped for it.
    func testAPageThatDoesNotFitLeavesItsAnchorAndDropsNothing() async throws {
        let clock = WakeClock()
        let gateway = Gateway(clock: clock, uploadCost: 0)
        gateway.ingestStatus = { _ in 503 }
        let source = BackfillSource(total: 20, clock: clock, pageCost: 0)
        // Room for two batches, under the backlog bound.
        let (core, buffer) = try collector(gateway, sources: [source], clock: clock, bufferBytes: 700)

        clock.startWake(nil)
        let summary = await core.sync(sourceId: source.id)

        XCTAssertNil(summary?.error)
        let saved = gateway.savedAnchors(source.id)
        let queued = try await queuedRows(buffer)
        XCTAssertLessThan(saved.count, CollectorCore.maxUndeliveredBatches, "the buffer filled first")
        XCTAssertEqual(
            queued.sorted(),
            saved.map { "\(source.id)#\($0)" }.sorted(),
            "every saved anchor's row is still queued"
        )
    }
}
