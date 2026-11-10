// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializable cursor passed between CollectorCore and AppleHealthSource.
///
/// Structure (see `AppleHealthSchedule` for how a pass uses it):
///   - `anchorsByIdentifier` — per-type `HKQueryAnchor` encoded as
///     base64 (via `NSKeyedArchiver`) under the identifier key. This is
///     the complete read of each type, oldest insertion first; it is the
///     only lane that every sample is guaranteed to pass through.
///   - `cycleIndex` — where the history backfill is in `TypeCatalog.v1`.
///   - `lastCycleCompletedAt` — ISO 8601 timestamp of the last pass that
///     left nothing to read, so we can display "last full scan N minutes
///     ago" in the UI.
///   - `caughtUp` — types whose complete read has reached the end at
///     least once. `nil` on a cursor written before this field existed;
///     `migrated(catalog:)` derives it.
///   - `recentAnchorsByIdentifier` + `recentSince` — a second, temporary
///     anchored read per type still in backfill, limited to samples that
///     start on or after `recentSince`, so recent data arrives before the
///     history does. Dropped for a type once its complete read catches up.
///   - `sweepIndex` — position in the recent sweep; `nil` once the sweep
///     is done and the pass has moved on to the backfill. Kept across
///     passes, so a sweep that a short wake cut off resumes where it
///     stopped instead of starting over at the first type.
///   - `historyTurn` — the history backfill is owed a page (`owed`), or is
///     taking it at the start of this pass (`taking`), so a run of short
///     wakes that each end inside a sweep still moves the history on.
///
/// The cursor is persisted server-side via `/sync-state/:sourceId`
/// (see `CursorStore`). Anchors survive app reinstalls if the gateway
/// cursor survives — which is the intent, since HealthKit on the new
/// iPhone has the same UUIDs (via iCloud sync) that the anchors refer to.
public struct AppleHealthCursor: Sendable, Equatable {
    public var cycleIndex: Int
    public var anchorsByIdentifier: [String: String]
    public var lastCycleCompletedAt: String?
    public var caughtUp: Set<String>?
    public var recentAnchorsByIdentifier: [String: String]
    public var recentSince: String?
    public var sweepIndex: Int?
    public var historyTurn: HistoryTurn?
    /// Pages the current sweep type has had without reaching its end.
    public var sweepPages: Int?
    /// The sweep moved on from a type that still had more to read.
    public var sweepCutOff: Bool?

    /// See `AppleHealthSchedule`.
    public enum HistoryTurn: String, Sendable {
        /// A sweep ended with history pending and no backfill read since.
        case owed
        /// This pass started on the backfill to pay what was owed; a new
        /// sweep starts after its first backfill read.
        case taking
    }

    public init(
        cycleIndex: Int = 0,
        anchorsByIdentifier: [String: String] = [:],
        lastCycleCompletedAt: String? = nil,
        caughtUp: Set<String>? = nil,
        recentAnchorsByIdentifier: [String: String] = [:],
        recentSince: String? = nil,
        sweepIndex: Int? = nil,
        historyTurn: HistoryTurn? = nil,
        sweepPages: Int? = nil,
        sweepCutOff: Bool? = nil
    ) {
        self.cycleIndex = cycleIndex
        self.anchorsByIdentifier = anchorsByIdentifier
        self.lastCycleCompletedAt = lastCycleCompletedAt
        self.caughtUp = caughtUp
        self.recentAnchorsByIdentifier = recentAnchorsByIdentifier
        self.recentSince = recentSince
        self.sweepIndex = sweepIndex
        self.historyTurn = historyTurn
        self.sweepPages = sweepPages
        self.sweepCutOff = sweepCutOff
    }

    // MARK: - SyncCursor bridging

