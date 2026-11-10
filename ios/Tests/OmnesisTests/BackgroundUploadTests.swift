// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What the background-upload suites share: a buffer directory, a fake
/// system queue, and fixture batches.
class BackgroundUploadTestCase: XCTestCase {
    var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-background-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    let sourceId = "mock:fixture"

    func buffer(_ dir: URL? = nil) -> OfflineBuffer {
        OfflineBuffer(
            directory: dir ?? directory,
            config: OfflineBuffer.Config(
                maxSizeBytes: 1_000_000,
                warningSizeBytes: 500_000,
                quarantineAfterAttempts: 2,
                quarantineGrace: 0,
                maxQuarantinedBatches: 25
            )
        )
    }

    /// A gateway answering every request with `status` and `body`.
    func gateway(
        _ session: CollectorCoreTests.MockSession,
        status: Int = 200,
        body: String = #"{"ingested":1}"#
    ) throws
        -> GatewayClient {
        session.responder = { req in
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

    func uploader(
        _ buffer: OfflineBuffer,
        gateway: GatewayClient,
        transport: FakeBackgroundTransport,
        switches: BackgroundSwitches
    )
        -> Uploader {
        Uploader(
            gateway: gateway,
            buffer: buffer,
            background: BackgroundUploads(
                transport: transport,
                isEnabled: { switches.enabled },
                protectedDataAvailable: { switches.unlocked }
            )
        )
    }

    let fixtureRows: [[String: JSONValue]] = [["id": .string("r1"), "label": .string("alpha")]]

    func rowsBatch() -> Batch {
        batch(records: fixtureRows)
    }

    func batch(
        tableName: String? = "fixture_rows",
        records: [[String: JSONValue]] = [],
        deletedIds: [String] = [],
        documents: [DocumentInput] = []
    )
        -> Batch {
        Batch(
            id: Batch.makeId(),
            sourceId: sourceId,
            tableName: tableName,
            records: records,
            schema: nil,
            deletedIds: deletedIds,
            documents: documents,
            createdAt: Date()
        )
    }

    func document(_ externalId: String) -> DocumentInput {
        DocumentInput(
            providerId: sourceId,
            sourceId: sourceId,
            externalId: externalId,
            title: "Fixture",
            content: "alpha",
            contentHash: DocumentInput.computeContentHash("alpha"),
            metadata: DocumentMetadata(documentType: "note", tags: []),
            sourceCreatedAt: "2026-01-01T00:00:00.000Z",
            sourceUpdatedAt: "2026-01-01T00:00:00.000Z"
        )
    }

    func ingestCalls(_ session: CollectorCoreTests.MockSession) -> Int {
        session.calls.filter { $0.url.hasSuffix("/analytics/ingest") || $0.url.hasSuffix("/documents") }.count
    }

    func json(_ body: Data?) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? NSDictionary)
    }

    func outboxFiles() -> [String] {
        let outbox = directory.appendingPathComponent("outbox")
        return (try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? []
    }

    func complete(
        _ uploader: Uploader,
        transport: FakeBackgroundTransport,
        tag: String,
        status: Int,
        body: String
    ) async {
        transport.end(tag)
        await uploader.finishBackgroundUpload(BackgroundUploadCompletion(
            tag: tag, outcome: .response(status: status, body: Data(body.utf8))
        ))
    }
}

/// The system queue as a list: it reads each body when the task is made,
/// and holds the task until the test finishes it.
final class FakeBackgroundTransport: BackgroundUploadTransport, @unchecked Sendable {
    struct Started {
        let request: URLRequest
        let body: Data
        let tag: String
    }

    private let lock = NSLock()
    private var startedList: [Started] = []
    private var liveTags: Set<String> = []

    var started: [Started] {
        lock.withLock { startedList }
    }

    func upload(_ request: URLRequest, fromFile file: URL, tag: String) {
        let body = (try? Data(contentsOf: file)) ?? Data()
        lock.withLock {
            startedList.append(Started(request: request, body: body, tag: tag))
            liveTags.insert(tag)
        }
    }

    func pendingTags() async -> Set<String> {
        lock.withLock { liveTags }
    }

    func cancelAll() async {
        lock.withLock { liveTags = [] }
    }

