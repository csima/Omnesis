// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

private struct FoldHingeKey: EnvironmentKey {
    static let defaultValue: AdaptiveLayout.Hinge? = nil
}

extension EnvironmentValues {
    /// Where the display may fold, in window (`.global`) coordinates, or nil
    /// on a phone-sized display. See `AdaptiveLayout.Hinge`.
    var foldHinge: AdaptiveLayout.Hinge? {
        get { self[FoldHingeKey.self] }
        set { self[FoldHingeKey.self] = newValue }
    }
}

@available(iOS 17.0, *)
private struct FoldHingePublisher: ViewModifier {
    @State private var windowSize: CGSize = .zero

    func body(content: Content) -> some View {
        content
            .background {
                // Measured edge to edge, safe areas included: the crease is
                // the middle of the display, not of the content area.
                GeometryReader { geo in
                    Color.clear
                        .onAppear { windowSize = geo.size }
                        .onChange(of: geo.size) { _, newSize in windowSize = newSize }
                }
                .ignoresSafeArea()
            }
            .environment(\.foldHinge, AdaptiveLayout.hinge(windowSize: windowSize))
    }
}

@available(iOS 17.0, *)
extension View {
    /// Publishes where the display may fold to everything inside. Apply once,
    /// at a view that fills the window.
    func publishesFoldHinge() -> some View {
        modifier(FoldHingePublisher())
    }
}
#endif
