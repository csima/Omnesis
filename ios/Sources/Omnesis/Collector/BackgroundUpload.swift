// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Uploads handed to the system so they finish after the app is suspended.
///
/// A batch that is exactly one request is written, as that request's body,
/// to an outbox file in the buffer directory and given to a background
/// `URLSession`; `nsurlsessiond` finishes it whether or not the app is still
/// running, and the result is recorded against the batch when the app next
/// hears about it. Everything else keeps the foreground drain.
///
/// Only while the phone is unlocked: the outbox file carries the buffer's
/// own protection class, so it is only handed over while it can be read.
/// A locked phone keeps the foreground drain's behaviour.
public enum BackgroundUploadSettings {
    public static let enabledKey = "omnesis.upload.backgroundSession"

    /// Off until the person turns it on.
    public static func isEnabled(_ defaults: KeyValueDefaults) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? false
    }
}

/// The one request a background-eligible batch amounts to.
public enum BackgroundUploadEndpoint: String, Sendable, CaseIterable {
    case analytics = "/analytics/ingest"
    case documents = "/documents"

    /// The endpoint a batch is sent to in one request, or `nil` when it
    /// takes more than one or needs the replica lease: deletions of either
    /// kind, and analytics rows that carry documents (which must land after
    /// the rows they bind to).
    public init?(batch: Batch) {
        guard batch.deletedIds.isEmpty else { return nil }
        if batch.tableName != nil {
            guard batch.documents.isEmpty, !batch.records.isEmpty || batch.schema != nil else { return nil }
            self = .analytics
        } else {
            guard !batch.documents.isEmpty else { return nil }
            self = .documents
        }
    }
}

/// What a background task carries across relaunches, in its
/// `taskDescription`: the batch, the endpoint, and which hand-off of that
/// batch it is. A result counts only while the batch's mark still names the
/// same hand-off, so a task from before a re-pair, or one a later hand-off
/// superseded, changes nothing.
public struct BackgroundUploadTag: Hashable, Sendable, CustomStringConvertible {
    public let batchId: String
    public let endpoint: BackgroundUploadEndpoint
    public let attempt: String

    public init(batchId: String, endpoint: BackgroundUploadEndpoint, attempt: String = UUID().uuidString) {
        self.batchId = batchId
        self.endpoint = endpoint
        self.attempt = attempt
    }

    public init?(_ description: String) {
        let parts = description.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, !parts[0].isEmpty, !parts[2].isEmpty,
              let endpoint = BackgroundUploadEndpoint(rawValue: parts[1]) else { return nil }
        self.init(batchId: parts[0], endpoint: endpoint, attempt: parts[2])
    }

    public var description: String {
        "\(batchId)|\(endpoint.rawValue)|\(attempt)"
    }

    /// The outbox file holding this hand-off's request body. Not `.json`:
    /// the buffer's scan claims every `.json` file it can see.
    var outboxFileName: String {
        "\(batchId).\(attempt).body"
    }
}

/// How one background task ended.
public struct BackgroundUploadCompletion: Sendable {
    public enum Outcome: Sendable {
        /// The gateway answered with this status and body.
        case response(status: Int, body: Data)
        /// No answer: the network, a cancelled task, a rejected certificate,
        /// or an outbox file the system could not read.
        case failed
    }

    public let tag: String
    public let outcome: Outcome

    public init(tag: String, outcome: Outcome) {
        self.tag = tag
        self.outcome = outcome
    }
}

/// The system's background upload queue, as the uploader uses it. The app
/// uses `BackgroundUploadSession`; tests use a fake.
public protocol BackgroundUploadTransport: Sendable {
    /// Queue `file` as the body of `request`, tagged with `tag`.
    func upload(_ request: URLRequest, fromFile file: URL, tag: String)
    /// Tags of the tasks the system still holds.
    func pendingTags() async -> Set<String>
    /// Cancel every task.
    func cancelAll() async
}

/// What the uploader needs to hand batches to the background queue.
public struct BackgroundUploads: Sendable {
    public let transport: any BackgroundUploadTransport
    /// Whether the person turned background uploads on. Read every drain.
    public let isEnabled: @Sendable () -> Bool
    /// Whether the phone is unlocked, so an outbox file written now can be
    /// read when the upload starts.
    public let protectedDataAvailable: @Sendable () async -> Bool

    public init(
        transport: any BackgroundUploadTransport,
        isEnabled: @escaping @Sendable () -> Bool,
        protectedDataAvailable: @escaping @Sendable () async -> Bool
    ) {
        self.transport = transport
        self.isEnabled = isEnabled
        self.protectedDataAvailable = protectedDataAvailable
    }
}

/// A batch handed to the background queue: the task carrying it and the
/// source it belongs to, so a 403 can be attributed without reading the
/// batch file (which a locked phone cannot).
public struct BackgroundUploadMark: Codable, Equatable, Sendable {
    public let tag: String
    public let sourceId: String
}
