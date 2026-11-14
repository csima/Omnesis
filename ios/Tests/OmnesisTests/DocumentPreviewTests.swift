// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class DocumentPreviewDecodeTests: XCTestCase {
    private let previewJSON = """
    {"url":"/documents/doc-1/preview","contentType":"image/webp","width":1440,"height":900,"capturedAt":"2026-11-14T08:00:00Z"}
    """

    private func documentJSON(preview: String?) -> Data {
        var fields = """
        "id":"doc-1","provider_id":"web","source_id":"web","external_id":"https://example.com/",
        "title":"Example page","content":"Body","content_hash":"sha256:x","metadata":"{}",
        "source_created_at":"2026-11-14T08:00:00Z"
        """
        if let preview { fields += ",\"preview\":\(preview)" }
        return Data("{\(fields)}".utf8)
    }

    private func searchJSON(preview: String?) -> Data {
        var fields = """
        "documentId":"doc-1","sourceId":"web","documentType":"page","title":"Example page",
        "sourceCreatedAt":"2026-11-14T08:00:00Z","chunkText":"Body","score":0.5
        """
        if let preview { fields += ",\"preview\":\(preview)" }
        return Data("{\"results\":[{\(fields)}]}".utf8)
    }

    func testDocumentDecodesPreview() throws {
        let doc = try JSONDecoder().decode(DocumentDetail.self, from: documentJSON(preview: previewJSON))
        XCTAssertEqual(doc.preview, DocumentPreview(
            url: "/documents/doc-1/preview",
            contentType: "image/webp",
            width: 1440,
            height: 900,
            capturedAt: "2026-11-14T08:00:00Z"
        ))
        XCTAssertEqual(try XCTUnwrap(doc.preview?.aspectRatio), 1.6, accuracy: 0.0001)
    }

    func testDocumentWithoutPreviewDecodesAsBefore() throws {
        let doc = try JSONDecoder().decode(DocumentDetail.self, from: documentJSON(preview: nil))
        XCTAssertNil(doc.preview)
        XCTAssertEqual(doc.title, "Example page")
    }

    func testUnreadablePreviewDegradesToNil() throws {
        for bad in [
            #"{"url":"/documents/doc-1/preview","contentType":"image/webp","width":"wide","height":900,"capturedAt":"x"}"#,
            #"{"url":"","contentType":"image/jpeg","width":10,"height":10,"capturedAt":"x"}"#,
            #""not an object""#,
            "null",
        ] {
            let doc = try JSONDecoder().decode(DocumentDetail.self, from: documentJSON(preview: bad))
            XCTAssertNil(doc.preview, bad)
            let response = try JSONDecoder().decode(SearchResponse.self, from: searchJSON(preview: bad))
            XCTAssertEqual(response.results.count, 1)
            XCTAssertNil(response.results[0].preview, bad)
        }
    }

    func testSearchResultDecodesPreview() throws {
        let withPreview = try JSONDecoder().decode(SearchResponse.self, from: searchJSON(preview: previewJSON))
        XCTAssertEqual(withPreview.results[0].preview?.url, "/documents/doc-1/preview")
        XCTAssertEqual(withPreview.results[0].preview?.contentType, "image/webp")
        let without = try JSONDecoder().decode(SearchResponse.self, from: searchJSON(preview: nil))
        XCTAssertNil(without.results[0].preview)
    }

    func testRecentDocumentDecodesPreview() throws {
        let json = """
        {"kind":"documents","documents":[
          {"id":"doc-1","sourceId":"web","externalId":"e1","title":"With","sourceCreatedAt":"2026-11-14T08:00:00Z",
           "preview":\(previewJSON)},
          {"id":"doc-2","sourceId":"web","externalId":"e2","title":"Without","contentPreview":"Text",
           "documentType":"page","sourceCreatedAt":"2026-11-14T08:00:00Z"}
        ]}
        """
        let page = try JSONDecoder().decode(RecentItemsPage.self, from: Data(json.utf8))
        guard case .documents(let docs) = page.content else { return XCTFail("expected documents") }
        XCTAssertEqual(docs[0].preview?.width, 1440)
        XCTAssertNil(docs[1].preview)
        XCTAssertEqual(docs[1].contentPreview, "Text")
        XCTAssertEqual(docs[1].documentType, "page")
    }

    func testZeroSizeHasNoAspectRatio() {
        let preview = DocumentPreview(url: "/p", contentType: "image/jpeg", width: 0, height: 900, capturedAt: "x")
        XCTAssertNil(preview.aspectRatio)
    }
}

final class DocumentPreviewLoaderTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [URLRequest] = []
        var delay: UInt64 = 0
        var responder: (URLRequest) throws -> (Int, Data, [String: String])

        init(responder: @escaping (URLRequest) throws -> (Int, Data, [String: String])) {
            self.responder = responder
        }

        var requests: [URLRequest] {
            lock.lock()
            defer { lock.unlock() }
            return recorded
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lock.lock()
            recorded.append(request)
            lock.unlock()
            if delay > 0 { try await Task.sleep(nanoseconds: delay) }
            let (status, body, headers) = try responder(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            return (body, response)
        }
    }

    private let base = URL(string: "https://gateway.example.com:7600")!
    private let imageBytes = Data([0x52, 0x49, 0x46, 0x46, 0x01, 0x02])
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-preview-cache-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func preview(capturedAt: String = "2026-11-14T08:00:00Z", url: String = "/documents/doc-1/preview") -> DocumentPreview {
        DocumentPreview(url: url, contentType: "image/webp", width: 1440, height: 900, capturedAt: capturedAt)
    }

    private func okSession(etag: String = "\"v1\"") -> MockSession {
        MockSession { _ in (200, self.imageBytes, ["Content-Type": "image/webp", "ETag": etag, "Cache-Control": "private"]) }
    }

    func testFetchesWithReadTokenFromTheGateway() async throws {
        let session = okSession()
        let loader = DocumentPreviewLoader(
            baseURL: base,
            token: "read-token",
            session: session,
            cache: DocumentPreviewCache(directory: directory)
        )
        let data = try await loader.imageData(for: preview())
        XCTAssertEqual(data, imageBytes)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://gateway.example.com:7600/documents/doc-1/preview")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer read-token")
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
    }

    func testValidatedCopyIsServedWithoutARequest() async throws {
        let session = okSession()
        let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: session, cache: DocumentPreviewCache(directory: directory))
        _ = try await loader.imageData(for: preview())
        let again = try await loader.imageData(for: preview())
        XCTAssertEqual(again, imageBytes)
        XCTAssertEqual(session.requests.count, 1)
    }

    func testCachedCopyRevalidatesWithETagAndKeepsBytesOn304() async throws {
        let cache = DocumentPreviewCache(directory: directory)
        let first = okSession(etag: "\"v1\"")
        _ = try await DocumentPreviewLoader(baseURL: base, token: "t", session: first, cache: cache).imageData(for: preview())

        let second = MockSession { _ in (304, Data(), ["ETag": "\"v1\""]) }
        let data = try await DocumentPreviewLoader(baseURL: base, token: "t", session: second, cache: cache)
            .imageData(for: preview())
        XCTAssertEqual(data, imageBytes)
        XCTAssertEqual(second.requests.first?.value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
    }

    func testRecaptureRevalidatesAndReplacesTheImage() async throws {
        let replacement = Data([0xFF, 0xD8, 0xFF, 0x01])
        var served = imageBytes
        let session = MockSession { request in
            let etag = served == self.imageBytes ? "\"v1\"" : "\"v2\""
            if request.value(forHTTPHeaderField: "If-None-Match") == etag { return (304, Data(), [:]) }
            return (200, served, ["ETag": etag])
        }
        let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: session, cache: DocumentPreviewCache(directory: directory))
        _ = try await loader.imageData(for: preview(capturedAt: "2026-11-14T08:00:00Z"))
        served = replacement
        let data = try await loader.imageData(for: preview(capturedAt: "2026-11-14T09:00:00Z"))
        XCTAssertEqual(data, replacement)
        XCTAssertEqual(session.requests.count, 2)
        XCTAssertEqual(session.requests[1].value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
    }

    func testNotFoundDropsTheCachedCopy() async throws {
        let cache = DocumentPreviewCache(directory: directory)
        _ = try await DocumentPreviewLoader(baseURL: base, token: "t", session: okSession(), cache: cache).imageData(for: preview())
        let gone = MockSession { _ in (404, Data(), [:]) }
        do {
            _ = try await DocumentPreviewLoader(baseURL: base, token: "t", session: gone, cache: cache).imageData(for: preview())
            XCTFail("expected notFound")
        } catch {
            XCTAssertEqual(error as? GatewayClient.Error, .notFound)
        }
        let key = DocumentPreviewCache.key(gateway: base, path: preview().url)
        let entry = await cache.entry(for: key)
        XCTAssertNil(entry)
    }

    func testAuthFailuresSurfaceAsGatewayErrors() async {
        for (status, expected) in [(401, GatewayClient.Error.unauthorized), (403, .forbidden)] {
            let session = MockSession { _ in (status, Data(), [:]) }
            let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: session, cache: DocumentPreviewCache(directory: nil))
            do {
                _ = try await loader.imageData(for: preview())
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? GatewayClient.Error, expected)
            }
        }
    }

    func testOfflineServesTheCachedCopy() async throws {
        let cache = DocumentPreviewCache(directory: directory)
        _ = try await DocumentPreviewLoader(baseURL: base, token: "t", session: okSession(), cache: cache).imageData(for: preview())
        let offline = MockSession { _ in throw URLError(.notConnectedToInternet) }
        let data = try await DocumentPreviewLoader(baseURL: base, token: "t", session: offline, cache: cache)
            .imageData(for: preview())
        XCTAssertEqual(data, imageBytes)
    }

    func testOfflineWithoutACopyFails() async {
        let offline = MockSession { _ in throw URLError(.notConnectedToInternet) }
        let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: offline, cache: DocumentPreviewCache(directory: nil))
        do {
            _ = try await loader.imageData(for: preview())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
        }
    }

    func testRefusesToSendTheTokenToAnotherOrigin() async {
        let session = okSession()
        let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: session, cache: DocumentPreviewCache(directory: nil))
        for url in [
            "https://elsewhere.example.org/documents/doc-1/preview",
            "http://gateway.example.com:7600/documents/doc-1/preview",
            "https://gateway.example.com:7601/documents/doc-1/preview",
            "//elsewhere.example.org/x",
        ] {
            do {
                _ = try await loader.imageData(for: preview(url: url))
                XCTFail("expected invalidURL for \(url)")
            } catch {
                XCTAssertEqual(error as? GatewayClient.Error, .invalidURL, url)
            }
        }
        XCTAssertTrue(session.requests.isEmpty)
        XCTAssertNotNil(DocumentPreviewLoader.resolve(
            "https://gateway.example.com:7600/documents/doc-1/preview",
            against: base
        ))
        XCTAssertEqual(
            DocumentPreviewLoader.resolve("https://h.example.com/p", against: URL(string: "https://h.example.com:443")!)?.host,
            "h.example.com"
        )
    }

    func testConcurrentRequestsShareOneFetch() async throws {
        let session = okSession()
        session.delay = 50_000_000
        let loader = DocumentPreviewLoader(baseURL: base, token: "t", session: session, cache: DocumentPreviewCache(directory: nil))
        async let first = loader.imageData(for: preview())
        async let second = loader.imageData(for: preview())
        let results = try await [first, second]
        XCTAssertEqual(results, [imageBytes, imageBytes])
        XCTAssertEqual(session.requests.count, 1)
    }

    func testDiskCopySurvivesANewCacheAndRemoveAllClearsIt() async throws {
        let key = DocumentPreviewCache.key(gateway: base, path: "/documents/doc-1/preview")
        let entry = DocumentPreviewCache.Entry(data: imageBytes, etag: "\"v1\"", capturedAt: "c1")
        await DocumentPreviewCache(directory: directory).store(entry, for: key)

        let reopened = DocumentPreviewCache(directory: directory)
        let restored = await reopened.entry(for: key)
        XCTAssertEqual(restored, entry)
        await reopened.removeAll()
        let afterClear = await DocumentPreviewCache(directory: directory).entry(for: key)
        XCTAssertNil(afterClear)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testKeysAreScopedToTheGateway() {
        let one = DocumentPreviewCache.key(gateway: base, path: "/documents/doc-1/preview")
        let other = DocumentPreviewCache.key(gateway: URL(string: "https://other.example.com")!, path: "/documents/doc-1/preview")
        XCTAssertNotEqual(one, other)
    }

    func testMemoryEvictsLeastRecentlyUsed() async {
        let cache = DocumentPreviewCache(directory: nil, memoryLimit: 10)
        let bytes = Data(repeating: 1, count: 4)
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "a")
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "b")
        _ = await cache.entry(for: "a")
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "c")
        let keys = await cache.memoryKeys
        XCTAssertEqual(keys, ["a", "c"])
    }

    func testDiskTrimsLeastRecentlyUsedPastItsLimit() async throws {
        let cache = DocumentPreviewCache(directory: directory, memoryLimit: 0, diskLimit: 10)
        let bytes = Data(repeating: 1, count: 4)
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "old")
        let oldFile = directory.appendingPathComponent("old.img")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3600)], ofItemAtPath: oldFile.path)
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "mid")
        await cache.store(.init(data: bytes, etag: nil, capturedAt: "c"), for: "new")
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("old.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("new.img").path))
    }
}
