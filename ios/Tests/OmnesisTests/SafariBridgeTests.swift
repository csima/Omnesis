// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The app's half of the Safari extension: which requests it will make for
/// the extension's JavaScript, with which credential, and what it tells the
/// script about the pairing.
final class SafariBridgeTests: XCTestCase {
    private struct Vector: Decodable {
        let method: String
        let path: String
    }

    private struct Vectors: Decodable {
        let allowed: [Vector]
        let refused: [Vector]
    }

    private let fingerprint = String(repeating: "a", count: 64)

    private func credential(
        token: String = "omn_web",
        url: String = "https://gateway.example.test:17600",
        tlsMode: String = "pinned-leaf",
        fingerprint: String? = String(repeating: "a", count: 64)
    ) -> SafariCaptureCredentials.StoredCredential {
        .init(
            url: url,
            token: token,
            deviceId: "device_1",
            generation: "tok_1",
            tlsMode: tlsMode,
            fingerprint: fingerprint
        )
    }

    private func store(
        holding credential: SafariCaptureCredentials.StoredCredential?
    ) throws -> InMemoryStore {
        let store = InMemoryStore()
        if let credential { try SafariCaptureCredentials.commit(credential, keychain: store) }
        return store
    }

    /// The cases the extension's own check is tested against (native-contract.test.ts).
    func testAllowListMatchesTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/safari-bridge-requests.json")
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(vectors.allowed.count, 5)
        XCTAssertGreaterThan(vectors.refused.count, 20)
        for vector in vectors.allowed {
            XCTAssertTrue(
                SafariBridgeRequest.isAllowed(method: vector.method, path: vector.path),
                "\(vector.method) \(vector.path) must be allowed"
            )
        }
        for vector in vectors.refused {
            XCTAssertFalse(
                SafariBridgeRequest.isAllowed(method: vector.method, path: vector.path),
                "\(vector.method) \(vector.path) must be refused"
            )
        }
    }

    func testStatusNamesTheDeviceAndHostAndNothingSecret() async throws {
        let bridge = try SafariBridge(store: store(holding: credential())) { _, _ in
            throw URLError(.badURL)
        }
        let reply = await bridge.respond(to: ["type": "status"])
        XCTAssertEqual(reply["paired"] as? Bool, true)
        XCTAssertEqual(reply["deviceId"] as? String, "device_1")
        XCTAssertEqual(reply["gatewayHost"] as? String, "gateway.example.test")
        XCTAssertEqual(reply.count, 3)
    }

    func testStatusIsUnpairedWithoutAUsableCredential() async throws {
        let unusable: [SafariCaptureCredentials.StoredCredential?] = [
            nil,
            credential(token: ""),
            credential(url: "http://gateway.example.test:17600"),
            credential(tlsMode: "legacy", fingerprint: nil),
            credential(tlsMode: "pinned-leaf", fingerprint: "abc"),
        ]
        for stored in unusable {
            let bridge = try SafariBridge(store: store(holding: stored)) { _, _ in
                throw URLError(.badURL)
            }
            let reply = await bridge.respond(to: ["type": "status"])
            XCTAssertEqual(reply["paired"] as? Bool, false)
            XCTAssertEqual(reply.count, 1)
        }
        let noGroup = SafariBridge(store: nil) { _, _ in throw URLError(.badURL) }
        let reply = await noGroup.respond(to: ["type": "status"])
        XCTAssertEqual(reply["paired"] as? Bool, false)
    }

    func testAnAllowedRequestGoesToThePairedGatewayWithTheWebCredential() async throws {
        let sent = Recorder()
        let bridge = try SafariBridge(store: store(holding: credential())) { request, stored in
            sent.record(request, stored)
            return try Self.reply(to: request, status: 200, body: #"{"ingested":1}"#, headers: [
                "Retry-After": "30",
            ])
        }

        let message: [String: Any] = [
            "type": "request",
            "method": "POST",
            "path": "/documents",
            "body": #"{"documents":[]}"#,
            "headers": ["Authorization": "Bearer from-the-page"],
        ]
        let reply = await bridge.respond(to: message)

        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertEqual(reply["status"] as? Int, 200)
        XCTAssertEqual(reply["body"] as? String, #"{"ingested":1}"#)
        XCTAssertEqual(reply["retryAfter"] as? String, "30")
        let request = try XCTUnwrap(sent.requests.first)
        XCTAssertEqual(sent.requests.count, 1)
        XCTAssertEqual(request.url?.absoluteString, "https://gateway.example.test:17600/documents")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_web")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.httpBody, Data(#"{"documents":[]}"#.utf8))
        XCTAssertEqual(sent.credentials.first?.fingerprint, fingerprint)
    }

    func testAReadCarriesNoBody() async throws {
        let sent = Recorder()
        let bridge = try SafariBridge(store: store(holding: credential())) { request, stored in
            sent.record(request, stored)
            return try Self.reply(to: request, status: 200, body: "{}")
        }
        let reply = await bridge.respond(to: [
            "type": "request", "method": "GET", "path": "/web-capture-policy",
        ])
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertNil(reply["retryAfter"])
        XCTAssertNil(sent.requests.first?.httpBody)
        XCTAssertNil(sent.requests.first?.value(forHTTPHeaderField: "Content-Type"))
    }

    func testNothingOutsideTheContractIsSent() async throws {
        let sent = Recorder()
        let bridge = try SafariBridge(store: store(holding: credential())) { request, stored in
            sent.record(request, stored)
            return try Self.reply(to: request, status: 200, body: "{}")
        }
        let oversized = String(repeating: "x", count: SafariBridge.maxBodyBytes + 1)
        let structuredBody: [String: Any] = [
            "type": "request", "method": "POST", "path": "/documents", "body": ["documents": [String]()],
        ]
        let requests: [[String: String]] = [
            ["type": "open-url"],
            ["type": "request", "method": "POST"],
            ["type": "request", "method": "POST", "path": "/admin/tokens", "body": "{}"],
            ["type": "request", "method": "GET", "path": "/search?q=budget"],
            ["type": "request", "method": "POST", "path": "//attacker.example/documents"],
            ["type": "request", "method": "POST", "path": "/documents", "body": oversized],
        ]
        let messages: [Any?] = [nil, "status", structuredBody] + requests.map { $0 as Any? }
        for message in messages {
            let reply = await bridge.respond(to: message)
            XCTAssertEqual(reply["ok"] as? Bool, false)
            XCTAssertEqual(reply["reason"] as? String, "refused")
        }
        XCTAssertTrue(sent.requests.isEmpty)
    }

    func testARequestWithoutAPairingIsUnpaired() async throws {
        let sent = Recorder()
        let bridge = try SafariBridge(store: store(holding: nil)) { request, stored in
            sent.record(request, stored)
            return try Self.reply(to: request, status: 200, body: "{}")
        }
        let reply = await bridge.respond(to: [
            "type": "request", "method": "GET", "path": "/web-capture-policy",
        ])
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["reason"] as? String, "unpaired")
        XCTAssertTrue(sent.requests.isEmpty)
    }

    func testAnUnreachableGatewayIsANetworkFailure() async throws {
        let bridge = try SafariBridge(store: store(holding: credential())) { _, _ in
            throw URLError(.timedOut)
        }
        let reply = await bridge.respond(to: [
            "type": "request", "method": "GET", "path": "/web-capture-policy",
        ])
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["reason"] as? String, "network")
    }

    func testARefusedCredentialIsDroppedSoTheAppMintsAnother() async throws {
        let keychain = try store(holding: credential())
        let bridge = SafariBridge(store: keychain) { request, _ in
            try Self.reply(to: request, status: 401, body: #"{"error":"unauthorized"}"#)
        }
        let reply = await bridge.respond(to: [
            "type": "request", "method": "POST", "path": "/documents", "body": "{}",
        ])
        XCTAssertEqual(reply["status"] as? Int, 401)
        XCTAssertNil(try SafariCaptureCredentials.stored(keychain: keychain))
    }

    func testACredentialMintedMeanwhileSurvivesAnOlderRefusal() async throws {
        let keychain = try store(holding: credential(token: "omn_old"))
        let renewed = credential(token: "omn_new")
        let bridge = SafariBridge(store: keychain) { request, _ in
            try SafariCaptureCredentials.commit(renewed, keychain: keychain)
            return try Self.reply(to: request, status: 401, body: "")
        }
        _ = await bridge.respond(to: [
            "type": "request", "method": "POST", "path": "/documents", "body": "{}",
        ])
        XCTAssertEqual(try SafariCaptureCredentials.stored(keychain: keychain), renewed)
    }

    func testOtherGatewayVerdictsKeepTheCredential() async throws {
        let keychain = try store(holding: credential())
        let bridge = SafariBridge(store: keychain) { request, _ in
            try Self.reply(to: request, status: 403, body: "")
        }
        let reply = await bridge.respond(to: [
            "type": "request", "method": "POST", "path": "/documents", "body": "{}",
        ])
        XCTAssertEqual(reply["status"] as? Int, 403)
        XCTAssertNotNil(try SafariCaptureCredentials.stored(keychain: keychain))
    }

    private static func reply(
        to request: URLRequest,
        status: Int,
        body: String,
        headers: [String: String] = [:]
    ) throws -> (Data, HTTPURLResponse) {
        let url = try XCTUnwrap(request.url)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ))
        return (Data(body.utf8), response)
    }
}

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequests: [URLRequest] = []
    private var storedCredentials: [SafariCaptureCredentials.StoredCredential] = []

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storedRequests
    }

    var credentials: [SafariCaptureCredentials.StoredCredential] {
        lock.lock()
        defer { lock.unlock() }
        return storedCredentials
    }

    func record(_ request: URLRequest, _ credential: SafariCaptureCredentials.StoredCredential) {
        lock.lock()
        defer { lock.unlock() }
        storedRequests.append(request)
        storedCredentials.append(credential)
    }
}
