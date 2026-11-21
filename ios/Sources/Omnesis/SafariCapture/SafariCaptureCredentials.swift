// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The gateway authority the Safari extension's handler holds: a token that
/// can only add captured web pages, with the address and certificate pin it
/// is valid for. The app mints it and keeps it in a Keychain group shared with
/// the extension alone; the app's own pairing stays in a group the extension
/// cannot read.
public enum SafariCaptureCredentials {
    static let credentialKey = "safari.credential.v1"

    /// Info.plist key naming the shared Keychain group. A build without the
    /// Safari extension has no such key and never publishes a credential.
    public static let accessGroupInfoKey = "OmnesisSafariAccessGroup"

    /// The one scope the credential carries.
    public static let scope = "write:web"

    public struct StoredCredential: Codable, Equatable, Sendable {
        public let url: String
        public let token: String
        public let deviceId: String
        /// The pairing's token id, so a re-pair of the same device rotates the credential.
        public let generation: String?
        public let tlsMode: String
        public let fingerprint: String?

        public init(
            url: String,
            token: String,
            deviceId: String,
            generation: String?,
            tlsMode: String,
            fingerprint: String?
        ) {
            self.url = url
            self.token = token
            self.deviceId = deviceId
            self.generation = generation
            self.tlsMode = tlsMode
            self.fingerprint = fingerprint
        }

        /// The gateway address, when the credential is one a request may be sent with.
        public var baseURL: URL? {
            guard !token.isEmpty,
                  !deviceId.isEmpty,
                  let base = URL(string: url),
                  base.scheme?.lowercased() == "https",
                  let host = base.host,
                  !host.isEmpty
            else { return nil }
            switch PairingTlsMode(rawValue: tlsMode) {
            case .system:
                return base
            case .pinnedLeaf:
                guard let fingerprint, fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit) else {
                    return nil
                }
                return base
            case .legacy, .none:
                return nil
            }
        }
    }

    public static func sharedKeychain() -> Keychain? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: accessGroupInfoKey) as? String,
              !group.isEmpty
        else { return nil }
        return Keychain(service: "dev.omnesis.ios.safari", accessGroup: group)
    }

    public static func stored(keychain: PairingStore) throws -> StoredCredential? {
        guard let raw = try keychain.get(credentialKey), let data = raw.data(using: .utf8) else {
            return nil
        }
        return try? JSONDecoder().decode(StoredCredential.self, from: data)
    }

    /// One Keychain item is the whole credential, so the extension reads the
    /// old one, none, or the new one, and never a mix of the two.
    public static func commit(_ credential: StoredCredential, keychain: PairingStore) throws {
        let data = try JSONEncoder().encode(credential)
        guard let raw = String(data: data, encoding: .utf8) else {
            throw SafariCaptureCredentialError.invalidResponse
        }
        try keychain.set(raw, forKey: credentialKey)
    }

    public static func clear(keychain: PairingStore) {
        try? keychain.delete(credentialKey)
    }

    /// Remove `credential` if it is still the stored one. The gateway refused
    /// it, and a credential minted since must not be lost to that verdict.
    public static func discard(_ credential: StoredCredential, keychain: PairingStore) {
        guard let current = try? stored(keychain: keychain), current == credential else { return }
        clear(keychain: keychain)
    }
}

public enum SafariCaptureCredentialError: Error, Equatable {
    case insecurePairing
    case invalidResponse
    case serverError(status: Int, body: String)
}
