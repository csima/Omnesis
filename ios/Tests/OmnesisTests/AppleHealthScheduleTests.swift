// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

private struct FakeSample {
    let id: String
    let seq: Int
    let start: Date
}

/// A wake has seconds, and a phone's history takes many wakes to read. The
/// schedule makes each wake bring every type's recent samples up to date
/// first, and spends what is left on the history, without ever skipping a
/// sample. These tests drive it against an in-memory stand-in for HealthKit
/// whose anchored reads behave like `HKAnchoredObjectQuery`: insertion
/// order, a page limit, an optional start-date filter.
final class AppleHealthScheduleTests: XCTestCase {
    /// Sample ids per type, in insertion order, each with a start date.
    fileprivate final class FakeStore {
        private(set) var samples: [String: [FakeSample]] = [:]
        private var nextSeq = 1

        func insert(_ type: String, id: String, start: Date) {
            samples[type, default: []].append(FakeSample(id: id, seq: nextSeq, start: start))
            nextSeq += 1
        }

        func allIds() -> Set<String> {
            Set(samples.values.flatMap { $0.map(\.id) })
        }

        /// One anchored read: samples inserted after `anchor`, oldest
        /// first, matching `since` when given, at most `limit`.
        func read(_ request: AppleHealthRead, limit: Int) -> (ids: [String], outcome: AppleHealthReadOutcome) {
            let (anchor, since): (String?, Date?) = switch request {
            case .complete(_, let anchor): (anchor, nil)
            case .recent(_, let anchor, let since): (anchor, since)
            }
            let after = anchor.flatMap(Int.init) ?? 0
            let matching = (samples[request.identifier] ?? [])
                .filter { sample in sample.seq > after && (since.map { sample.start >= $0 } ?? true) }
            let page = Array(matching.prefix(limit))
            let newAnchor = page.last.map { String($0.seq) } ?? anchor ?? "0"
            return (
                page.map(\.id),
                AppleHealthReadOutcome(returned: page.count, isEmpty: page.isEmpty, newAnchor: newAnchor)
            )
        }
    }

    struct WakeResult {
        var uploaded: [String]
        var cursor: AppleHealthCursor
        var finished: Bool
        var pages: Int
        var batches: Int
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let types = ["TypeA", "TypeB", "TypeC"]
    private let day: TimeInterval = 24 * 60 * 60

    private func schedule(limit: Int = 10) -> AppleHealthSchedule {
        AppleHealthSchedule(catalog: types, pageLimit: limit, recentWindow: 7 * day)
    }

    /// Fills each type with `old` samples from long ago and then `recent`
    /// samples from the last day, in that insertion order.
    private func store(old: Int, recent: Int) -> FakeStore {
        let store = FakeStore()
        for type in types {
            for index in 0 ..< old {
                store.insert(type, id: "\(type)-old-\(index)", start: now.addingTimeInterval(-400 * day))
            }
            for index in 0 ..< recent {
                store.insert(type, id: "\(type)-new-\(index)", start: now.addingTimeInterval(-day))
            }
        }
        return store
    }

    /// One wake: a new pass that makes at most `pages` pages, as the
    /// collector does when its budget runs out. Returns the uploaded ids
    /// and the cursor it would have saved.
    private func wake(
        _ schedule: AppleHealthSchedule,
        _ store: FakeStore,
        cursor: AppleHealthCursor,
        pages: Int,
        at time: Date? = nil
    ) async throws
        -> WakeResult {
        let time = time ?? now
        var cursor = schedule.beginningPass(cursor, now: time)
        var uploaded: [String] = []
        var batches = 0
        for page in 1 ... pages {
            let next = try await schedule.nextPage(from: cursor, now: time) { request in
                let result = store.read(request, limit: schedule.pageLimit)
                return (result.ids, result.outcome)
            }
            cursor = next.cursor
            uploaded += next.page ?? []
            batches += next.page == nil ? 0 : 1
            if !next.hasMore {
                return WakeResult(uploaded: uploaded, cursor: cursor, finished: true, pages: page, batches: batches)
            }
        }
        return WakeResult(uploaded: uploaded, cursor: cursor, finished: false, pages: pages, batches: batches)
    }

    // MARK: - Recent first

