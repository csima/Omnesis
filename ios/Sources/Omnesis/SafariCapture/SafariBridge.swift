// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Answers the Safari extension's messages. The extension's JavaScript holds
/// no gateway address, credential or certificate pin; it names a request and
/// this decides whether to send it, to the paired gateway only, with the
/// web-capture credential only.
public struct SafariBridge: Sendable {
    public typealias Transport = @Sendable (
        URLRequest,
        SafariCaptureCredentials.StoredCredential
    ) async throws
        -> (Data, HTTPURLResponse)

    /// A page's text is capped far below this by the extension.
    static let maxBodyBytes = 2 * 1024 * 1024
    static let requestTimeout: TimeInterval = 15

    private let store: PairingStore?
    private let transport: Transport

    public init(store: PairingStore?, transport: @escaping Transport) {
        self.store = store
        self.transport = transport
    }

    /// The bridge the extension runs: the shared Keychain group and the
    /// pairing's own trust rule.
    public static var live: SafariBridge {
        SafariBridge(store: SafariCaptureCredentials.sharedKeychain(), transport: liveTransport)
    }

    public func respond(to message: Any?) async -> [String: Any] {
        guard let message = message as? [String: Any], let type = message["type"] as? String else {
            return Self.failure("refused")
        }
        switch type {
        case "status":
            return status()
        case "request":
            return await request(message)
        default:
            return Self.failure("refused")
        }
    }

    private func credential() -> (SafariCaptureCredentials.StoredCredential, URL)? {
        guard let store,
              let stored = try? SafariCaptureCredentials.stored(keychain: store),
              let base = stored.baseURL
        else { return nil }
        return (stored, base)
    }

    private func status() -> [String: Any] {
        guard let (stored, base) = credential(), let host = base.host else {
            return ["paired": false]
        }
        return ["paired": true, "deviceId": stored.deviceId, "gatewayHost": host]
    }

    private func request(_ message: [String: Any]) async -> [String: Any] {
        guard let method = message["method"] as? String,
              let path = message["path"] as? String,
              SafariBridgeRequest.isAllowed(method: method, path: path)
        else { return Self.failure("refused") }
        let body = message["body"] as? String
        if message["body"] != nil, body == nil { return Self.failure("refused") }
        if let body, body.utf8.count > Self.maxBodyBytes { return Self.failure("refused") }
        guard let (stored, base) = credential() else { return Self.failure("unpaired") }
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.scheme?.lowercased() == "https",
              url.host == base.host,
              url.port == base.port
        else { return Self.failure("refused") }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = Self.requestTimeout
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("Bearer \(stored.token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = Data(body.utf8)
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport(urlRequest, stored)
        } catch {
            return Self.failure("network")
        }
        if response.statusCode == 401, let store {
            // The gateway no longer accepts this credential. Dropping it lets
            // the app mint a new one the next time it runs.
            SafariCaptureCredentials.discard(stored, keychain: store)
        }
        var reply: [String: Any] = [
            "ok": true,
            "status": response.statusCode,
            "body": String(data: data, encoding: .utf8) ?? "",
        ]
        if let retryAfter = response.value(forHTTPHeaderField: "Retry-After") {
            reply["retryAfter"] = retryAfter
        }
        return reply
    }

    private static func failure(_ reason: String) -> [String: Any] {
        ["ok": false, "reason": reason]
    }

    private static let liveTransport: Transport = { request, credential in
        let session: URLSession
        switch PairingTlsMode(rawValue: credential.tlsMode) {
        case .system:
            session = URLSession(configuration: .ephemeral)
        case .pinnedLeaf:
            guard let fingerprint = credential.fingerprint else {
                throw URLError(.secureConnectionFailed)
            }
            session = PinnedSession(fingerprintHex: fingerprint, host: request.url?.host).session
        case .legacy, .none:
            throw URLError(.secureConnectionFailed)
        }
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request, delegate: RedirectRefusal())
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// The credential is for one gateway. A redirect is answered as it stands
/// rather than followed to wherever it points.
private final class RedirectRefusal: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
