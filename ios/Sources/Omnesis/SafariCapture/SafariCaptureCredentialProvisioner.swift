// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Mints and stores the Safari extension's web-capture credential. The app's
/// own paired token stays in its Keychain group, which the extension is not
/// entitled to read.
public struct SafariCaptureCredentialProvisioner: Sendable {
    public typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let pairing: Pairing
    private let store: PairingStore
    private let request: Request

    public init(pairing: Pairing, store: PairingStore, session: URLSessionLike) {
        self.init(pairing: pairing, store: store) { request in
            try await session.data(for: request)
        }
    }

    public init(pairing: Pairing, store: PairingStore, request: @escaping Request) {
        self.pairing = pairing
        self.store = store
        self.request = request
    }

    /// Idempotent for one pairing. Another gateway, device, pairing or trust
    /// rule mints a new credential in place of the stored one.
    public func ensure() async throws {
        guard pairing.url.scheme?.lowercased() == "https" else {
            throw SafariCaptureCredentialError.insecurePairing
        }
        let fingerprint: String?
        switch pairing.tlsMode {
        case .system:
            fingerprint = nil
        case .pinnedLeaf:
            guard let value = pairing.fingerprint,
                  value.count == 64,
                  value.allSatisfy(\.isHexDigit)
            else { throw SafariCaptureCredentialError.insecurePairing }
            fingerprint = value.lowercased()
        case .legacy:
            throw SafariCaptureCredentialError.insecurePairing
        }
        if let stored = try SafariCaptureCredentials.stored(keychain: store),
           stored.url == pairing.url.absoluteString,
           stored.deviceId == pairing.deviceId,
           stored.generation == pairing.pairingGeneration,
           stored.tlsMode == pairing.tlsMode.rawValue,
           stored.fingerprint == fingerprint,
           !stored.token.isEmpty {
            return
        }

        guard let url = URL(string: "/admin/tokens", relativeTo: pairing.url)?.absoluteURL else {
            throw SafariCaptureCredentialError.insecurePairing
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(
            MintBody(
                deviceId: pairing.deviceId,
                scopes: [SafariCaptureCredentials.scope],
                name: "safari"
            )
        )
        let (data, response) = try await request(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw SafariCaptureCredentialError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw SafariCaptureCredentialError.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
        guard let minted = try? JSONDecoder().decode(MintResponse.self, from: data),
              minted.deviceId == pairing.deviceId,
              minted.scopes == [SafariCaptureCredentials.scope],
              !minted.token.isEmpty
        else {
            throw SafariCaptureCredentialError.invalidResponse
        }

        try SafariCaptureCredentials.commit(
            .init(
                url: pairing.url.absoluteString,
                token: minted.token,
                deviceId: pairing.deviceId,
                generation: pairing.pairingGeneration,
                tlsMode: pairing.tlsMode.rawValue,
                fingerprint: fingerprint
            ),
            keychain: store
        )
    }

    private struct MintBody: Encodable {
        let deviceId: String
        let scopes: [String]
        let name: String
    }

    private struct MintResponse: Decodable {
        let deviceId: String
        let scopes: [String]
        let token: String
    }
}
