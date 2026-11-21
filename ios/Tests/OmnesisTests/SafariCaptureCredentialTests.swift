// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How the app mints the Safari extension's credential, and what Settings
/// reports about it.
final class SafariCaptureCredentialTests: XCTestCase {
    private let baseURL = URL(string: "https://gateway.example.test:17600")!
    private let minted = #"{"deviceId":"device_1","scopes":["write:web"],"token":"omn_web"}"#

    private func pairing(
        generation: String? = "tok_1",
        fingerprint: String? = String(repeating: "a", count: 64),
        tlsMode: PairingTlsMode? = nil,
        url: URL? = nil
    )
        -> Pairing {
        Pairing(
            url: url ?? baseURL,
            token: "omn_broad",
            pairingGeneration: generation,
            accountId: "local",
            deviceId: "device_1",
            gatewayName: "Example gateway",
            scopes: ["admin", "read"],
            fingerprint: fingerprint,
            tlsMode: tlsMode
        )
    }

    private func stored(
        token: String,
        tlsMode: String = "pinned-leaf",
        fingerprint: String? = String(repeating: "a", count: 64)
    )
        -> SafariCaptureCredentials.StoredCredential {
        .init(
            url: baseURL.absoluteString,
            token: token,
            deviceId: "device_1",
            generation: "tok_1",
            tlsMode: tlsMode,
            fingerprint: fingerprint
        )
    }

    func testMintsAWebOnlyTokenOnceAndStoresItApartFromThePairing() async throws {
        let store = InMemoryStore()
        let http = ScriptedHTTP([(200, minted)])
        let provisioner = SafariCaptureCredentialProvisioner(
            pairing: pairing(),
            store: store,
            request: http.perform
        )

        try await provisioner.ensure()
        try await provisioner.ensure()

        XCTAssertEqual(http.requests.count, 1)
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://gateway.example.test:17600/admin/tokens")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_broad")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(body["deviceId"] as? String, "device_1")
        XCTAssertEqual(body["scopes"] as? [String], ["write:web"])
        XCTAssertEqual(body["name"] as? String, "safari")
        let stored = try XCTUnwrap(SafariCaptureCredentials.stored(keychain: store))
        XCTAssertEqual(stored.token, "omn_web")
        XCTAssertEqual(stored.url, baseURL.absoluteString)
        XCTAssertEqual(stored.generation, "tok_1")
        XCTAssertEqual(stored.tlsMode, "pinned-leaf")
        XCTAssertEqual(stored.fingerprint, String(repeating: "a", count: 64))
        XCTAssertNotNil(stored.baseURL)
    }

    func testAPubliclyTrustedGatewayStoresNoFingerprint() async throws {
        let store = InMemoryStore()
        try await SafariCaptureCredentialProvisioner(
            pairing: pairing(fingerprint: nil, tlsMode: .system),
            store: store,
            request: ScriptedHTTP([(200, minted)]).perform
        ).ensure()
        let stored = try XCTUnwrap(SafariCaptureCredentials.stored(keychain: store))
        XCTAssertEqual(stored.tlsMode, "system")
        XCTAssertNil(stored.fingerprint)
        XCTAssertNotNil(stored.baseURL)
    }