    func testAFirstWakeBringsEveryTypesRecentSamplesBeforeItsHistory() async throws {
        let store = store(old: 200, recent: 3)
        let result = try await wake(schedule(), store, cursor: AppleHealthCursor(), pages: 4)

        for type in types {
            for index in 0 ..< 3 {
                XCTAssertTrue(result.uploaded.contains("\(type)-new-\(index)"), "\(type) recent sample \(index)")
            }
        }
        XCTAssertFalse(result.finished, "the history is still to come")
        XCTAssertNil(result.cursor.sweepIndex, "the sweep is done; the rest of the wake went to the backfill")
        XCTAssertTrue(result.uploaded.contains("TypeA-old-0"), "the leftover page started the history")
    }

    func testATypeThatHadItsTurnStaysCurrentWhileTheBackfillRuns() async throws {
        let store = store(old: 60, recent: 0)
        let schedule = schedule()
        var cursor = AppleHealthCursor()
        // Three short wakes read TypeA's and TypeB's history; TypeC's is
        // still part-way.
        for _ in 0 ..< 3 {
            cursor = try await wake(schedule, store, cursor: cursor, pages: 5).cursor
        }
        store.insert("TypeA", id: "TypeA-later", start: now)
        store.insert("TypeC", id: "TypeC-later", start: now)

        XCTAssertEqual(cursor.caughtUp, ["TypeA", "TypeB"])
        let next = try await wake(schedule, store, cursor: cursor, pages: 2)

        XCTAssertTrue(next.uploaded.contains("TypeA-later"))
        XCTAssertTrue(next.uploaded.contains("TypeC-later"))
    }

    func testTypesWithNothingNewCostNoPage() async throws {
        let store = store(old: 3, recent: 0)
        let schedule = schedule()
        let first = try await wake(schedule, store, cursor: AppleHealthCursor(), pages: 50)
        XCTAssertTrue(first.finished)
        store.insert("TypeB", id: "TypeB-later", start: now)

        let second = try await wake(schedule, store, cursor: first.cursor, pages: 50)

        XCTAssertEqual(second.uploaded, ["TypeB-later"])
        XCTAssertTrue(second.finished)
        XCTAssertEqual(second.batches, 1, "one batch for the one type with something new")
        XCTAssertEqual(second.pages, 2, "and one empty page that ends the sweep, instead of one per type")
    }

    func testASweepReadsAFullTypeToItsEndBeforeMovingOn() async throws {
        let store = store(old: 0, recent: 25)
        let result = try await wake(schedule(limit: 10), store, cursor: AppleHealthCursor(), pages: 3)

        XCTAssertEqual(result.uploaded.count(where: { $0.hasPrefix("TypeA-") }), 25)
        XCTAssertFalse(result.uploaded.contains { $0.hasPrefix("TypeB-") })
    }

    // MARK: - Nothing is skipped

    func testEverySampleArrivesAcrossShortWakesWithInsertionsBetween() async throws {
        let store = store(old: 73, recent: 4)
        let schedule = schedule(limit: 7)
        var cursor = AppleHealthCursor()
        var uploaded = Set<String>()
        var finished = false
        for wakeIndex in 0 ..< 200 where !finished {
            if wakeIndex % 3 == 0 {
                let type = types[wakeIndex % types.count]
                // Some new samples start inside the recent window, some are
                // backdated imports that only the complete read can see.
                let start = wakeIndex % 2 == 0 ? now : now.addingTimeInterval(-90 * day)
                store.insert(type, id: "\(type)-w\(wakeIndex)", start: start)
            }
            let result = try await wake(schedule, store, cursor: cursor, pages: 1 + wakeIndex % 4)
            uploaded.formUnion(result.uploaded)
            cursor = result.cursor
            finished = result.finished && wakeIndex > 60
        }

        XCTAssertTrue(finished)
        XCTAssertEqual(uploaded, store.allIds(), "no sample is skipped")
        XCTAssertEqual(cursor.caughtUp, Set(types))
        XCTAssertTrue(cursor.recentAnchorsByIdentifier.isEmpty, "recent reads end once a type catches up")
        XCTAssertNotNil(cursor.lastCycleCompletedAt)
    }

    func testABackdatedImportIsReadByTheCompleteRead() async throws {
        let store = store(old: 0, recent: 1)
        let schedule = schedule()
        let first = try await wake(schedule, store, cursor: AppleHealthCursor(), pages: 50)
        store.insert("TypeB", id: "TypeB-imported", start: now.addingTimeInterval(-900 * day))

        let second = try await wake(schedule, store, cursor: first.cursor, pages: 50)

        XCTAssertEqual(second.uploaded, ["TypeB-imported"])
    }

