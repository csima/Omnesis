// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import Foundation

/// What the app's extensions are told about the pairing. Each extension has
/// its own Keychain group and its own narrow copy; none reads the app's.
@MainActor
public enum AppExtensionPairing {
    public static func configure(pairing: Pairing?) {
        TaskWidgetAppBridge.configure(pairing: pairing)
        SafariCaptureAppBridge.configure(pairing: pairing)
    }

    public static func clear() {
        TaskWidgetAppBridge.clear()
        SafariCaptureAppBridge.clear()
    }
}
#endif
