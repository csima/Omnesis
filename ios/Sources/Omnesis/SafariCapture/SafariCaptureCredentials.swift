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
    static let rejectedKey = "safari.credential.rejected.v1"

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

    /// Whether this build carries the Safari extension at all.
    public static var isAvailable: Bool {
        accessGroup != nil
    }

    private static var accessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: accessGroupInfoKey) as? String,
              !group.isEmpty
        else { return nil }
        return group
    }

    public static func sharedKeychain() -> Keychain? {
        accessGroup.map { Keychain(service: "dev.omnesis.ios.safari", accessGroup: $0) }
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
        if (try? keychain.get(rejectedKey)) != credential.token {
            try? keychain.delete(rejectedKey)
        }
    }

    public static func clear(keychain: PairingStore) {
        try? keychain.delete(credentialKey)
        try? keychain.delete(rejectedKey)
    }

    /// Record that the gateway refused `credential`. The credential stays, so
    /// Safari still knows which pairing its waiting pages belong to; the app
    /// mints another the next time it runs.
    public static func markRejected(_ credential: StoredCredential, keychain: PairingStore) {
        try? keychain.set(credential.token, forKey: rejectedKey)
    }

    public static func isRejected(_ credential: StoredCredential, keychain: PairingStore) -> Bool {
        (try? keychain.get(rejectedKey)) == credential.token
    }
}

public enum SafariCaptureCredentialError: Error, Equatable {
    case insecurePairing
    case invalidResponse
    case serverError(status: Int, body: String)
}