    // MARK: - Migration

    func testACursorFromMidwayThroughTheFirstCycleCarriesOn() async throws {
        let store = store(old: 30, recent: 0)
        let schedule = schedule()
        // The old rotation finished TypeA and read two pages of TypeB.
        let old = AppleHealthCursor(
            cycleIndex: 1,
            anchorsByIdentifier: ["TypeA": "30", "TypeB": "50"]
        )
        let migrated = AppleHealthCursor.decode(from: old.encode())
        XCTAssertNil(migrated.caughtUp, "an old cursor has no caughtUp field")

        var requests: [AppleHealthRead] = []
        var cursor = schedule.beginningPass(migrated, now: now)
        XCTAssertEqual(cursor.caughtUp, ["TypeA"])
        for _ in 0 ..< 20 {
            let next = try await schedule.nextPage(from: cursor, now: now) { request in
                requests.append(request)
                let result = store.read(request, limit: schedule.pageLimit)
                return (result.ids, result.outcome)
            }
            cursor = next.cursor
            if !next.hasMore { break }
        }

        XCTAssertEqual(requests.first, .complete(identifier: "TypeA", anchor: "30"), "TypeA is not restarted")
        XCTAssertTrue(
            requests.contains(.complete(identifier: "TypeB", anchor: "50")),
            "TypeB's history resumes from its anchor"
        )
        XCTAssertFalse(requests.contains(.complete(identifier: "TypeB", anchor: nil)))
        XCTAssertEqual(cursor.caughtUp, Set(types))
    }

    func testACursorAfterAFullCycleIsAlreadyCaughtUp() async throws {
        let store = store(old: 5, recent: 0)
        let schedule = schedule()
        let old = AppleHealthCursor(
            cycleIndex: 0,
            anchorsByIdentifier: ["TypeA": "5", "TypeB": "10", "TypeC": "15"],
            lastCycleCompletedAt: "2026-11-01T00:00:00.000Z"
        )
        store.insert("TypeC", id: "TypeC-later", start: now)

        let result = try await wake(schedule, store, cursor: AppleHealthCursor.decode(from: old.encode()), pages: 50)

        XCTAssertEqual(result.uploaded, ["TypeC-later"])
        XCTAssertTrue(result.finished)
        XCTAssertTrue(result.cursor.recentAnchorsByIdentifier.isEmpty)
    }

    func testTheNewFieldsRoundTrip() {
        let cursor = AppleHealthCursor(
            cycleIndex: 2,
            anchorsByIdentifier: ["TypeA": "a"],
            lastCycleCompletedAt: nil,
            caughtUp: ["TypeA"],
            recentAnchorsByIdentifier: ["TypeB": "b"],
            recentSince: "2026-11-03T00:00:00.000Z",
            sweepIndex: 1
        )
        XCTAssertEqual(AppleHealthCursor.decode(from: cursor.encode()), cursor)
    }
}

/// The collector lets a source reset its plan once at the start of each
/// pass, which is how every Apple Health wake begins with a fresh sweep.
final class CollectorPassStartTests: XCTestCase {
    final class PassSource: OmnesisSource, @unchecked Sendable {
        let id = "mock:pass"
        let displayName = "Mock"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        private let lock = NSLock()
        private var received: [SyncCursor?] = []

        var cursorsReceived: [SyncCursor?] {
            lock.withLock { received }
        }

        func cursorForNewPass(_ cursor: SyncCursor?) -> SyncCursor? {
            var cursor = cursor ?? [:]
            cursor["step"] = .string("start")
            return cursor
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            let calls = lock.withLock {
                received.append(cursor)
                return received.count
            }
            return SyncResult(
                records: [],
                tableName: "fixture_rows",
                cursor: ["step": .string("page\(calls)")],
                hasMore: calls % 2 == 1
            )
        }
    }

    func testEachPassStartsFromTheSourcesNewPassCursor() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-pass-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = CollectorCoreTests.MockSession()
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
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let source = PassSource()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source]
        )

        _ = await core.sync(sourceId: source.id)
        _ = await core.sync(sourceId: source.id)

        let steps = source.cursorsReceived.map { cursor -> String? in
            if case .string(let step) = cursor?["step"] { step } else { nil }
        }
        XCTAssertEqual(steps, ["start", "page1", "start", "page3"])
    }
}
