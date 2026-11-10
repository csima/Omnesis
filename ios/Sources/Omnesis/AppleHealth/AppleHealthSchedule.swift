// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One HealthKit read the schedule asks for.
public enum AppleHealthRead: Equatable, Sendable {
    /// The type's complete anchored read, no predicate. Every sample of
    /// the type passes through it, in insertion order.
    case complete(identifier: String, anchor: String?)
    /// The type's temporary recent read: anchored, limited to samples that
    /// start on or after `since`.
    case recent(identifier: String, anchor: String?, since: Date)

    public var identifier: String {
        switch self {
        case .complete(let identifier, _), .recent(let identifier, _, _): identifier
        }
    }
}

/// What a read returned, as far as the schedule cares.
public struct AppleHealthReadOutcome: Sendable {
    /// Samples plus deletions the read returned: a read that returns the
    /// page limit may have more behind it.
    public var returned: Int
    /// True when the read produced nothing to upload.
    public var isEmpty: Bool
    /// The anchor to resume the same read from, when HealthKit gave one.
    public var newAnchor: String?

    public init(returned: Int, isEmpty: Bool, newAnchor: String?) {
        self.returned = returned
        self.isEmpty = isEmpty
        self.newAnchor = newAnchor
    }
}

/// One page of a pass: what the read built (`nil` when the pass ended
/// without anything to upload), the cursor after it, and whether the pass
/// has more to read.
public struct AppleHealthPage<Page> {
    public var page: Page?
    public var cursor: AppleHealthCursor
    public var hasMore: Bool
}

/// Decides which HealthKit read each page of an Apple Health pass makes.
///
/// A pass first sweeps every type for what is new, then spends whatever
/// time is left on the history backfill:
///
/// 1. Sweep: each type once, in catalog order. A type whose complete
///    read has caught up continues that read (the steady state: only new
///    samples). A type still in backfill uses its recent read instead, so
///    the last `recentWindow` of it arrives without waiting for its
///    history.
/// 2. Backfill: the complete read of each type not yet caught up, one
///    type at a time from `cycleIndex`, as the old rotation did.
///
/// The complete read is never skipped or reset; the recent read only
/// delivers some samples early. A sample both reads return is uploaded
/// twice, which the gateway's upsert on the sample id absorbs. Once a
/// type's complete read reaches its end, its recent read is dropped.
public struct AppleHealthSchedule: Sendable {
    public static let defaultRecentWindow: TimeInterval = 7 * 24 * 60 * 60

    public let catalog: [String]
    public let pageLimit: Int
    public let recentWindow: TimeInterval

    public init(
        catalog: [String],
        pageLimit: Int,
        recentWindow: TimeInterval = AppleHealthSchedule.defaultRecentWindow
    ) {
        self.catalog = catalog
        self.pageLimit = pageLimit
        self.recentWindow = recentWindow
    }

    /// The cursor a new pass starts from: migrated if it predates the
    /// recent read, with the sweep set back to the first type.
    public func beginningPass(_ cursor: AppleHealthCursor, now: Date) -> AppleHealthCursor {
        var cursor = cursor.migrated(catalog: catalog)
        cursor.sweepIndex = catalog.isEmpty ? nil : 0
        if cursor.recentSince == nil {
            cursor.recentSince = Self.format(now.addingTimeInterval(-recentWindow))
        }
        return cursor
    }

    /// The read the next page makes, or `nil` when the pass is done.
    public func next(_ cursor: AppleHealthCursor) -> AppleHealthRead? {
        let caughtUp = cursor.caughtUp ?? []
        if let index = cursor.sweepIndex, catalog.indices.contains(index) {
            let identifier = catalog[index]
            if caughtUp.contains(identifier) {
                return .complete(identifier: identifier, anchor: cursor.anchor(for: identifier))
            }
            let since = cursor.recentSince.flatMap(Self.parse) ?? .distantPast
            return .recent(
                identifier: identifier,
                anchor: cursor.recentAnchorsByIdentifier[identifier],
                since: since
            )
        }
        guard let index = backfillIndex(cursor) else { return nil }
        let identifier = catalog[index]
        return .complete(identifier: identifier, anchor: cursor.anchor(for: identifier))
    }

    /// The cursor after `read` returned `outcome`.
    public func applying(
        _ outcome: AppleHealthReadOutcome,
        to read: AppleHealthRead,
        cursor: AppleHealthCursor,
        now: Date
    )
        -> AppleHealthCursor {
        var cursor = cursor
        var caughtUp = cursor.caughtUp ?? []
        let reachedEnd = outcome.returned < pageLimit
        let identifier = read.identifier
        let sweeping = cursor.sweepIndex.map { catalog.indices.contains($0) } ?? false

        switch read {
        case .complete:
            if let anchor = outcome.newAnchor {
                cursor.setAnchor(anchor, for: identifier)
            }
            if reachedEnd, !caughtUp.contains(identifier) {
                caughtUp.insert(identifier)
                cursor.recentAnchorsByIdentifier.removeValue(forKey: identifier)
                if !sweeping, let index = catalog.firstIndex(of: identifier) {
                    cursor.cycleIndex = index + 1
                }
            }
        case .recent:
            if let anchor = outcome.newAnchor {
                cursor.recentAnchorsByIdentifier[identifier] = anchor
            }
        }
        cursor.caughtUp = caughtUp

        if sweeping, reachedEnd, let index = cursor.sweepIndex {
            cursor.sweepIndex = index + 1 < catalog.count ? index + 1 : nil
        }
        if next(cursor) == nil {
            cursor.lastCycleCompletedAt = Self.format(now)
            cursor.cycleIndex = 0
        }
        return cursor
    }

    /// Runs reads until one yields something to upload or the pass is
    /// done, so the types with nothing new cost no page and no cursor save.
    /// `read` returns the page it built along with its outcome.
    public func nextPage<Page>(
        from cursor: AppleHealthCursor,
        now: Date,
        read: (AppleHealthRead) async throws -> (page: Page, outcome: AppleHealthReadOutcome)
    ) async throws
        -> AppleHealthPage<Page> {
        var cursor = cursor
        // Each type is read at most twice per pass with nothing to show
        // (once in the sweep, once in the backfill); the bound only guards
        // against a read that never reaches its end.
        for _ in 0 ..< (2 * catalog.count + 1) {
            guard let request = next(cursor) else { break }
            try Task.checkCancellation()
            let result = try await read(request)
            cursor = applying(result.outcome, to: request, cursor: cursor, now: now)
            if !result.outcome.isEmpty {
                return AppleHealthPage(page: result.page, cursor: cursor, hasMore: next(cursor) != nil)
            }
        }
        return AppleHealthPage(page: nil, cursor: cursor, hasMore: next(cursor) != nil)
    }

    private func backfillIndex(_ cursor: AppleHealthCursor) -> Int? {
        guard !catalog.isEmpty else { return nil }
        let caughtUp = cursor.caughtUp ?? []
        let start = ((cursor.cycleIndex % catalog.count) + catalog.count) % catalog.count
        for offset in 0 ..< catalog.count {
            let index = (start + offset) % catalog.count
            if !caughtUp.contains(catalog[index]) { return index }
        }
        return nil
    }

    private static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
