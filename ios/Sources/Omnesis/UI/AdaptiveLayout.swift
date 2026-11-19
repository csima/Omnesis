// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// Size-driven layout decisions shared across surfaces, for every shape the
/// app runs in: a phone, a foldable iPhone folded (outer display) or open
/// (inner display), an iPad, a resized window.
///
/// Everything here is decided from the window's size and never from the kind
/// of device, so a foldable needs no special case: its inner display is simply
/// a roomy window, and its outer one a phone-sized window. Free of SwiftUI and
/// UIKit so the logic lane tests it natively.
enum AdaptiveLayout {
    /// The shorter side a window needs before it counts as roomy: tablet-like
    /// room in both directions. A foldable's inner display (669 × 951pt)
    /// qualifies in either orientation; its outer display (466 × 678pt) and
    /// every phone, upright or on its side, do not.
    static let roomyMinimumDimension: CGFloat = 600

    static func isRoomy(_ size: CGSize) -> Bool {
        min(size.width, size.height) >= roomyMinimumDimension
    }

    // MARK: - Orientation

    /// Whether the app follows the device into any orientation. A phone-sized
    /// window stays upright, as the app always has; a roomy one turns, so a
    /// foldable opened like a book gets a landscape layout instead of an
    /// upright one on its side.
    static func allowsRotation(windowSize size: CGSize) -> Bool {
        isRoomy(size)
    }

    // MARK: - The fold

    /// Where a roomy display may bend, in window coordinates.
    ///
    /// A foldable opened partway bends across the middle of its inner display:
    /// on its side the crease runs top to bottom, upright it runs side to side.
    /// Controls resting there are awkward to reach and partly hidden, so custom
    /// controls keep clear of it whenever the window is roomy. That costs
    /// nothing on an iPad, where the same layouts simply read as two balanced
    /// panes, and it needs no knowledge of the device or of its current pose.
    enum Hinge: Equatable {
        /// A crease running top to bottom at `x`.
        case vertical(x: CGFloat)
        /// A crease running side to side at `y`.
        case horizontal(y: CGFloat)
    }

    /// Half the width of the band kept clear on each side of the crease.
    static let hingeClearance: CGFloat = 24

    static func hinge(windowSize size: CGSize) -> Hinge? {
        guard isRoomy(size) else { return nil }
        return size.width >= size.height ? .vertical(x: size.width / 2) : .horizontal(y: size.height / 2)
    }

    /// Splits a span of `length` either side of a crease at `crease` (both in
    /// the span's own coordinates), keeping `hingeClearance` clear on each
    /// side. Nil when the crease is not within the span or would leave either
    /// pane under `minimumPane`: the caller keeps its single-column layout.
    static func panes(
        length: CGFloat,
        crease: CGFloat,
        minimumPane: CGFloat
    )
        -> (leading: CGFloat, trailing: CGFloat)? {
        let leading = crease - hingeClearance
        let trailing = length - crease - hingeClearance
        guard leading >= minimumPane, trailing >= minimumPane else { return nil }
        return (leading, trailing)
    }
}
