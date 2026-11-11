// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The opt-in for handing uploads to iOS's background queue. Off until
/// turned on; the uploader reads it on every drain.
struct BackgroundUploadToggle: View {
    @AppStorage(BackgroundUploadSettings.enabledKey) private var enabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Finish uploads in the background", isOn: $enabled)
            Text(
                "While your phone is unlocked, hand uploads to iOS so they complete even if "
                    + "Omnesis is suspended. Experimental."
            )
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
        }
    }
}
#endif
