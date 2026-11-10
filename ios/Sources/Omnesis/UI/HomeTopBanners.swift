// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What sits above the home shell's section: a waiting access request first,
/// then the permission and notification problems.
struct HomeTopBanners: View {
    @Environment(AppStore.self) private var store
    @Binding var accessBannerState: AccessPendingRequestBannerState
    let onReviewAccessRequest: (AccessPendingRequest) -> Void
    let onOpenPermissions: () -> Void

    var body: some View {
        let offer = accessBannerState.offer(
            from: store.pendingAccessRequests,
            nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
        )
        let showNotificationWarning = NotificationWarningDismissal.shouldShowWarning(
            health: store.pushDeliveryHealth,
            dismissed: store.notificationWarningDismissed
        )
        let showsAttention = !store.degradedSourcePermissions.isEmpty || showNotificationWarning
        VStack(spacing: 0) {
            if let offer {
                AccessPendingRequestBanner(
                    offer: offer,
                    onReview: { onReviewAccessRequest(offer.newest) },
                    onDismiss: {
                        accessBannerState.dismiss(
                            store.pendingAccessRequests,
                            nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
                        )
                    }
                )
            }
            // Gateway push setup is explained in Settings → Notifications, not here:
            // it asks whoever runs the gateway to act, and a banner over every screen
            // hides the controls beneath it.
            if showsAttention {
                AppAttentionBanner(
                    problems: store.degradedSourcePermissions,
                    notificationWarning: showNotificationWarning ? store.pushDeliveryHealth.warning : nil,
                    onOpenPermissions: onOpenPermissions,
                    onOpenNotificationSettings: {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    },
                    onDismissNotification: showNotificationWarning ? { store.dismissNotificationWarning() } : nil
                )
            }
        }
        // The banners own the status-bar strip above them while they show,
        // so they read as attached to the top edge rather than floating.
        .background {
            if offer != nil || showsAttention {
                Theme.bgSecondary.ignoresSafeArea(edges: .top)
            }
        }
    }
}
#endif
