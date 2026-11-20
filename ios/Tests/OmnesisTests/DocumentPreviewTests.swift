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

    private func attachmentsJSON(preview: String?) -> Data {
        var child = """
        "id":"child-1","externalId":"parent-1/att/a1","title":"harbor-sunrise.heic","attachmentId":"a1",
        "mimeType":"image/heic","sizeBytes":2048000,"sourceUrl":"messages://open?message-guid=EXAMPLE-0001"
        """
        if let preview { child += ",\"preview\":\(preview)" }
        let bare = """
        {"id":"child-2","externalId":"parent-1/att/a2","title":"menu.pdf","attachmentId":"a2"}
        """
        return Data("{\"attachments\":[{\(child)},\(bare)]}".utf8)
    }

    private struct AttachmentsWrap: Decodable { let attachments: [DocumentAttachment] }

    func testAttachmentDecodesPreview() throws {
        let decoded = try JSONDecoder().decode(AttachmentsWrap.self, from: attachmentsJSON(preview: previewJSON))
        XCTAssertEqual(decoded.attachments.count, 2)
        let child = decoded.attachments[0]
        XCTAssertEqual(child.preview, DocumentPreview(
            url: "/documents/doc-1/preview",
            contentType: "image/webp",
            width: 1440,
            height: 900,
            capturedAt: "2026-11-14T08:00:00Z"
        ))
        XCTAssertEqual(child.sourceUrl, "messages://open?message-guid=EXAMPLE-0001")
        XCTAssertEqual(child.mimeType, "image/heic")
        XCTAssertEqual(child.sizeBytes, 2_048_000)
        XCTAssertNil(decoded.attachments[1].preview)
        XCTAssertNil(decoded.attachments[1].mimeType)
        XCTAssertEqual(decoded.attachments[1].title, "menu.pdf")
    }

    func testAttachmentWithoutPreviewDecodesAsBefore() throws {
        let decoded = try JSONDecoder().decode(AttachmentsWrap.self, from: attachmentsJSON(preview: nil))
        XCTAssertNil(decoded.attachments[0].preview)
        XCTAssertEqual(decoded.attachments[0].title, "harbor-sunrise.heic")
    }

    func testUnreadableAttachmentPreviewDegradesToNil() throws {
        for bad in [
            #"{"url":"/documents/doc-1/preview","contentType":"image/webp","width":"wide","height":900,"capturedAt":"x"}"#,
            #"{"url":"","contentType":"image/jpeg","width":10,"height":10,"capturedAt":"x"}"#,
            #""not an object""#,
            "null",
        ] {
            let decoded = try JSONDecoder().decode(AttachmentsWrap.self, from: attachmentsJSON(preview: bad))
            XCTAssertEqual(decoded.attachments.count, 2, bad)
            XCTAssertNil(decoded.attachments[0].preview, bad)
            XCTAssertEqual(decoded.attachments[0].id, "child-1", bad)
        }
    }

    func testAttachmentStillRequiresItsIdentity() {
        let json = Data(#"{"attachments":[{"externalId":"e","title":"t","attachmentId":"a"}]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(AttachmentsWrap.self, from: json))
    }

    func testZeroSizeHasNoAspectRatio() {
        let preview = DocumentPreview(url: "/p", contentType: "image/jpeg", width: 0, height: 900, capturedAt: "x")
        XCTAssertNil(preview.aspectRatio)
    }
}

final class DocumentPreviewLoaderTests: XCTestCase {
    private struct Reply {
        let status: Int
        var body = Data()
        var headers: [String: String] = [:]
    }

    private final class MockSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [URLRequest] = []
        var delay: UInt64 = 0
        var responder: (URLRequest) throws -> Reply

        init(responder: @escaping (URLRequest) throws -> Reply) {
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
            let reply = try responder(request)
            guard let url = request.url,
                  let response = HTTPURLResponse(
                      url: url,
                      statusCode: reply.status,
                      httpVersion: "HTTP/1.1",
                      headerFields: reply.headers
                  )
            else { throw URLError(.badURL) }
            return (reply.body, response)
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
        MockSession { _ in
            Reply(status: 200, body: self.imageBytes, headers: ["Content-Type": "image/webp", "ETag": etag, "Cache-Control": "private"])
        }
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

        let second = MockSession { _ in Reply(status: 304, headers: ["ETag": "\"v1\""]) }
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
            if request.value(forHTTPHeaderField: "If-None-Match") == etag { return Reply(status: 304) }
            return Reply(status: 200, body: served, headers: ["ETag": etag])
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
        let gone = MockSession { _ in Reply(status: 404) }
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
            let session = MockSession { _ in Reply(status: status) }
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

    func testRefusesToSendTheTokenToAnotherOrigin() async throws {
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
            try DocumentPreviewLoader.resolve("https://h.example.com/p", against: XCTUnwrap(URL(string: "https://h.example.com:443")))?
                .host,
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

    func testDiskCopySurvivesANewCacheAndRemoveAllClearsIt() async {
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

    func testKeysAreScopedToTheGateway() throws {
        let one = DocumentPreviewCache.key(gateway: base, path: "/documents/doc-1/preview")
        let other = try DocumentPreviewCache.key(
            gateway: XCTUnwrap(URL(string: "https://other.example.com")),
            path: "/documents/doc-1/preview"
        )
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
