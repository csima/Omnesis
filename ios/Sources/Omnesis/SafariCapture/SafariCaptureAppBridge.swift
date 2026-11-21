// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import Foundation
import OSLog

/// App-side lifecycle of the Safari extension's credential: minted for the
/// current pairing, removed when the phone is unpaired. A build with no
/// Safari extension has no shared Keychain group and does nothing here.
@MainActor
public enum SafariCaptureAppBridge {
    private static var current: Pairing?
    private static var minting: Pairing?
    /// Counts explicit removals, so a mint that was under way during one
    /// knows its pairing ended even if another has begun since.
    private static var removals = 0

    /// Called whenever the app has read its pairing. No pairing here is not
    /// an unpairing: a Keychain that could not be read reports none too, and
    /// removing the credential on that would make Safari drop its queue.
    public static func configure(pairing: Pairing?) {
        guard let keychain = SafariCaptureCredentials.sharedKeychain() else { return }
        current = pairing
        // One mint at a time for a pairing: a second request would leave an
        // extra token on the device that nothing holds.
        guard let pairing, minting != pairing else { return }
        minting = pairing
        let startedAt = removals
        Task {
            do {
                try await SafariCaptureCredentialProvisioner(
                    pairing: pairing,
                    store: keychain,
                    session: OmnesisURLSession.shared
                ).ensure { await isCurrent(pairing, since: startedAt) }
            } catch {
                AppLog.make(category: "safari-capture").debug(
                    "Safari capture credential deferred: \(String(describing: error))"
                )
            }
            if minting == pairing { minting = nil }
            settle(after: pairing, since: startedAt, keychain: keychain)
        }
    }

    /// The phone was unpaired, or is about to be paired again.
    public static func clear() {
        current = nil
        removals += 1
        guard let keychain = SafariCaptureCredentials.sharedKeychain() else { return }
        SafariCaptureCredentials.clear(keychain: keychain)
    }

    private static func isCurrent(_ pairing: Pairing, since startedAt: Int) -> Bool {
        removals == startedAt && current == pairing
    }

    /// The pairing can end or change in the instant between the last check
    /// and the write. Whatever is stored must belong to the pairing in force.
    private static func settle(after pairing: Pairing, since startedAt: Int, keychain: Keychain) {
        guard !isCurrent(pairing, since: startedAt) else { return }
        guard let stored = try? SafariCaptureCredentials.stored(keychain: keychain) else { return }
        guard let current else {
            if removals != startedAt { SafariCaptureCredentials.clear(keychain: keychain) }
            return
        }
        if SafariCaptureStatus.resolve(pairing: current, stored: stored, rejected: false) != .ready {
            SafariCaptureCredentials.clear(keychain: keychain)
            if minting == nil { configure(pairing: current) }
        }
    }
}
#endif
