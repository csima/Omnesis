// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What Settings says about capturing the pages read in Safari.
public enum SafariCaptureStatus: Equatable, Sendable {
    /// This build carries no Safari extension.
    case unavailable
    case unpaired
    /// Paired, and the extension's credential is not stored yet.
    case preparing
    case ready

    public static func current(pairing: Pairing?) -> SafariCaptureStatus {
        guard let keychain = SafariCaptureCredentials.sharedKeychain() else { return .unavailable }
        return resolve(pairing: pairing, stored: try? SafariCaptureCredentials.stored(keychain: keychain))
    }

    static func resolve(
        pairing: Pairing?,
        stored: SafariCaptureCredentials.StoredCredential?
    )
        -> SafariCaptureStatus {
        guard let pairing else { return .unpaired }
        guard let stored,
              stored.baseURL != nil,
              stored.url == pairing.url.absoluteString,
              stored.deviceId == pairing.deviceId,
              stored.generation == pairing.pairingGeneration
        else { return .preparing }
        return .ready
    }

    /// What is and is not read from Safari, in the wording of the phone's other sources.
    public static let ledger = PhoneSetupLedger(
        sent: [
            "The readable text of pages you stay on",
            "Each page's address and title",
            "When you read it and for how long",
        ],
        staysLabel: "Never read",
        stays: [
            "Private Browsing tabs",
            "Sign-in, verification and checkout pages",
            "Sites you exclude, and everything while paused",
        ]
    )
}