    func testARepairOfTheSameDeviceRotatesTheCredential() async throws {
        let store = InMemoryStore()
        let http = ScriptedHTTP([
            (200, minted),
            (200, #"{"deviceId":"device_1","scopes":["write:web"],"token":"omn_web_2"}"#),
        ])
        try await SafariCaptureCredentialProvisioner(
            pairing: pairing(generation: "tok_1"), store: store, request: http.perform
        ).ensure()
        try await SafariCaptureCredentialProvisioner(
            pairing: pairing(generation: "tok_2"), store: store, request: http.perform
        ).ensure()
        XCTAssertEqual(http.requests.count, 2)
        let stored = try XCTUnwrap(SafariCaptureCredentials.stored(keychain: store))
        XCTAssertEqual(stored.token, "omn_web_2")
        XCTAssertEqual(stored.generation, "tok_2")
    }

    func testRefusesAPairingWithoutAVerifiedConnectionBeforeAskingTheGateway() async throws {
        let http = ScriptedHTTP([])
        let insecure: [Pairing] = try [
            pairing(fingerprint: nil, tlsMode: .legacy),
            pairing(fingerprint: "abc", tlsMode: .pinnedLeaf),
            pairing(tlsMode: .system, url: XCTUnwrap(URL(string: "http://gateway.example.test:17600"))),
        ]
        for pairing in insecure {
            let store = InMemoryStore()
            do {
                try await SafariCaptureCredentialProvisioner(
                    pairing: pairing, store: store, request: http.perform
                ).ensure()
                XCTFail("an insecure pairing must not be provisioned")
            } catch {
                XCTAssertEqual(error as? SafariCaptureCredentialError, .insecurePairing)
            }
            XCTAssertNil(try SafariCaptureCredentials.stored(keychain: store))
        }
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testStoresNothingWhenTheGatewayAnswersWithOtherAuthority() async throws {
        let answers = [
            #"{"deviceId":"device_1","scopes":["admin"],"token":"omn_admin"}"#,
            #"{"deviceId":"device_2","scopes":["write:web"],"token":"omn_web"}"#,
            #"{"deviceId":"device_1","scopes":["write:web"],"token":""}"#,
            "not json",
        ]
        for answer in answers {
            let store = InMemoryStore()
            do {
                try await SafariCaptureCredentialProvisioner(
                    pairing: pairing(), store: store, request: ScriptedHTTP([(200, answer)]).perform
                ).ensure()
                XCTFail("an unexpected answer must not be stored")
            } catch {
                XCTAssertEqual(error as? SafariCaptureCredentialError, .invalidResponse)
            }
            XCTAssertNil(try SafariCaptureCredentials.stored(keychain: store))
        }
    }

    func testReportsTheGatewaysRefusal() async throws {
        let store = InMemoryStore()
        do {
            try await SafariCaptureCredentialProvisioner(
                pairing: pairing(),
                store: store,
                request: ScriptedHTTP([(403, #"{"error":"forbidden"}"#)]).perform
            ).ensure()
            XCTFail("a refusal must throw")
        } catch {
            XCTAssertEqual(
                error as? SafariCaptureCredentialError,
                .serverError(status: 403, body: #"{"error":"forbidden"}"#)
            )
        }
        XCTAssertNil(try SafariCaptureCredentials.stored(keychain: store))
    }

    func testDiscardRemovesOnlyTheCredentialItWasGiven() throws {
        let store = InMemoryStore()
        let old = stored(token: "omn_old", tlsMode: "system", fingerprint: nil)
        let new = stored(token: "omn_new", tlsMode: "system", fingerprint: nil)
        try SafariCaptureCredentials.commit(new, keychain: store)
        SafariCaptureCredentials.discard(old, keychain: store)
        XCTAssertEqual(try SafariCaptureCredentials.stored(keychain: store), new)
        SafariCaptureCredentials.discard(new, keychain: store)
        XCTAssertNil(try SafariCaptureCredentials.stored(keychain: store))
    }

    func testStatusFollowsThePairingAndItsCredential() throws {
        let current = pairing()
        let matching = stored(token: "omn_web")
        XCTAssertEqual(SafariCaptureStatus.resolve(pairing: nil, stored: matching), .unpaired)
        XCTAssertEqual(SafariCaptureStatus.resolve(pairing: current, stored: nil), .preparing)
        XCTAssertEqual(SafariCaptureStatus.resolve(pairing: current, stored: matching), .ready)
        XCTAssertEqual(
            SafariCaptureStatus.resolve(pairing: pairing(generation: "tok_2"), stored: matching),
            .preparing,
            "a credential minted for an earlier pairing is not this pairing's"
        )
        XCTAssertEqual(
            try SafariCaptureStatus.resolve(
                pairing: pairing(url: XCTUnwrap(URL(string: "https://other.example.test"))), stored: matching
            ),
            .preparing
        )
    }
}

private final class ScriptedHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [(Int, String)]
    private var sent: [URLRequest] = []

    init(_ answers: [(Int, String)]) {
        self.answers = answers
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    private func next(for request: URLRequest) -> (Int, String)? {
        lock.lock()
        defer { lock.unlock() }
        sent.append(request)
        return answers.isEmpty ? nil : answers.removeFirst()
    }

    lazy var perform: SafariCaptureCredentialProvisioner.Request = { [self] request in
        guard let answer = next(for: request), let url = request.url,
              let response = HTTPURLResponse(
                  url: url, statusCode: answer.0, httpVersion: "HTTP/1.1", headerFields: nil
              )
        else { throw URLError(.badServerResponse) }
        return (Data(answer.1.utf8), response)
    }
}
