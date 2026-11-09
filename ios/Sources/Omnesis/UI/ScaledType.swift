// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// How the app's fixed design sizes follow the reader's text size.
///
/// The app is designed in exact point sizes. Each size grows and shrinks with
/// the text style it sits nearest to, so at the default setting every
/// screen is exactly as designed, and larger settings scale a caption the way
/// a caption scales and a title the way a title does. Free of SwiftUI and
/// UIKit so the logic lane tests the mapping.
enum ScaledType {
    /// The text styles a design size can follow.
    enum Style: Equatable {
        case caption2, caption, footnote, subheadline, callout, body, title3, title2, title, largeTitle
    }

    /// The text style whose default size a design size sits nearest to.
    static func style(forDesignSize size: CGFloat) -> Style {
        switch size {
        case ..<11.5: .caption2
        case ..<12.5: .caption
        case ..<14.5: .footnote
        case ..<15.5: .subheadline
        case ..<16.5: .callout
        case ..<18.5: .body
        case ..<21: .title3
        case ..<25: .title2
        case ..<31: .title
        default: .largeTitle
        }
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

extension ScaledType.Style {
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .caption2: .caption2
        case .caption: .caption1
        case .footnote: .footnote
        case .subheadline: .subheadline
        case .callout: .callout
        case .body: .body
        case .title3: .title3
        case .title2: .title2
        case .title: .title1
        case .largeTitle: .largeTitle
        }
    }
}

extension ScaledType {
    /// `size` as it reads at `dynamicTypeSize`: unchanged at the default
    /// setting, scaled with its text style everywhere else.
    static func size(_ size: CGFloat, at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
        return UIFontMetrics(forTextStyle: style(forDesignSize: size).uiTextStyle)
            .scaledValue(for: size, compatibleWith: traits)
    }
}

@available(iOS 17.0, *)
private struct ScaledSystemFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let size: CGFloat
    let weight: Font.Weight?
    let design: Font.Design?

    func body(content: Content) -> some View {
        content.font(.system(size: ScaledType.size(size, at: dynamicTypeSize), weight: weight, design: design))
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