    /// The task left the system's queue.
    func end(_ tag: String) {
        _ = lock.withLock { liveTags.remove(tag) }
    }
}

final class BackgroundSwitches: @unchecked Sendable {
    private let lock = NSLock()
    private var enabledValue = true
    private var unlockedValue = true

    var enabled: Bool {
        get { lock.withLock { enabledValue } }
        set { lock.withLock { enabledValue = newValue } }
    }

    var unlocked: Bool {
        get { lock.withLock { unlockedValue } }
        set { lock.withLock { unlockedValue = newValue } }
    }
}

/// Handing one-request batches to the system's background upload queue:
/// which batches go, that what goes is the foreground request, and that a handed-off batch is left to its task.
final class BackgroundUploadTests: BackgroundUploadTestCase {
    // MARK: - Which batches go

    func testTheSettingIsOffUntilTurnedOn() {
        XCTAssertFalse(BackgroundUploadSettings.isEnabled(DictionaryDefaults()))
        let on = DictionaryDefaults(values: [BackgroundUploadSettings.enabledKey: true])
        XCTAssertTrue(BackgroundUploadSettings.isEnabled(on))
    }

    func testOnlyBatchesThatAreOneRequestGo() {
        let rows = rowsBatch()
        XCTAssertEqual(BackgroundUploadEndpoint(batch: rows), .analytics)

        let docs = batch(tableName: nil, documents: [document("d1")])
        XCTAssertEqual(BackgroundUploadEndpoint(batch: docs), .documents)

        let rowsAndDocs = batch(records: fixtureRows, documents: [document("d1")])
        XCTAssertNil(BackgroundUploadEndpoint(batch: rowsAndDocs), "documents must land after their rows")

        let rowDeletion = batch(deletedIds: ["r1"])
        XCTAssertNil(BackgroundUploadEndpoint(batch: rowDeletion), "deletions need the replica lease")

        let docDeletion = batch(tableName: nil, deletedIds: ["d1"])
        XCTAssertNil(BackgroundUploadEndpoint(batch: docDeletion))

        let empty = batch()
        XCTAssertNil(BackgroundUploadEndpoint(batch: empty))
    }

    func testTagsSurviveTheirDescription() {
        let tag = BackgroundUploadTag(batchId: "20260101T000000000-abcdef01", endpoint: .documents)
        XCTAssertEqual(BackgroundUploadTag(tag.description), tag)
        XCTAssertNil(BackgroundUploadTag("no-separators"))
        XCTAssertNil(BackgroundUploadTag("id|/elsewhere|attempt"))
    }

    func testWithTheSettingOffTheDrainIsUnchanged() async throws {
        let session = CollectorCoreTests.MockSession()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let transport = FakeBackgroundTransport()
        let switches = BackgroundSwitches()
        switches.enabled = false

        let stats = try await uploader(buf, gateway: gateway(session), transport: transport, switches: switches).drain()

        XCTAssertEqual(stats.uploaded, 1)
        XCTAssertEqual(stats.handedOff, 0)
        XCTAssertTrue(transport.started.isEmpty)
        XCTAssertEqual(ingestCalls(session), 1)
    }

    /// Nothing is written for the background queue while the phone is
    /// locked: the batch takes the foreground path, exactly as before.
    func testALockedPhoneHandsNothingOff() async throws {
        let session = CollectorCoreTests.MockSession()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let transport = FakeBackgroundTransport()
        let switches = BackgroundSwitches()
        switches.unlocked = false

        let stats = try await uploader(buf, gateway: gateway(session), transport: transport, switches: switches).drain()

        XCTAssertEqual(stats.uploaded, 1)
        XCTAssertTrue(transport.started.isEmpty)
        XCTAssertTrue(outboxFiles().isEmpty)
    }

    // MARK: - Handing off

