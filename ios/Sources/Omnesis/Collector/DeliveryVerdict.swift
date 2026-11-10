// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a failed batch upload means for the batch.
public enum DeliveryVerdict: Equatable, Sendable {
    /// 401: the device's token is dead. Nothing else can deliver until the
    /// phone is paired again.
    case reauthorize
    /// 403: the token lacks this source's write scope. The batch stays
    /// queued, and is not charged, until the scope is granted.
    case blocked
    /// The world may fix this on its own; never costs the batch data.
    case retry
    /// The gateway's verdict on the payload; repeating cannot change it.
    /// Counts against the batch's quarantine budget.
    case refuse
}

/// How a batch upload failed, before deciding what that means.
public enum DeliveryFailure: Equatable, Sendable {
    /// The gateway answered with an error status and this body.
    case status(Int, body: String)
    /// The gateway answered something this app can't read.
    case unreadableResponse
    /// The batch's own bytes were read and do not parse.
    case undecodableBatch
    /// Anything else: the network, a file that can't be read yet, a
    /// cancelled task.
    case other
}

/// The one rule for what an upload failure means, shared by every path
/// that delivers a batch, so they can't drift apart.
public enum DeliveryClassification {
    /// 4xx codes that mean "later", not "no". They arrive from the gateway's
    /// own backpressure and from anything sitting in front of it — a reverse
    /// proxy timing out a slow request body on a weak uplink returns 408, a
    /// rate limiter returns 429 — so treating them as a verdict on the
    /// payload would put the largest batches, uploaded over the worst
    /// connections, first in line to be discarded. A 409 also occurs while
    /// source storage is being migrated; retain the original batch for retry.
    static let retryableStatuses: Set<Int> = [408, 409, 425, 429]

    /// The message a gateway older than its `REQUEST_BODY_INCOMPLETE` answer
    /// (408) gives a request body that ended early: its JSON check reads the
    /// body and reports any failure to read it as malformed JSON. This app
    /// serialises every batch with `JSONEncoder`, which cannot emit malformed
    /// JSON, so that 400 means the bytes were cut off on the way — the app
    /// suspended mid-upload, the link dropped, or a proxy gave up on a slow
    /// body — and never that the batch is wrong. Matched exactly, on 400
    /// only: any other 400 is still the gateway's verdict on the payload.
    static let truncatedBodyMessage = "Malformed JSON in request body"

    public static func verdict(for failure: DeliveryFailure) -> DeliveryVerdict {
        switch failure {
        case .status(401, _):
            .reauthorize
        case .status(403, _):
            .blocked
        case .status(let status, let body) where (400 ..< 500).contains(status):
            retryableStatuses.contains(status) || isCutOffInTransit(status: status, body: body)
                ? .retry : .refuse
        case .status:
            // 5xx: the gateway or something in front of it is unwell.
            .retry
        case .unreadableResponse:
            // Likeliest causes: a captive portal returning an HTML login page
            // with a 200, a proxy error page, or a gateway restarting behind
            // one — all of which clear on their own. Only a genuine protocol
            // mismatch would repeat, and paying for that with data is the
            // worse trade.
            .retry
        case .undecodableBatch:
            // Unlike a read failure — routine while the device is locked — no
            // amount of retrying turns the bytes back into a batch.
            .refuse
        case .other:
            .retry
        }
    }

    /// The failure an HTTP answer amounts to, or `nil` when it is one the
    /// caller reads as a response. Mirrors `GatewayClient`: 2xx and 404 (an
    /// older gateway without the route) are handed to the response decoder.
    public static func failure(status: Int, body: Data) -> DeliveryFailure? {
        switch status {
        case 200 ... 299, 404: nil
        default: .status(status, body: String(data: body, encoding: .utf8) ?? "")
        }
    }

    /// The failure an error thrown while delivering over `GatewayClient`
    /// amounts to.
    public static func failure(from error: any Error) -> DeliveryFailure {
        switch error {
        case GatewayClient.Error.unauthorized:
            .status(401, body: "")
        case GatewayClient.Error.forbidden:
            .status(403, body: "")
        case GatewayClient.Error.serverError(let status, let body):
            .status(status, body: body)
        case GatewayClient.Error.decoding, GatewayClient.Error.invalidResponse:
            .unreadableResponse
        case is DecodingError:
            .undecodableBatch
        default:
            .other
        }
    }

    /// A 400 whose message is exactly the one an older gateway gives a body
    /// that stopped arriving — see `truncatedBodyMessage`.
    static func isCutOffInTransit(status: Int, body: String) -> Bool {
        status == 400 && GatewayErrorEnvelope.parse(body)?.error == truncatedBodyMessage
    }
}
