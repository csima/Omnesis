// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// The home shell's attention banner must sit above each section's top
/// controls, never over them. A banner set as a `.safeAreaInset` once covered
/// the menu button of every section — each is a NavigationStack, which does
/// not pass that inset on — and on a short folded display it left no way into
/// the menu. A snapshot shows where the button is drawn; only a real tap shows
/// that the button, not the banner, receives it.
///
/// The harness is `DEMO_HOME_PREVIEW=attention`: the home shell over a preview
/// store with phone sources needing attention, no gateway. Run it on any
/// simulator; the folded outer display of a book-style iPhone is the tightest.
/// Each section leaves a screenshot in `/tmp/omnesis-snapshots` for review.
final class HomeAttentionBannerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testMenuButtonOpensTheMenuUnderTheBannerOnEverySection() {
        for tab in ["agent", "search", "sources", "people", "tasks"] {
            let app = XCUIApplication()
            app.launchEnvironment["DEMO_HOME_PREVIEW"] = "attention"
            app.launchEnvironment["DEMO_INITIAL_TAB"] = tab
            app.launchEnvironment["DEMO_DISABLE_ANIMATIONS"] = "1"
            app.launch()
            dismissSystemAlerts()

            let banner = app.staticTexts["Phone sources need attention"]
            XCTAssertTrue(banner.waitForExistence(timeout: 15), "\(tab): the attention banner did not show")
            let toggle = app.buttons["menu.toggle"].firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 10), "\(tab): no menu button")
            XCTAssertTrue(toggle.isHittable, "\(tab): the menu button is covered")
            XCTAssertGreaterThanOrEqual(
                toggle.frame.minY,
                banner.frame.maxY,
                "\(tab): the menu button is drawn under the banner"
            )
            screenshot("344-home-attention-banner-\(tab)")

            toggle.tap()
            XCTAssertTrue(
                app.buttons["menu.search"].firstMatch.waitForExistence(timeout: 5),
                "\(tab): tapping the menu button did not open the menu"
            )
            app.terminate()
        }
    }

    // MARK: - Helpers

    private func screenshot(_ name: String) {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(
            to: directory.appendingPathComponent("\(name).png")
        )
    }

    /// Tap away any system permission alert (the Ask composer asks for the
    /// microphone on first launch), draining until quiet.
    private func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let labels = ["Don't Allow", "Don’t Allow", "OK", "Dismiss"]
        let deadline = Date().addingTimeInterval(8)
        var quietAfter = Date().addingTimeInterval(3)
        while Date() < deadline {
            var dismissed = false
            for label in labels {
                let button = springboard.alerts.buttons[label].firstMatch
                if button.exists {
                    button.tap()
                    dismissed = true
                    quietAfter = Date().addingTimeInterval(1)
                    break
                }
            }
            if !dismissed, !springboard.alerts.firstMatch.exists, Date() >= quietAfter { return }
            Thread.sleep(forTimeInterval: 0.3)
        }
    }
}
