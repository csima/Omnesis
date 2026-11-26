// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Search tab's source chips edit `source:` tokens in the query text.
/// These are the portal's `search-source-filter.test.ts` cases, one for one,
/// so both clients make the same edits. Pure logic; runs in the sim-less
/// logic lane. All example data is invented.
final class SourceFilterQueryTests: XCTestCase {
    private func values(_ query: String) -> [String] {
        SourceFilterQuery.tokens(in: query).map(\.value)
    }

    // MARK: - Finding tokens

    func testFindsTokensAtStartMiddleAndEnd() {
        XCTAssertEqual(values("source:web budget source:gmail review source:notes"), ["web", "gmail", "notes"])
    }

    func testReadsQuotedValueWithoutQuotes() {
        let query = #"budget source:"web""#
        let tokens = SourceFilterQuery.tokens(in: query)
        XCTAssertEqual(tokens.map(\.value), ["web"])
        XCTAssertEqual(tokens.first.map { String(query[$0.range]) }, #"source:"web""#)
    }

    func testIgnoresSourceInsideQuotedPhrase() {
        XCTAssertEqual(values(#""notes source:web" review"#), [])
        XCTAssertEqual(values(#"with:"Maya source:web Reeves" source:gmail"#), ["gmail"])
    }

    func testUnpairedQuoteDoesNotHideLaterTokens() {
        XCTAssertEqual(values(#""quarterly source:web"#), ["web"])
    }

    func testOnlyMatchesWholeWord() {
        XCTAssertEqual(values("resource:web opensource:gmail"), [])
    }

    func testEmptyQueryHasNone() {
        XCTAssertEqual(values(""), [])
    }

    // MARK: - Selected

    func testSelectedMatchesBareTypeIgnoringCase() {
        XCTAssertTrue(SourceFilterQuery.contains("web", in: "budget SOURCE:Web"))
        XCTAssertTrue(SourceFilterQuery.contains("WEB", in: "budget source:web"))
        XCTAssertTrue(SourceFilterQuery.contains("web", in: #"budget source:"web""#))
    }

    func testOtherTypeAccountOrPhraseIsNotSelected() {
        XCTAssertFalse(SourceFilterQuery.contains("web", in: "source:webmail"))
        XCTAssertFalse(SourceFilterQuery.contains("gmail", in: "source:gmail:maya@example.com"))
        XCTAssertFalse(SourceFilterQuery.contains("web", in: #""source:web""#))
        XCTAssertFalse(SourceFilterQuery.contains("web", in: ""))
    }

    // MARK: - Add

    func testAddAppendsToken() {
        XCTAssertEqual(SourceFilterQuery.adding("web", to: "budget review"), "budget review source:web")
    }

    func testAddToBlankQueryIsJustTheToken() {
        XCTAssertEqual(SourceFilterQuery.adding("web", to: ""), "source:web")
        XCTAssertEqual(SourceFilterQuery.adding("web", to: "   "), "source:web")
    }

    func testAddDoesNotDoubleTrailingSpaces() {
        XCTAssertEqual(SourceFilterQuery.adding("web", to: "budget  "), "budget source:web")
    }

    func testAddKeepsQuotedValuesAndOperators() {
        XCTAssertEqual(
            SourceFilterQuery.adding("gmail", to: #"with:"maya reeves" after:"last week" #work"#),
            #"with:"maya reeves" after:"last week" #work source:gmail"#
        )
    }

    // MARK: - Remove

    func testRemoveFromMiddleLeavesOneSpace() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "budget source:web review"), "budget review")
    }

    func testRemoveAtStartOrEnd() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "source:web budget"), "budget")
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "budget source:web"), "budget")
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "source:web"), "")
    }

    func testRemoveCollapsesExtraSpaces() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "budget   source:web   review"), "budget review")
    }

    func testRemoveOnlyThatTypeAnyCase() {
        XCTAssertEqual(
            SourceFilterQuery.removing("web", from: "source:gmail budget Source:WEB source:notes"),
            "source:gmail budget source:notes"
        )
    }

    func testRemoveEveryCopy() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "source:web budget source:web"), "budget")
    }

    func testRemoveQuotedToken() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: #"budget source:"web" review"#), "budget review")
    }

    func testRemoveKeepsPhrasesOperatorsAndSpacing() {
        XCTAssertEqual(
            SourceFilterQuery.removing("web", from: #"with:"maya  reeves" source:web after:"last week" type:email"#),
            #"with:"maya  reeves" after:"last week" type:email"#
        )
    }

    func testRemoveLeavesPhraseAndAccountTokenAlone() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: #""notes source:web" source:web"#), #""notes source:web""#)
        XCTAssertEqual(
            SourceFilterQuery.removing("gmail", from: "source:gmail:maya@example.com source:gmail"),
            "source:gmail:maya@example.com"
        )
    }

    func testRemoveWithoutTokenIsUnchanged() {
        XCTAssertEqual(SourceFilterQuery.removing("web", from: "budget  review"), "budget  review")
    }

    // MARK: - Toggle

    func testToggleAddsThenRemoves() {
        let added = SourceFilterQuery.toggling("web", in: "budget")
        XCTAssertEqual(added, "budget source:web")
        XCTAssertEqual(SourceFilterQuery.toggling("web", in: added), "budget")
    }

    func testToggleTwoChipsIndependently() {
        let both = SourceFilterQuery.toggling("gmail", in: SourceFilterQuery.toggling("web", in: "budget"))
        XCTAssertEqual(both, "budget source:web source:gmail")
        XCTAssertEqual(SourceFilterQuery.toggling("web", in: both), "budget source:gmail")
    }

    func testToggleOffTokenTypedInOtherCase() {
        XCTAssertEqual(SourceFilterQuery.toggling("web", in: "Source:Web budget"), "budget")
    }

    // MARK: - Chip list

    private func source(_ id: String, _ type: String = "") -> SourceRecord {
        SourceRecord(id: id, type: type, accountId: id, deviceId: "dev-1", enabled: true)
    }

    private let labels = ["gmail": "Gmail", "web": "Web", "things": "Things", "trial": "Trial"]

    private func build(
        _ sources: [SourceRecord],
        counts: [String: Int]?,
        experimental: Bool = false,
        experimentalTypes: Set<String> = []
    ) -> [SearchSourceChip] {
        SearchSourceChip.build(
            sources: sources,
            documentsBySourceId: counts,
            experimentalEnabled: experimental,
            experimentalTypes: experimentalTypes,
            label: { [labels] in labels[$0] ?? $0 }
        )
    }

    func testChipsFoldAccountsAndSumCounts() {
        let chips = build(
            [source("gmail:maya@example.com", "gmail"), source("gmail:jamie@example.org", "gmail"), source("web", "web")],
            counts: ["gmail:maya@example.com": 3, "gmail:jamie@example.org": 4, "web": 9]
        )
        XCTAssertEqual(chips.map(\.type), ["web", "gmail"])
        XCTAssertEqual(chips.map(\.label), ["Web", "Gmail"])
        XCTAssertEqual(chips.map(\.documentCount), [9, 7])
        XCTAssertEqual(chips.last?.representativeSourceId, "gmail:maya@example.com")
    }

    func testChipsOrderByCountThenLabelAndDropEmptyTypes() {
        let chips = build(
            [source("things:local", "things"), source("web", "web"), source("gmail:maya@example.com", "gmail")],
            counts: ["things:local": 5, "web": 0, "gmail:maya@example.com": 5]
        )
        XCTAssertEqual(chips.map(\.type), ["gmail", "things"])
    }

    func testChipsWithoutCountsOfferEveryTypeByLabel() {
        let chips = build([source("web"), source("things:local"), source("gmail:maya@example.com")], counts: nil)
        XCTAssertEqual(chips.map(\.type), ["gmail", "things", "web"])
    }

    func testChipsHideExperimentalUnlessExperimentalMode() {
        let sources = [source("trial:one", "trial"), source("web", "web")]
        let counts = ["trial:one": 2, "web": 1]
        XCTAssertEqual(build(sources, counts: counts, experimentalTypes: ["trial"]).map(\.type), ["web"])
        XCTAssertEqual(
            build(sources, counts: counts, experimental: true, experimentalTypes: ["trial"]).map(\.type),
            ["trial", "web"]
        )
    }

    func testNoSourcesNoChips() {
        XCTAssertEqual(build([], counts: nil), [])
    }

    func testFallbackLabelTitleCasesEachWord() {
        XCTAssertEqual(SearchSourceChip.fallbackLabel("delta-field-notes"), "Delta Field Notes")
        XCTAssertEqual(SearchSourceChip.fallbackLabel("echo"), "Echo")
    }
}
