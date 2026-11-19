// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Delivery stays in order per source. The system finishes background
/// tasks in no particular order, so while a batch of a source is with it,
/// that source's later batches wait: a deletion sent ahead of the insert
/// it follows would be undone when the insert lands.
final class BackgroundUploadOrderTests: BackgroundUploadTestCase {
    func testADeletionWaitsForTheBackgroundInsertBeforeIt() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        try await buf.enqueue(rowsBatch())
        _ = try await up.drain()
        let insert = try XCTUnwrap(transport.started.first?.tag)

        let deletion = batch(deletedIds: ["r1"])
        try await buf.enqueue(deletion)
        let held = try await up.drain()

        XCTAssertTrue(session.calls.isEmpty, "nothing sent while the insert is with the system: \(session.calls)")
        XCTAssertEqual(held.inBackground, 2)
        XCTAssertEqual(held.handedOff, 0)
        XCTAssertEqual(DrainOutcome(held), .sending, "waiting behind a background upload is not stalled")

        await complete(up, transport: transport, tag: insert, status: 200, body: #"{"ingested":1}"#)
        let after = try await up.drain()

        // A deletion starts by asking for the replica lease.
        XCTAssertTrue(
            session.calls.contains { $0.url.hasSuffix("/lease") },
            "the deletion goes once the insert has landed: \(session.calls)"
        )
        XCTAssertEqual(after.inBackground, 0)
    }

    /// Two inserts of one source are no more ordered by the system than an
    /// insert and a deletion: one at a time.
    func testOneBatchOfASourceIsWithTheSystemAtATime() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
        try await buf.enqueue(rowsBatch())
        try await buf.enqueue(batch(records: [["id": .string("r1"), "label": .string("beta")]]))

        let first = try await up.drain()

        XCTAssertEqual(first.handedOff, 1)
        XCTAssertEqual(first.inBackground, 1, "the second waits")
        XCTAssertEqual(transport.started.count, 1)
        XCTAssertEqual(ingestCalls(session), 0)

        let tag = try XCTUnwrap(transport.started.first?.tag)
        await complete(up, transport: transport, tag: tag, status: 200, body: #"{"ingested":1}"#)
        let second = try await up.drain()

        XCTAssertEqual(second.handedOff, 1)
        XCTAssertEqual(transport.started.count, 2)
    }

    /// A batch whose task was lost goes back to the foreground; if that
    /// retry fails, it still comes before the rest of its source, so
    /// nothing later of that source is sent in the same pass.
    func testAFailedRetryOfALostTaskHoldsTheSourcesLaterBatches() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let switches = BackgroundSwitches()
        let buf = buffer()
        let up = try uploader(buf, gateway: gateway(session), transport: transport, switches: switches)
        try await buf.enqueue(rowsBatch())
        _ = try await up.drain()
        try transport.end(XCTUnwrap(transport.started.first?.tag))
        let deletion = batch(deletedIds: ["r1"])
        try await buf.enqueue(deletion)
        // Locked, so the insert retries in the foreground, where only it fails.
        switches.unlocked = false
        session.responder = { req in
            let insert = req.httpBody.flatMap { String(bytes: $0, encoding: .utf8) }?.contains("alpha") ?? false
            let status = req.url?.path.hasSuffix("/lease") == true ? 404 : insert ? 503 : 200
            let http = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"ingested":1}"#.utf8), http)
        }

        let stats = try await up.drain()

        XCTAssertEqual(ingestCalls(session), 1, "only the insert was tried: \(session.calls.map(\.url))")
        XCTAssertFalse(session.calls.contains { $0.url.hasSuffix("/lease") }, "the deletion waited")
        XCTAssertEqual(stats.failed, 1)
        XCTAssertEqual(stats.uploaded, 0)
        let left = try await buf.load(id: deletion.id)
        XCTAssertNotNil(left)
    }

    /// A record that reads but doesn't decode says nothing about which
    /// batches are out, and one that decodes can still miss a task the
    /// system holds: either way the live task keeps its batch, and the
    /// rest of its source, from being sent again.
    func testALiveTaskHoldsItsSourceWhateverTheRecordSays() async throws {
        for record in ["not a record", "{}"] {
            for unlocked in [true, false] {
                try await assertLiveTaskHoldsItsSource(record: record, unlocked: unlocked)
            }
        }
    }

    /// An unrecognised record is kept while a task is out and started over
    /// once none is: hand-offs then resume.
    func testAnUnrecognisedRecordStartsOverOnceNoTaskIsOut() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let buf = buffer()
        try await buf.enqueue(rowsBatch())
        _ = try await uploader(buf, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let lost = try XCTUnwrap(transport.started.first?.tag)
        try Data("not a record".utf8).write(to: directory.appendingPathComponent("background-uploads.state"))
        transport.end(lost)

        let relaunched = buffer()
        let stats = try await uploader(relaunched, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
            .drain()

        XCTAssertEqual(stats.handedOff, 1)
        XCTAssertEqual(transport.started.count, 2)
        let marks = try await relaunched.backgroundUploadMarks()
        XCTAssertEqual(marks.values.map(\.tag), transport.started.last.map { [$0.tag] })
    }

    private func assertLiveTaskHoldsItsSource(record: String, unlocked: Bool) async throws {
        try? FileManager.default.removeItem(at: directory)
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let first = buffer()
        try await first.enqueue(rowsBatch())
        _ = try await uploader(first, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
            .drain()
        let deletion = batch(deletedIds: ["r1"])
        try await first.enqueue(deletion)
        try Data(record.utf8).write(to: directory.appendingPathComponent("background-uploads.state"))

        let relaunched = buffer()
        let switches = BackgroundSwitches()
        switches.unlocked = unlocked
        let stats = try await uploader(relaunched, gateway: gateway(session), transport: transport, switches: switches)
            .drain()

        XCTAssertTrue(session.calls.isEmpty, "\(record), unlocked \(unlocked): \(session.calls.map(\.url))")
        XCTAssertEqual(transport.started.count, 1, "\(record), unlocked \(unlocked): the insert is not handed off twice")
        XCTAssertEqual(stats.inBackground, 2, record)
        let left = try await relaunched.load(id: deletion.id)
        XCTAssertNotNil(left, record)
    }

    /// Without the record of hand-offs, the tasks' own tags still say
    /// which batch is out; it and everything after it wait.
    func testWithAnUnreadableRecordLaterBatchesWait() async throws {
        let session = CollectorCoreTests.MockSession()
        let transport = FakeBackgroundTransport()
        let first = buffer()
        try await first.enqueue(rowsBatch())
        _ = try await uploader(first, gateway: gateway(session), transport: transport, switches: BackgroundSwitches()).drain()
        let deletion = batch(deletedIds: ["r1"])
        try await first.enqueue(deletion)

        let record = directory.appendingPathComponent("background-uploads.state")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: record.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path) }
        let relaunched = buffer()
        let stats = try await uploader(relaunched, gateway: gateway(session), transport: transport, switches: BackgroundSwitches())
            .drain()

        XCTAssertTrue(session.calls.isEmpty, "\(session.calls)")
        XCTAssertEqual(stats.inBackground, 2)
        let left = try await relaunched.load(id: deletion.id)
        XCTAssertNotNil(left)
    }
}
