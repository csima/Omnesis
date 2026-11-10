// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The one rule for what a failed upload means for its batch. Every
/// delivery path reads failures through it; `UploaderTests` checks the
/// foreground drain acts on each verdict the way it says.
final class DeliveryClassificationTests: XCTestCase {
    struct StatusCase {
        let status: Int
        let body: String
        let verdict: DeliveryVerdict

        init(_ status: Int, _ body: String, _ verdict: DeliveryVerdict) {
            self.status = status
            self.body = body
            self.verdict = verdict
        }
    }

    static let cutOffBody = #"{"error":"Malformed JSON in request body","code":"BAD_REQUEST"}"#
    static let incompleteBody =
        #"{"error":"Request body ended before it was complete","code":"REQUEST_BODY_INCOMPLETE"}"#

    /// Every status and body the gateway or a proxy in front of it gives,
    /// with what it means for the batch.
    static let statusCases: [StatusCase] = [
        StatusCase(401, "{}", .reauthorize),
        StatusCase(403, "{}", .blocked),
        StatusCase(400, #"{"error":"Validation failed","code":"VALIDATION_ERROR","detail":[]}"#, .refuse),
        StatusCase(400, cutOffBody, .retry),
        StatusCase(400, #"{"error":"Malformed JSON in request body, and more","code":"BAD_REQUEST"}"#, .refuse),
        StatusCase(400, "", .refuse),
        StatusCase(408, incompleteBody, .retry),
        StatusCase(408, "", .retry),
        StatusCase(409, "{}", .retry),
        StatusCase(413, "{}", .refuse),
        StatusCase(422, "{}", .refuse),
        StatusCase(425, "{}", .retry),
        StatusCase(429, "{}", .retry),
        StatusCase(500, "{}", .retry),
        StatusCase(502, "<html>Bad gateway</html>", .retry),
        StatusCase(503, "", .retry),
    ]

    func testEveryStatusMeansWhatItSays() {
        for item in Self.statusCases {
            XCTAssertEqual(
                DeliveryClassification.verdict(for: .status(item.status, body: item.body)),
                item.verdict,
                "\(item.status) \(item.body)"
            )
        }
    }

    /// The cut-off 400 is retried only while the batch is young; an old or
    /// unknown one is charged, so a gateway that means it as a verdict
    /// can't keep a batch in the queue for good.
    func testTheCutOffAnswerIsRetriedOnlyWithinItsWindow() {
        let cutOff = DeliveryFailure.status(400, body: Self.cutOffBody)
        let window = DeliveryClassification.cutOffRetryWindow
        XCTAssertEqual(DeliveryClassification.verdict(for: cutOff, batchAge: 60), .retry)
        XCTAssertEqual(DeliveryClassification.verdict(for: cutOff, batchAge: window - 1), .retry)
        XCTAssertEqual(DeliveryClassification.verdict(for: cutOff, batchAge: window), .refuse)
        XCTAssertEqual(DeliveryClassification.verdict(for: cutOff, batchAge: nil), .refuse)
        let incomplete = DeliveryFailure.status(408, body: Self.incompleteBody)
        XCTAssertEqual(DeliveryClassification.verdict(for: incomplete, batchAge: nil), .retry, "only the 400 is bounded")
    }

    func testABatchsAgeIsReadFromItsId() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let id = Batch.makeId(now: now.addingTimeInterval(-90))
        let age = try XCTUnwrap(Batch.age(ofId: id, now: now))
        XCTAssertEqual(age, 90, accuracy: 0.001)
        XCTAssertNil(Batch.age(ofId: "fixture", now: now))
    }

    /// Only an exact 400 counts as cut off: the same message on another
    /// status is that status's verdict.
    func testTheCutOffMessageOnlyCountsOnA400() {
        XCTAssertEqual(DeliveryClassification.verdict(for: .status(422, body: Self.cutOffBody)), .refuse)
    }

    func testFailuresThatAreNotAStatus() {
        XCTAssertEqual(DeliveryClassification.verdict(for: .unreadableResponse), .retry)
        XCTAssertEqual(DeliveryClassification.verdict(for: .undecodableBatch), .refuse)
        XCTAssertEqual(DeliveryClassification.verdict(for: .other), .retry)
    }

    /// The errors `GatewayClient` throws map onto the same failures an HTTP
    /// answer read directly does, so both paths reach one verdict.
    func testGatewayClientErrorsAndRawAnswersAgree() {
        for item in Self.statusCases {
            let raw = DeliveryClassification.failure(status: item.status, body: Data(item.body.utf8))
            let thrown: GatewayClient.Error = switch item.status {
            case 401: .unauthorized
            case 403: .forbidden
            default: .serverError(status: item.status, body: item.body)
            }
            let viaClient = DeliveryClassification.failure(from: thrown)
            XCTAssertEqual(
                raw.map { DeliveryClassification.verdict(for: $0) },
                DeliveryClassification.verdict(for: viaClient),
                "\(item.status) \(item.body)"
            )
        }
    }

    func testAnswersReadAsAResponseAreNotFailures() {
        for status in [200, 201, 204, 404] {
            XCTAssertNil(DeliveryClassification.failure(status: status, body: Data()), "\(status)")
        }
    }

    func testThrownErrorsThatAreNotAStatus() {
        XCTAssertEqual(DeliveryClassification.failure(from: GatewayClient.Error.decoding("x")), .unreadableResponse)
        XCTAssertEqual(DeliveryClassification.failure(from: GatewayClient.Error.invalidResponse), .unreadableResponse)
        let decoding = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))
        XCTAssertEqual(DeliveryClassification.failure(from: decoding), .undecodableBatch)
        XCTAssertEqual(DeliveryClassification.failure(from: URLError(.networkConnectionLost)), .other)
        XCTAssertEqual(DeliveryClassification.failure(from: CancellationError()), .other)
    }
}