    /// Convert a `SyncCursor` (loaded from the gateway) into a typed
    /// cursor. Missing / malformed fields fall back to defaults.
    public static func decode(from cursor: SyncCursor?) -> AppleHealthCursor {
        guard let cursor else { return AppleHealthCursor() }

        var cycleIndex = 0
        if case .int(let i) = cursor["cycleIndex"] {
            cycleIndex = Int(i)
        }

        var lastCompleted: String?
        if case .string(let s) = cursor["lastCycleCompletedAt"] {
            lastCompleted = s
        }

        var caughtUp: Set<String>?
        if case .array(let values) = cursor["caughtUp"] {
            caughtUp = Set(values.compactMap { value in
                if case .string(let text) = value { text } else { nil }
            })
        }

        var recentSince: String?
        if case .string(let text) = cursor["recentSince"] {
            recentSince = text
        }

        var sweepIndex: Int?
        if case .int(let value) = cursor["sweepIndex"] {
            sweepIndex = Int(value)
        }

        var historyTurn: HistoryTurn?
        if case .string(let value) = cursor["historyTurn"] {
            historyTurn = HistoryTurn(rawValue: value)
        }

        var sweepPages: Int?
        if case .int(let value) = cursor["sweepPages"] {
            sweepPages = Int(value)
        }

        var sweepCutOff: Bool?
        if case .bool(let value) = cursor["sweepCutOff"] {
            sweepCutOff = value
        }

        return AppleHealthCursor(
            cycleIndex: cycleIndex,
            anchorsByIdentifier: strings(cursor["anchorsByIdentifier"]),
            lastCycleCompletedAt: lastCompleted,
            caughtUp: caughtUp,
            recentAnchorsByIdentifier: strings(cursor["recentAnchorsByIdentifier"]),
            recentSince: recentSince,
            sweepIndex: sweepIndex,
            historyTurn: historyTurn,
            sweepPages: sweepPages,
            sweepCutOff: sweepCutOff
        )
    }

    private static func strings(_ value: JSONValue?) -> [String: String] {
        guard case .object(let obj) = value else { return [:] }
        return obj.compactMapValues { value in
            if case .string(let text) = value { text } else { nil }
        }
    }

    /// Encode back into the untyped `[String: JSONValue]` shape the
    /// gateway persists.
    public func encode() -> SyncCursor {
        var dict: [String: JSONValue] = [
            "cycleIndex": .int(Int64(cycleIndex)),
            "anchorsByIdentifier": .object(
                anchorsByIdentifier.mapValues { JSONValue.string($0) }
            ),
        ]
        if let lastCycleCompletedAt {
            dict["lastCycleCompletedAt"] = .string(lastCycleCompletedAt)
        }
        if let caughtUp {
            dict["caughtUp"] = .array(caughtUp.sorted().map { .string($0) })
        }
        if !recentAnchorsByIdentifier.isEmpty {
            dict["recentAnchorsByIdentifier"] = .object(
                recentAnchorsByIdentifier.mapValues { JSONValue.string($0) }
            )
        }
        if let recentSince {
            dict["recentSince"] = .string(recentSince)
        }
        if let sweepIndex {
            dict["sweepIndex"] = .int(Int64(sweepIndex))
        }
        if let historyTurn {
            dict["historyTurn"] = .string(historyTurn.rawValue)
        }
        if let sweepPages {
            dict["sweepPages"] = .int(Int64(sweepPages))
        }
        if let sweepCutOff {
            dict["sweepCutOff"] = .bool(sweepCutOff)
        }
        return dict
    }

    // MARK: - Helpers

    public mutating func setAnchor(_ encoded: String?, for identifier: String) {
        if let encoded {
            anchorsByIdentifier[identifier] = encoded
        } else {
            anchorsByIdentifier.removeValue(forKey: identifier)
        }
    }

    public func anchor(for identifier: String) -> String? {
        anchorsByIdentifier[identifier]
    }

    /// The cursor with `caughtUp` filled in, for one written before that
    /// field existed. Such a cursor came from the old rotation, which read
    /// each type to its end before moving to the next: once a full cycle
    /// had completed, every anchored type had been read to its end; during
    /// the first cycle, the types before `cycleIndex` had. The type at
    /// `cycleIndex` may be mid-read, so it stays in the backfill. Nothing
    /// is restarted or skipped: every anchor carries over as it is.
    public func migrated(catalog: [String]) -> AppleHealthCursor {
        guard caughtUp == nil else { return self }
        var copy = self
        let finished = lastCycleCompletedAt != nil
            ? catalog
            : Array(catalog.prefix(max(0, min(cycleIndex, catalog.count))))
        copy.caughtUp = Set(finished.filter { anchorsByIdentifier[$0] != nil })
        return copy
    }
}
