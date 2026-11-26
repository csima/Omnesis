// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The Search tab's source chips, as edits to the query text.
///
/// A chip is not separate state: it is a `source:<type>` token in the query.
/// Selecting one appends the token, deselecting removes it, and a chip reads
/// as selected whenever the query holds a matching token, so a token typed by
/// hand lights the same chip. Several tokens OR together, as the gateway's
/// query parser already does.
///
/// Same rules as the portal's `js/lib/search-source-filter.js`; keep the two
/// in step.
enum SourceFilterQuery {
    struct Token: Equatable {
        let range: Range<String.Index>
        /// The value as written, quotes stripped.
        let value: String
    }

    /// Every `source:` token in `query`, in order.
    ///
    /// A token starts at the beginning of the query or after whitespace, so
    /// `resource:web` is not one. Its value is quoted (`source:"web"`) or runs
    /// to the next whitespace. Text inside a matched pair of quotes is never a
    /// token: `"notes source:web"` searches for that phrase. A quote with no
    /// partner is an ordinary character, so an unfinished phrase being typed
    /// does not hide the tokens after it.
    static func tokens(in query: String) -> [Token] {
        var found: [Token] = []
        var index = query.startIndex
        while index < query.endIndex {
            if query[index] == "\"",
               let close = query[query.index(after: index)...].firstIndex(of: "\"") {
                index = query.index(after: close)
                continue
            }
            if index == query.startIndex || query[query.index(before: index)].isWhitespace,
               let token = token(at: index, in: query) {
                found.append(token)
                index = token.range.upperBound
                continue
            }
            index = query.index(after: index)
        }
        return found
    }

    /// Whether the query holds a token naming exactly this bare type, ignoring
    /// case. A token naming one account (`source:<type>:<account>`) is a
    /// narrower filter than the chip and does not light it.
    static func contains(_ type: String, in query: String) -> Bool {
        tokens(in: query).contains { sameType($0.value, type) }
    }

    /// The query, trimmed, with ` source:<type>` appended; just the token when
    /// the query is blank.
    static func adding(_ type: String, to query: String) -> String {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "source:\(type)" : "\(text) source:\(type)"
    }

    /// The query without its tokens for this type. Every other character is
    /// kept as it was; the whitespace around each removed token collapses to
    /// one space, or to nothing at either end of the query.
    static func removing(_ type: String, from query: String) -> String {
        var text = query
        // Re-read after each cut, so no index outlives the edit it predates.
        while let token = tokens(in: text).last(where: { sameType($0.value, type) }) {
            let before = trimmingTrailingWhitespace(text[..<token.range.lowerBound])
            let after = String(text[token.range.upperBound...].drop(while: \.isWhitespace))
            text = !before.isEmpty && !after.isEmpty ? "\(before) \(after)" : before + after
        }
        return text
    }

    /// Adds the type's token when the query lacks it, else removes it.
    static func toggling(_ type: String, in query: String) -> String {
        contains(type, in: query) ? removing(type, from: query) : adding(type, to: query)
    }

    // MARK: - Private

    private static let key = "source:"

    private static func sameType(_ value: String, _ type: String) -> Bool {
        value.lowercased() == type.lowercased()
    }

    /// `source:` (any case) at `start`, then `"<one or more non-quotes>"` or
    /// one or more non-whitespace characters: the two value shapes the
    /// gateway's parser accepts.
    private static func token(at start: String.Index, in query: String) -> Token? {
        let rest = query[start...]
        guard rest.count > key.count, rest.prefix(key.count).lowercased() == key else { return nil }
        let valueStart = query.index(start, offsetBy: key.count)
        if query[valueStart] == "\"" {
            let inner = query.index(after: valueStart)
            if let close = query[inner...].firstIndex(of: "\""), close > inner {
                return Token(range: start ..< query.index(after: close), value: String(query[inner ..< close]))
            }
        }
        let end = query[valueStart...].firstIndex(where: \.isWhitespace) ?? query.endIndex
        guard end > valueStart else { return nil }
        return Token(range: start ..< end, value: String(query[valueStart ..< end]))
    }

    private static func trimmingTrailingWhitespace(_ text: Substring) -> String {
        var end = text.endIndex
        while end > text.startIndex, text[text.index(before: end)].isWhitespace {
            end = text.index(before: end)
        }
        return String(text[..<end])
    }
}

/// One chip in the Search tab's source row: a source type the user has, with
/// its accounts folded together.
struct SearchSourceChip: Equatable, Identifiable {
    /// The source type, used as the `source:` value.
    let type: String
    let label: String
    /// A source of this type, for `SourceIconView`'s per-account art.
    let representativeSourceId: String
    /// Documents across every account of the type; 0 when the status snapshot
    /// hasn't reported counts.
    let documentCount: Int

    var id: String {
        type
    }

    /// The chips to offer: one per source type among the registered sources
    /// (`GET /admin/sources` items). Same rules as the portal's
    /// `buildSourceChips`:
    ///
    /// - A source's type is its `type`, or its id up to the first colon.
    ///   Accounts of one type fold into one chip. Gateway-internal datasets
    ///   (such as `omnesis-chat`) are not registered sources, so they never
    ///   appear.
    /// - `documentsBySourceId` is `GET /status` `documents.bySource`. A type's
    ///   count is the sum over its accounts; with counts, a type with none
    ///   gets no chip, since filtering to it finds nothing. Without counts,
    ///   every type is offered.
    /// - A type in `experimentalTypes` (its descriptor says experimental) gets
    ///   no chip unless the gateway runs in experimental mode.
    /// - `label(type)` is the type's display name.
    /// - Most documents first, then by label.
    static func build(
        sources: [SourceRecord],
        documentsBySourceId: [String: Int]?,
        experimentalEnabled: Bool,
        experimentalTypes: Set<String>,
        label: (String) -> String
    ) -> [SearchSourceChip] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        var representative: [String: String] = [:]
        for source in sources {
            let type = source.type.isEmpty ? sourceTypeOf(source.id) : source.type
            guard !type.isEmpty else { continue }
            guard experimentalEnabled || !experimentalTypes.contains(type) else { continue }
            if counts[type] == nil {
                order.append(type)
                representative[type] = source.id
            }
            counts[type, default: 0] += documentsBySourceId?[source.id] ?? 0
        }
        let chips = order.compactMap { type -> SearchSourceChip? in
            let count = counts[type] ?? 0
            if documentsBySourceId != nil, count == 0 { return nil }
            return SearchSourceChip(
                type: type,
                label: label(type),
                representativeSourceId: representative[type] ?? type,
                documentCount: count
            )
        }
        return chips.sorted { lhs, rhs in
            if lhs.documentCount != rhs.documentCount { return lhs.documentCount > rhs.documentCount }
            return lhs.label.localizedCompare(rhs.label) == .orderedAscending
        }
    }

    /// A type's name when no source declared one, as the portal's
    /// `sourceLabel` falls back: dashes to spaces, each word capitalised.
    /// `apple-notes` → `Apple Notes`, with no per-source knowledge.
    static func fallbackLabel(_ type: String) -> String {
        var out = ""
        var previousIsWord = false
        for char in type.replacingOccurrences(of: "-", with: " ") {
            let isWord = char.isLetter || char.isNumber || char == "_"
            out += isWord && !previousIsWord ? char.uppercased() : String(char)
            previousIsWord = isWord
        }
        return out
    }
}
