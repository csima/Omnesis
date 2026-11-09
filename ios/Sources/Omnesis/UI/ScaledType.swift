// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// How the app's fixed design sizes follow the reader's text size.
///
/// The app is designed in exact point sizes at the default text size. Every
/// size up to body text scales by the same factor body text does, so small
/// labels stay in proportion to one another and never swap order; sizes above
/// body text grow by the same number of points body text gains, the way the
/// system's own titles grow less than its body. At the default setting every
/// size is returned exactly, fractions included, and at the smaller settings
/// nothing designed at 11pt or more goes below 11pt. Free of SwiftUI and
/// UIKit so the logic lane tests it.
enum ScaledType {
    /// The size body text takes at each text-size setting, smallest to
    /// largest, from extra small to the fifth accessibility size, per the
    /// Human Interface Guidelines. Index 3 is the default.
    static let bodySizes: [CGFloat] = [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53]
    static let defaultBodySize: CGFloat = 17
    static let minimumReadableSize: CGFloat = 11

    /// `size` as it reads when body text is `bodySize`.
    static func size(_ size: CGFloat, bodySize: CGFloat) -> CGFloat {
        guard bodySize != defaultBodySize else { return size }
        let ratio = bodySize / defaultBodySize
        let scaled = size <= defaultBodySize
            ? size * ratio
            : bodySize + (size - defaultBodySize)
        return max(scaled, min(size, minimumReadableSize))
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension ScaledType {
    static func bodySize(at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        let index = DynamicTypeSize.allCases.firstIndex(of: dynamicTypeSize) ?? 3
        return bodySizes[min(index, bodySizes.count - 1)]
    }

    /// `size` as it reads at `dynamicTypeSize`.
    static func size(_ size: CGFloat, at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        self.size(size, bodySize: bodySize(at: dynamicTypeSize))
    }
}

extension Font {
    /// The system font at a design size, scaled for `dynamicTypeSize`. For
    /// text joined with `+`, which needs a `Font` rather than a modifier; the
    /// view reads `dynamicTypeSize` from its environment.
    static func scaledSystem(
        size: CGFloat,
        weight: Font.Weight? = nil,
        design: Font.Design? = nil,
        at dynamicTypeSize: DynamicTypeSize
    ) -> Font {
        .system(size: ScaledType.size(size, at: dynamicTypeSize), weight: weight, design: design)
    }
}

@available(iOS 17.0, *)
private struct ScaledSystemFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let size: CGFloat
    let weight: Font.Weight?
    let design: Font.Design?

    func body(content: Content) -> some View {
        content.font(.scaledSystem(size: size, weight: weight, design: design, at: dynamicTypeSize))
    }
}

@available(iOS 17.0, *)
extension View {
    /// The system font at a design size that follows the reader's text size.
    /// Use it for text; a glyph sized to sit in a fixed frame keeps
    /// `.font(.system(size:))`.
    func scaledFont(size: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil) -> some View {
        modifier(ScaledSystemFont(size: size, weight: weight, design: design))
    }
}
#endif
