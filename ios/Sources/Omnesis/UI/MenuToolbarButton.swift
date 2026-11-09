// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Shared leading-toolbar button that toggles the global side menu
/// (`MainMenuDrawer`). Every top-level section view (Agent, Search,
/// Sources, People, Watches, Settings) plants one of these so the menu
/// is reachable from any surface without depending on the reveal
/// gesture alone.
///
/// Where the menu is docked as a sidebar (see `MenuRevealContainer`), the
/// same button shows or hides the sidebar instead, with the system's sidebar
/// glyph so it reads as that control.
@available(iOS 17.0, *)
struct MenuToolbarButton: View {
    @Binding var isOpen: Bool
    @Environment(\.menuPresentation) private var presentation
    @Environment(\.toggleSidebar) private var toggleSidebar

    var body: some View {
        if presentation.isSidebar, let toggleSidebar {
            Button(action: toggleSidebar) {
                Image(systemName: "sidebar.leading")
                    .foregroundStyle(Theme.textPrimary)
            }
            .accessibilityLabel(presentation.showsSidebar ? "Hide sidebar" : "Show sidebar")
            .accessibilityIdentifier("menu.toggle")
        } else {
            Button {
                withAnimation(MenuReveal.openCloseAnimation) {
                    isOpen.toggle()
                }
            } label: {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(Theme.textPrimary)
            }
            .accessibilityLabel("Menu")
            .accessibilityIdentifier("menu.toggle")
        }
    }
}
#endif
