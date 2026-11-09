// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension CaptureView {
    /// How the surface is laid out on this display.
    ///
    /// On a phone, and wherever this view does not span the display's crease,
    /// it is one column with the mic in the middle. On a roomy display that
    /// can fold — a foldable's inner display, which also covers an iPad — the
    /// middle is where the crease runs, so the mic and the actions move to
    /// either side of it instead: beside the note when the crease runs top to
    /// bottom, below it when the crease runs side to side, so they rest on
    /// the lower half a half-folded phone stands on. At an accessibility text
    /// size the stacked halves are too short for the note, so that case keeps
    /// the column: legible text outranks keeping off the crease.
    enum Arrangement: Equatable {
        case column
        /// Panes either side of a crease running top to bottom; the width of
        /// the leading one, measured from this view's leading edge.
        case sideBySide(leading: CGFloat)
        /// Panes either side of a crease running side to side; the heights
        /// of the upper and lower ones.
        case stacked(top: CGFloat, bottom: CGFloat)
    }

    static let minimumSidePane: CGFloat = 280
    static let minimumStackedPane: CGFloat = 240

    var arrangement: Arrangement {
        Self.arrangement(
            hinge: foldHinge,
            frameInWindow: frameInWindow,
            largeText: dynamicTypeSize.isAccessibilitySize
        )
    }

    static func arrangement(
        hinge: AdaptiveLayout.Hinge?,
        frameInWindow frame: CGRect,
        largeText: Bool = false
    )
        -> Arrangement {
        guard frame.width > 0, frame.height > 0 else { return .column }
        switch hinge {
        case .vertical(let x):
            guard let panes = AdaptiveLayout.panes(
                length: frame.width, crease: x - frame.minX, minimumPane: minimumSidePane
            ) else { return .column }
            return .sideBySide(leading: panes.leading)
        case .horizontal(let y):
            guard !largeText, let panes = AdaptiveLayout.panes(
                length: frame.height, crease: y - frame.minY, minimumPane: minimumStackedPane
            ) else { return .column }
            return .stacked(top: panes.leading, bottom: panes.trailing)
        case nil:
            return .column
        }
    }

    /// The halo sits behind the mic wherever the arrangement puts it.
    var haloFocus: CGPoint {
        guard frameInWindow.width > 0, frameInWindow.height > 0 else {
            return CGPoint(x: 0.5, y: Self.micCentreY)
        }
        switch arrangement {
        case .column:
            return CGPoint(x: 0.5, y: Self.micCentreY)
        case .sideBySide(let leading):
            return CGPoint(x: leading / 2 / frameInWindow.width, y: 0.5)
        case .stacked(let top, let bottom):
            let gap = frameInWindow.height - top - bottom
            return CGPoint(x: 0.5, y: (top + gap + bottom * 0.4) / frameInWindow.height)
        }
    }

    @ViewBuilder var arrangedContent: some View {
        switch arrangement {
        case .column:
            columnLayout
        case .sideBySide(let leading):
            sideBySideLayout(leading: leading)
        case .stacked(let top, let bottom):
            stackedLayout(top: top, bottom: bottom)
        }
    }

    private var columnLayout: some View {
        VStack(spacing: 0) {
            header
            notices
            Spacer(minLength: Theme.Spacing.lg)
            micCluster
            Spacer(minLength: Theme.Spacing.lg)
            entryArea
            saveErrorLine
            actions
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.lg)
    }

    /// The mic in the middle of the leading pane, the note and its actions in
    /// the trailing one, and the crease between them left clear.
    private func sideBySideLayout(leading: CGFloat) -> some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Spacing.lg)
            HStack(spacing: AdaptiveLayout.hingeClearance * 2) {
                VStack(spacing: 0) {
                    notices
                    Spacer(minLength: Theme.Spacing.lg)
                    micCluster
                    Spacer(minLength: Theme.Spacing.lg)
                }
                .padding(.leading, Theme.Spacing.lg)
                .frame(width: leading)
                VStack(spacing: 0) {
                    Spacer(minLength: Theme.Spacing.lg)
                    entryArea
                    saveErrorLine
                    actions
                }
                .padding(.trailing, Theme.Spacing.lg)
                .frame(maxWidth: .infinity)
            }
            .padding(.bottom, Theme.Spacing.lg)
        }
    }

    /// The note above the crease; the mic and the actions below it.
    private func stackedLayout(top: CGFloat, bottom: CGFloat) -> some View {
        VStack(spacing: AdaptiveLayout.hingeClearance * 2) {
            VStack(spacing: 0) {
                header
                notices
                Spacer(minLength: Theme.Spacing.md)
                entryArea
            }
            .frame(maxWidth: .infinity)
            .frame(height: top, alignment: .top)
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                micCluster
                Spacer(minLength: Theme.Spacing.lg)
                saveErrorLine
                actions
            }
            .padding(.bottom, Theme.Spacing.lg)
            .frame(maxWidth: .infinity)
            .frame(height: bottom)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder private var notices: some View {
        if completion == nil { NoteProcessingNotice() }
        if let subject = completion?.subject ?? taskContext?.title {
            Text(subject)
                .accessibilityLabel(taskContext == nil ? subject : "Task context: \(subject)")
                .scaledFont(size: 15)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.top, Theme.Spacing.md)
        }
    }

    @ViewBuilder private var entryArea: some View {
        if isVoiceNote, voiceNote.hasRecording {
            voiceNoteCard
        } else {
            transcriptArea
        }
    }

    @ViewBuilder private var actions: some View {
        if unified { unifiedButtons } else { doneButton }
    }
}
#endif
