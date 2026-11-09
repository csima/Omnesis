// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
@testable import Omnesis
import XCTest

/// Size-driven decisions for phones, a foldable folded and open, and iPads.
final class AdaptiveLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    private let phoneOnItsSide = CGSize(width: 956, height: 440)
    private let outerDisplay = CGSize(width: 466, height: 678)
    private let innerUpright = CGSize(width: 669, height: 951)
    private let innerOnItsSide = CGSize(width: 951, height: 669)
    private let iPad = CGSize(width: 1366, height: 1024)

    func testOnlyRoomyDisplaysRotate() {
        XCTAssertFalse(AdaptiveLayout.allowsRotation(windowSize: phone))
        XCTAssertFalse(AdaptiveLayout.allowsRotation(windowSize: phoneOnItsSide))
        XCTAssertFalse(AdaptiveLayout.allowsRotation(windowSize: outerDisplay))
        XCTAssertTrue(AdaptiveLayout.allowsRotation(windowSize: innerUpright))
        XCTAssertTrue(AdaptiveLayout.allowsRotation(windowSize: innerOnItsSide))
        XCTAssertTrue(AdaptiveLayout.allowsRotation(windowSize: iPad))
    }

    /// Before first layout there is no window size, and nothing to avoid.
    func testAnEmptyWindowIsNotRoomy() {
        XCTAssertFalse(AdaptiveLayout.isRoomy(.zero))
        XCTAssertNil(AdaptiveLayout.hinge(windowSize: .zero))
    }

    func testPhonesAndTheOuterDisplayHaveNoCrease() {
        XCTAssertNil(AdaptiveLayout.hinge(windowSize: phone))
        XCTAssertNil(AdaptiveLayout.hinge(windowSize: outerDisplay))
    }

    /// Opened like a book the crease runs top to bottom; turned upright, side
    /// to side — always across the middle.
    func testTheCreaseFollowsTheOrientation() {
        XCTAssertEqual(AdaptiveLayout.hinge(windowSize: innerOnItsSide), .vertical(x: 475.5))
        XCTAssertEqual(AdaptiveLayout.hinge(windowSize: innerUpright), .horizontal(y: 475.5))
    }

    func testPanesSplitEitherSideOfTheCrease() throws {
        let panes = try XCTUnwrap(AdaptiveLayout.panes(length: 951, crease: 475.5, minimumPane: 280))
        XCTAssertEqual(panes.leading, 475.5 - AdaptiveLayout.hingeClearance, accuracy: 0.001)
        XCTAssertEqual(panes.trailing, 475.5 - AdaptiveLayout.hingeClearance, accuracy: 0.001)
    }

    /// A crease near one edge of a view — a view beside a docked sidebar — or
    /// outside it leaves no room for two panes.
    func testNoPanesWhenEitherSideIsTooNarrow() {
        XCTAssertNil(AdaptiveLayout.panes(length: 691, crease: 215.5, minimumPane: 280))
        XCTAssertNil(AdaptiveLayout.panes(length: 400, crease: 600, minimumPane: 100))
        XCTAssertNil(AdaptiveLayout.panes(length: 400, crease: -10, minimumPane: 100))
    }
}