    func testAHandedOffBatchCarriesTheForegroundRequest() async throws {
        let batch = rowsBatch()

        // What the foreground drain sends for this batch.
        let foregroundSession = CollectorCoreTests.MockSession()
        let otherDirectory = directory.appendingPathComponent("foreground")
        let foregroundBuffer = buffer(otherDirectory)
        try await foregroundBuffer.enqueue(batch)
        _ = try await Uploader(gateway: gateway(foregroundSession), buffer: foregroundBuffer).drain()
        let sent = try XCTUnwrap(foregroundSession.calls.first { $0.url.hasSuffix("/analytics/ingest") })

        let session = CollectorCoreTests.MockSession()
        let buf = buffer()
        try await buf.enqueue(batch)
        let transport = FakeBackgroundTransport()
        let stats = try await uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
            .drain()

        XCTAssertEqual(stats.handedOff, 1)
        XCTAssertEqual(stats.remaining, 1, "queued until its result is in")
        XCTAssertEqual(DrainOutcome(stats), .sending)
        XCTAssertEqual(ingestCalls(session), 0)
        let started = try XCTUnwrap(transport.started.first)
        // The same JSON, not the same bytes: key order isn't stable from one
        // encode of a dictionary to the next.
        XCTAssertEqual(try json(started.body), try json(sent.body))
        XCTAssertEqual(started.request.url?.absoluteString, sent.url)
        XCTAssertEqual(started.request.httpMethod, "POST")
        XCTAssertEqual(started.request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_test")
        XCTAssertEqual(started.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let marks = try await buf.backgroundUploadMarks()
        XCTAssertEqual(marks[batch.id], BackgroundUploadMark(tag: started.tag, sourceId: sourceId))
        XCTAssertEqual(outboxFiles().count, 1)
        XCTAssertTrue(outboxFiles().allSatisfy { !$0.hasSuffix(".json") }, "the queue scan must not claim it")
    }

    func testAHandedOffBatchIsLeftToItsTask() async throws {
        let session = CollectorCoreTests.MockSession()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let transport = FakeBackgroundTransport()
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())

        _ = try await up.drain()
        let again = try await up.drain()

        XCTAssertEqual(transport.started.count, 1, "no second task")
        XCTAssertEqual(ingestCalls(session), 0, "no foreground copy")
        XCTAssertEqual(again.inBackground, 1)
        XCTAssertEqual(again.handedOff, 0)
        XCTAssertEqual(DrainOutcome(again), .sending)
    }

    func testIneligibleBatchesStillGoInTheForeground() async throws {
        let session = CollectorCoreTests.MockSession()
        let buf = buffer()
        try await buf.enqueue(batch(records: fixtureRows, documents: [document("d1")]))
        let transport = FakeBackgroundTransport()

        let stats = try await uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
            .drain()

        XCTAssertEqual(stats.uploaded, 1)
        XCTAssertTrue(transport.started.isEmpty)
    }
}

/// A background upload's result — after a relaunch, lost, stale, or any
/// verdict — lands as the foreground drain would have it.
final class BackgroundUploadResultTests: BackgroundUploadTestCase {
    func testAResultAfterARelaunchSettlesTheBatch() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        try await buffer().enqueue(rowsBatch())
        _ = try await uploader(buffer(), gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        // A new process: fresh buffer and uploader over the same directory.
        let buf = buffer()
        let relaunched = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        await complete(relaunched, transport: transport, tag: tag, status: 200, body: #"{"ingested":1}"#)

        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 0)
        let marks = try await buf.backgroundUploadMarks()
        XCTAssertTrue(marks.isEmpty)
        XCTAssertTrue(outboxFiles().isEmpty)
        XCTAssertEqual(ingestCalls(session), 0)
    }

    /// A task the system no longer holds, with no result recorded, hands its
    /// batch back: the next drain sends it again.
    func testABatchWhoseTaskWasLostIsSentAgain() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        try await buffer().enqueue(rowsBatch())
        _ = try await uploader(buffer(), gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let lost = try XCTUnwrap(transport.started.first?.tag)
        transport.end(lost)

        let buf = buffer()
        let switches = BackgroundSwitches()
        switches.enabled = false
        let stats = try await uploader(buf, gateway: gateway(session), transport: transport, switches: switches).drain()

        XCTAssertEqual(stats.uploaded, 1, "sent again in the foreground")
        XCTAssertEqual(stats.inBackground, 0)
        XCTAssertTrue(outboxFiles().isEmpty)
    }

    func testALostTaskIsHandedOffAgainWhenTheSettingIsOn() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        _ = try await up.drain()
        let lost = try XCTUnwrap(transport.started.first?.tag)
        transport.end(lost)

