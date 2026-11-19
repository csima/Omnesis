// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// How the agent screen arranges the conversation and the Timeline
/// (citations) panel relative to one another.
///
///   - `overlay`: the Timeline slides in from the trailing edge *over*
///     the conversation as a near-full-width drawer; the conversation
///     stays full-width underneath, dimmed by a scrim. Phones, a folded
///     foldable, iPad portrait.
///   - `sidePanel`: the Timeline is docked as a fixed ~⅓-width column on
///     the trailing edge and the conversation shrinks to give way, so
///     both are legible at once. Wherever there is room for a true split:
///     iPad landscape, the unfolded inner display of a foldable iPhone.
enum AgentLayoutMode: Equatable {
    case overlay
    case sidePanel
}

/// Single decision point for the agent screen's adaptive layout.
///
/// Decided from the space the screen actually has, never from the kind of
/// device: an iPhone can be as roomy as an iPad (a foldable unfolded, a
/// resized window), and an iPad pane can be as narrow as a phone. Free of
/// SwiftUI and UIKit so the logic lane tests it natively.
///
/// Centralising the gate here means the whole split can be reverted with a
/// one-line change: flip `splitEnabled` to `false` and every consumer falls
/// back to the overlay everywhere.
enum AgentLayout {
    /// Master switch for the split. Set to `false` to ship the overlay
    /// everywhere, reverting the entire feature.
    static let splitEnabled = true

    /// Fraction of the total width the docked Timeline panel occupies in
    /// `sidePanel` mode, before clamping. ~⅓ so the conversation keeps
    /// the majority of the screen.
    static let sidePanelFraction: CGFloat = 0.34
    /// Lower clamp on the docked panel — below this the Timeline rows
    /// get too cramped to read.
    static let sidePanelMinWidth: CGFloat = 340
    /// Upper clamp — keeps the panel from ballooning on a 13" iPad while
    /// still reading as "a third".
    static let sidePanelMaxWidth: CGFloat = 480
    /// Minimum width before a split is worth doing: below it the
    /// conversation beside a minimum-width panel would be narrower than a
    /// phone, and the overlay reads better.
    static let minTotalWidthForSplit: CGFloat = 768
    /// Minimum height. A phone on its side can be as wide as an iPad, but a
    /// split there would leave both panes a letterbox tall.
    static let minHeightForSplit: CGFloat = 500
    /// The split wants a container that is not markedly taller than it is
    /// wide: in a tall one the conversation reads better at full width, with
    /// the Timeline over it. Near-square displays, like a foldable's inner
    /// one, pass.
    static let minAspectForSplit: CGFloat = 0.8

    /// Resolve the layout mode for a given available size.
    static func mode(for size: CGSize) -> AgentLayoutMode {
        guard splitEnabled,
              size.width >= minTotalWidthForSplit,
              size.height >= minHeightForSplit,
              size.width >= size.height * minAspectForSplit
        else { return .overlay }
        return .sidePanel
    }

    /// Width of the docked Timeline panel for a given total width,
    /// clamped to a comfortable band around ~⅓.
    static func sidePanelWidth(forTotalWidth total: CGFloat) -> CGFloat {
        min(sidePanelMaxWidth, max(sidePanelMinWidth, total * sidePanelFraction))
    }
}
