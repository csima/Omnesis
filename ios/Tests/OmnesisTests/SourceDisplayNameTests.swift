// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
@testable import Omnesis
import XCTest

/// A source is named by the label its provider publishes through the
/// gateway, so a source this build has never heard of still reads as its
/// name rather than its type id; the built-in names only cover a gateway
/// that has published nothing yet.
@available(iOS 17.0, *)
@MainActor
final class SourceDisplayNameTests: XCTestCase {
    func testAGatewayLabelNamesATypeTheAppDoesNotKnow() {
        let store = AppStore.preview(sourceLabelByType: ["quo-messages": "Quo"])
        XCTAssertEqual(store.sourceDisplayName(forType: "quo-messages"), "Quo")
    }

    func testTheGatewayLabelWinsOverTheBuiltInName() {
        let store = AppStore.preview(sourceLabelByType: ["gmail": "Work mail"])
        XCTAssertEqual(store.sourceDisplayName(forType: "gmail"), "Work mail")
    }

    func testTheBuiltInNameCoversAGatewayThatPublishedNoLabel() {
        let store = AppStore.preview()
        XCTAssertEqual(store.sourceDisplayName(forType: "gmail"), "Gmail")
        XCTAssertEqual(store.sourceDisplayName(forType: "quo-messages"), "quo-messages")
    }

    func testSourceGroupsAreNamedByTheGatewayLabel() {
        let quo = SourceRecord(
            id: "quo-messages:OR0100example",
            type: "quo-messages",
            accountId: "OR0100example",
            deviceId: "preview-device"
        )
        let store = AppStore.preview(sources: [quo], sourceLabelByType: ["quo-messages": "Quo"])
        XCTAssertEqual(store.groupedSources.map(\.displayName), ["Quo"])
    }
}
#endif
