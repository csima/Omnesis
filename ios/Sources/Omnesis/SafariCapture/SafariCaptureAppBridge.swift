// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import Foundation
import OSLog

/// App-side lifecycle of the Safari extension's credential: minted for the
/// current pairing, removed with it. A build with no Safari extension has no
/// shared Keychain group and does nothing here.
@MainActor
public enum SafariCaptureAppBridge {
    private static var current: Pairing?
    private static var minting: Pairing?

    public static func configure(pairing: Pairing?) {
        guard let keychain = SafariCaptureCredentials.sharedKeychain() else { return }
        current = pairing
        guard let pairing else {
            SafariCaptureCredentials.clear(keychain: keychain)
            return
        }
        // One mint at a time for a pairing: a second request would leave an
        // extra token on the device that nothing holds.
        guard minting != pairing else { return }
        minting = pairing
        Task {
            do {
                try await SafariCaptureCredentialProvisioner(
                    pairing: pairing,
                    store: keychain,
                    session: OmnesisURLSession.shared
                ).ensure()
            } catch {
                AppLog.make(category: "safari-capture").debug(
                    "Safari capture credential deferred: \(String(describing: error))"
                )
            }
            if minting == pairing { minting = nil }
            // The pairing ended while the gateway was answering; its
            // credential must not outlive it.
            if current == nil { SafariCaptureCredentials.clear(keychain: keychain) }
        }
    }

    public static func clear() {
        current = nil
        guard let keychain = SafariCaptureCredentials.sharedKeychain() else { return }
        SafariCaptureCredentials.clear(keychain: keychain)
    }
}
#endif