        let stats = try await up.drain()

        XCTAssertEqual(stats.handedOff, 1)
        XCTAssertEqual(transport.started.count, 2)
        XCTAssertNotEqual(transport.started.last?.tag, lost)
        XCTAssertEqual(outboxFiles().count, 1, "only the new task's file")
    }

    /// A result for a hand-off the batch's mark no longer names — from
    /// before a re-pair, or a superseded attempt — changes nothing.
    func testAStaleResultChangesNothing() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        let batch = rowsBatch()
        try await buf.enqueue(batch)
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        _ = try await up.drain()
        let current = try XCTUnwrap(transport.started.first?.tag)
        let stale = BackgroundUploadTag(batchId: batch.id, endpoint: .analytics).description

        await complete(up, transport: transport, tag: stale, status: 400, body: "{}")
        await complete(up, transport: transport, tag: stale, status: 400, body: "{}")
        let paused = #"{"ingested":0,"rejected":[{"sourceId":"mock:fixture","reason":"removed"}]}"#
        await complete(up, transport: transport, tag: stale, status: 200, body: paused)

        let marks = try await buf.backgroundUploadMarks()
        XCTAssertEqual(marks[batch.id]?.tag, current)
        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1)
        let quarantined = try await buf.quarantinedCount()
        XCTAssertEqual(quarantined, 0)
        let stats = try await up.drain()
        XCTAssertTrue(stats.rejected.isEmpty)
    }

    func testNoAnswerQueuesTheBatchAgain() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        _ = try await up.drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        transport.end(tag)
        await up.finishBackgroundUpload(BackgroundUploadCompletion(tag: tag, outcome: .failed))

        let marks = try await buf.backgroundUploadMarks()
        XCTAssertTrue(marks.isEmpty)
        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1)
        XCTAssertTrue(outboxFiles().isEmpty)
    }

    /// Every status the foreground drain is checked against, delivered as a
    /// background result instead, ends the same way.
    func testEveryVerdictActsAsInTheForeground() async throws {
        for item in DeliveryClassificationTests.statusCases {
            let label = "\(item.status) \(item.body)"
            let dir = directory.appendingPathComponent(UUID().uuidString)
            let session = CollectorCoreTests.MockSession()
            let transport = FakeBackgroundTransport()
            let buf = buffer(dir)
            try await buf.enqueue(rowsBatch())
            // The foreground answers alike, for the batches that fall back to it.
            let up = try uploader(
                buf,
                gateway: gateway(session, status: item.status, body: item.body),
                transport: transport,
                switches: BackgroundSwitches()
            )

            for _ in 0 ..< 2 {
                do {
                    _ = try await up.drain()
                } catch GatewayClient.Error.unauthorized {
                    XCTAssertEqual(item.verdict, .reauthorize, label)
                    break
                }
                guard let tag = transport.started.last?.tag else { break }
                await complete(up, transport: transport, tag: tag, status: item.status, body: item.body)
            }

            let remaining = try await buf.count()
            let quarantined = try await buf.quarantinedCount()
            switch item.verdict {
            case .reauthorize:
                XCTAssertEqual(remaining, 1, label)
                XCTAssertEqual(transport.started.count, 1, "the 401 surfaces before another hand-off: \(label)")
            case .blocked:
                // The 403'd source falls back to the foreground drain, which
                // reports it the usual way and keeps the batch.
                let stats = try await up.drain()
                XCTAssertEqual(stats.blocked, [sourceId], label)
                XCTAssertEqual(remaining, 1, label)
                XCTAssertEqual(quarantined, 0, label)
            case .refuse:
                XCTAssertEqual(quarantined, 1, label)
                XCTAssertEqual(remaining, 0, label)
            case .retry:
                XCTAssertEqual(quarantined, 0, label)
                XCTAssertEqual(remaining, 1, label)
                XCTAssertEqual(transport.started.count, 2, "handed off again: \(label)")
            }
        }
    }

    func testARemovedSourceDropsTheBatchAndIsReported() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        _ = try await up.drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        let removed = #"{"ingested":0,"rejected":[{"sourceId":"mock:fixture","reason":"removed"}]}"#
        await complete(up, transport: transport, tag: tag, status: 200, body: removed)

        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 0)
        let stats = try await up.drain()
        XCTAssertEqual(stats.rejected, [PushRejection(sourceId: sourceId, reason: "removed")])
    }

    func testAPausedSourceKeepsTheBatchAndIsReported() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        let switches = BackgroundSwitches()
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: switches)
        _ = try await up.drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        let paused = #"{"ingested":0,"rejected":[{"sourceId":"mock:fixture","reason":"paused"}]}"#
        await complete(up, transport: transport, tag: tag, status: 200, body: paused)

        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1)
        let marks = try await buf.backgroundUploadMarks()
        XCTAssertTrue(marks.isEmpty)
        switches.unlocked = false
        session.responder = nil
        let stats = try await up.drain()
        XCTAssertTrue(stats.rejected.contains(PushRejection(sourceId: sourceId, reason: "paused")))
    }

    /// A paused answer whose result arrives while the record of hand-offs
    /// can't be read (a locked phone, in a process that hasn't read it
    /// yet). Without the mark the answer can't be told from a delivery, so
    /// nothing is removed.
    func testAPausedAnswerWithAnUnreadableRecordKeepsTheBatch() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let first = buffer()
        try await first.enqueue(rowsBatch())
        _ = try await uploader(first, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        // A relaunched process, before it has read the record.
        let record = directory.appendingPathComponent("background-uploads.state")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: record.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path) }
        let relaunched = buffer()
        let up = try uploader(relaunched, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        let paused = #"{"ingested":0,"rejected":[{"sourceId":"mock:fixture","reason":"paused"}]}"#
        await complete(up, transport: transport, tag: tag, status: 200, body: paused)

        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
        let remaining = try await buffer().count()
        XCTAssertEqual(remaining, 1, "an answer that can't be attributed deletes nothing")
        let marks = try await buffer().backgroundUploadMarks()
        XCTAssertEqual(marks.count, 1, "the hand-off is still recorded")
    }

    /// The same answer when the record reads as empty (unrecognised): the
    /// batch itself names its source, so the rejection is still matched.
    func testAPausedAnswerWithoutAMarkIsAttributedByTheBatch() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let first = buffer()
        try await first.enqueue(rowsBatch())
        _ = try await uploader(first, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        let record = directory.appendingPathComponent("background-uploads.state")
        try Data("not a record".utf8).write(to: record)
        let relaunched = buffer()
        let up = try uploader(relaunched, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        let paused = #"{"ingested":0,"rejected":[{"sourceId":"mock:fixture","reason":"paused"}]}"#
        await complete(up, transport: transport, tag: tag, status: 200, body: paused)

        let remaining = try await relaunched.count()
        XCTAssertEqual(remaining, 1, "a paused source's batch is kept")
    }

    /// A batch that leaves the queue another way takes its mark with it.
    func testRemovingABatchClearsItsMark() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        let batch = rowsBatch()
        try await buf.enqueue(batch)
        _ = try await uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()

        try await buf.remove(id: batch.id)

        let marks = try await buf.backgroundUploadMarks()
        XCTAssertTrue(marks.isEmpty)
    }

    /// Re-pairing cancels every task; whatever they report afterwards finds
    /// no hand-off of theirs in the new pairing's buffer.
    func testResultsFromBeforeARepairAreIgnored() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let old = buffer()
        try await old.enqueue(rowsBatch())
        _ = try await uploader(old, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let tag = try XCTUnwrap(transport.started.first?.tag)

        await transport.cancelAll()
        old.invalidate()
        try FileManager.default.removeItem(at: directory)
        let fresh = buffer()
        let next = rowsBatch()
        try await fresh.enqueue(next)
        let up = try uploader(fresh, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        await up.finishBackgroundUpload(BackgroundUploadCompletion(tag: tag, outcome: .failed))
        await complete(up, transport: transport, tag: tag, status: 401, body: "{}")

        let stats = try await up.drain()
        XCTAssertEqual(stats.handedOff, 1, "the 401 belonged to the old pairing")
        let remaining = try await fresh.count()
        XCTAssertEqual(remaining, 1)
    }
}
