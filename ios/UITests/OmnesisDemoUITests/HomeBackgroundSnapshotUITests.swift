// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Sent to the background, the app is laid out again at sizes it is never
/// shown at in the foreground: the system snapshots the scene for the app
/// switcher in the other orientation too, which on the folded outer display
/// of a book-style iPhone is wide enough to dock the sidebar. That layout
/// once never settled — the sidebar's width is a fraction of the measured
/// width, and padding the app by it nudged the measurement back by a
/// floating-point sliver, forever — and the watchdog killed the app
/// (0x8BADF00D, scene-update) while it sat in the background. Only a real
/// process gets snapshotted, so only a UI test can see it.
///
/// Runs over `DEMO_HOME_PREVIEW=attention`, the home shell with its top
/// banner showing, which is the layout the loop needed.
final class HomeBackgroundSnapshotUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    func testAppSettlesWhenSnapshottedInTheBackground() throws {
        let app = XCUIApplication()
        app.launchEnvironment["DEMO_HOME_PREVIEW"] = "attention"
        app.launchEnvironment["DEMO_INITIAL_TAB"] = "agent"
        app.launchEnvironment["DEMO_DISABLE_ANIMATIONS"] = "1"
        app.launch()
        XCTAssertTrue(
            app.staticTexts["Phone sources need attention"].waitForExistence(timeout: 15),
            "the attention banner did not show"
        )

        // Background the app, then turn the device and change appearance so
        // the system snapshots the scene again at other sizes.
        // Bringing another app forward, rather than pressing Home, which a
        // simulated book-style iPhone does not always honour.
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.activate()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15), "Settings did not come forward")
        let left = NSPredicate { _, _ in app.state != .runningForeground }
        XCTAssertEqual(
            XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: left, object: nil)], timeout: 10),
            .completed,
            "the app did not leave the foreground"
        )
        XCUIDevice.shared.orientation = .landscapeLeft
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 4)

        // A main thread still laying out cannot come back: activation and the
        // queries below wait for the app to go idle and give up instead.
        let returned = Date()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the app did not come back to the foreground")
        let toggle = app.buttons["menu.toggle"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "no menu button after returning")
        toggle.tap()
        XCTAssertTrue(
            app.buttons["menu.search"].firstMatch.waitForExistence(timeout: 5),
            "the menu did not open after returning from the background"
        )
        XCTAssertLessThan(
            Date().timeIntervalSince(returned), 20,
            "the app took too long to respond after the background snapshot"
        )
    }
}
