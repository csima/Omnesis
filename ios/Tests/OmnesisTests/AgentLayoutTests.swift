// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
@testable import Omnesis
import XCTest

/// The agent screen's split decision, made from available space alone.
final class AgentLayoutTests: XCTestCase {
    func testPhonesUseTheOverlay() {
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 393, height: 852)), .overlay)
        // On its side a large phone is as wide as an iPad but far too short.
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 932, height: 430)), .overlay)
    }

    func testIPadLandscapeSplits() {
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 1366, height: 1024)), .sidePanel)
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 1180, height: 820)), .sidePanel)
    }

    func testIPadPortraitUsesTheOverlay() {
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 820, height: 1180)), .overlay)
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 1024, height: 1366)), .overlay)
    }

    /// A foldable's inner display is close to square, and an iPhone there gets
    /// the split as an iPad would: the decision never asks what device it is.
    func testANearSquareInnerDisplaySplits() {
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 900, height: 1000)), .sidePanel)
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 1000, height: 900)), .sidePanel)
    }

    /// Beside a docked sidebar the section can drop below the split's width,
    /// and then the Timeline goes back over the conversation.
    func testANarrowedSectionFallsBackToTheOverlay() {
        let sidebar = MenuReveal.sidebarWidth(forContainerWidth: 1000)
        XCTAssertEqual(AgentLayout.mode(for: CGSize(width: 1000 - sidebar, height: 900)), .overlay)
    }

    func testSidePanelWidthIsClamped() {
        XCTAssertEqual(AgentLayout.sidePanelWidth(forTotalWidth: 800), AgentLayout.sidePanelMinWidth)
        XCTAssertEqual(AgentLayout.sidePanelWidth(forTotalWidth: 2000), AgentLayout.sidePanelMaxWidth)
    }
}
