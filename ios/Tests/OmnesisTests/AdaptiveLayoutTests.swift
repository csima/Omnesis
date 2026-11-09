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

/// How design sizes follow the reader's text size.
final class ScaledTypeTests: XCTestCase {
    private let sizes: [CGFloat] = [9, 10, 10.5, 11, 11.5, 12, 13, 14, 15, 16, 17, 18, 20, 22, 28, 34, 44]

    /// At the default setting every size is exactly as designed, fractions
    /// included.
    func testTheDefaultSettingChangesNothing() {
        for size in sizes {
            XCTAssertEqual(ScaledType.size(size, bodySize: ScaledType.defaultBodySize), size)
        }
        XCTAssertEqual(ScaledType.bodySizes[3], ScaledType.defaultBodySize)
    }

    /// At every setting a larger design size never reads smaller than a
    /// smaller one, so captions and footnotes cannot swap.
    func testSizesKeepTheirOrderAtEverySetting() {
        for body in ScaledType.bodySizes {
            let scaled = sizes.map { ScaledType.size($0, bodySize: body) }
            XCTAssertEqual(scaled, scaled.sorted(), "out of order at body \(body)")
        }
    }

    /// Body text and smaller grow in proportion; titles grow by the points
    /// body text gains rather than in proportion.
    func testLargeSettingsScaleTextAndDampTitles() {
        let body: CGFloat = 40
        XCTAssertEqual(ScaledType.size(17, bodySize: body), 40)
        XCTAssertEqual(ScaledType.size(8.5, bodySize: body), 20)
        XCTAssertEqual(ScaledType.size(28, bodySize: body), 51)
    }

    /// Smaller settings shrink text, but nothing goes below 11pt or below its
    /// own design size if that is smaller still.
    func testSmallSettingsKeepTextReadable() {
        XCTAssertEqual(ScaledType.size(12, bodySize: 14), 11)
        XCTAssertEqual(ScaledType.size(17, bodySize: 14), 14)
        XCTAssertEqual(ScaledType.size(9, bodySize: 14), 9)
    }
}
