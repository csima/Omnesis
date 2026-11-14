// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// Anything that can hand a view the encoded bytes of a document preview.
/// `DocumentPreviewLoader` is the gateway-backed one; previews and snapshot
/// tests substitute an in-memory one.
public protocol DocumentPreviewImageSource: Sendable {
    func imageData(for preview: DocumentPreview) async throws -> Data
}

/// Fetches document preview images (`GET /documents/:id/preview`) with the
/// app's read token over the same trust-checked session as every other
/// transport client, and keeps them in `DocumentPreviewCache`.
///
/// Freshness: a cached copy is served without a request once it has been
/// validated in this loader's lifetime for the same `capturedAt`. Otherwise
/// the loader asks again, sending the cached ETag as `If-None-Match`, so an
/// unchanged image costs a 304 rather than its bytes. A recaptured preview
/// carries a new `capturedAt`, which forces that revalidation. A 404 drops
/// the cached copy. When the gateway cannot be reached, or answers with a
/// server error, a cached copy is still shown.
///
/// The preview's `url` must resolve to the paired gateway's own origin:
/// the bearer token is never sent anywhere else.
public actor DocumentPreviewLoader: DocumentPreviewImageSource {
    private let baseURL: URL
    private let token: String
    private let session: URLSessionLike
    private let cache: DocumentPreviewCache
    private var validated: [String: String] = [:]
    private var inFlight: [String: Task<Data, Error>] = [:]

    public init(
        baseURL: URL,
        token: String,
        session: URLSessionLike = OmnesisURLSession.shared,
        cache: DocumentPreviewCache = .shared
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.cache = cache
    }

    public func imageData(for preview: DocumentPreview) async throws -> Data {
        guard let url = Self.resolve(preview.url, against: baseURL) else {
            throw GatewayClient.Error.invalidURL
        }
        let key = DocumentPreviewCache.key(gateway: baseURL, path: preview.url)
        if validated[key] == preview.capturedAt, let entry = await cache.entry(for: key) {
            return entry.data
        }
        if let running = inFlight[key] {
            return try await running.value
        }
        let task = Task { try await self.fetch(url: url, key: key, capturedAt: preview.capturedAt) }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        return try await task.value
    }

    private func fetch(url: URL, key: String, capturedAt: String) async throws -> Data {
        let cached = await cache.entry(for: key)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("image/webp, image/jpeg;q=0.9, image/*;q=0.8", forHTTPHeaderField: "Accept")
        if let etag = cached?.etag {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
            if let cached { return cached.data }
            throw error
        }
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299:
            guard !data.isEmpty else { throw GatewayClient.Error.invalidResponse }
            let entry = DocumentPreviewCache.Entry(
                data: data,
                etag: http.value(forHTTPHeaderField: "ETag"),
                capturedAt: capturedAt
            )
            await cache.store(entry, for: key)
            validated[key] = capturedAt
            return data
        case 304:
            guard let cached else { throw GatewayClient.Error.invalidResponse }
            await cache.store(
                DocumentPreviewCache.Entry(data: cached.data, etag: cached.etag, capturedAt: capturedAt),
                for: key
            )
            validated[key] = capturedAt
            return cached.data
        case 401:
            throw GatewayClient.Error.unauthorized
        case 403:
            throw GatewayClient.Error.forbidden
        case 404:
            validated[key] = nil
            await cache.remove(key)
            throw GatewayClient.Error.notFound
        default:
            if let cached, http.statusCode >= 500 { return cached.data }
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    /// `path` resolved against the gateway, or nil when it names any other
    /// origin (scheme, host or port), so the token cannot leave the gateway.
    static func resolve(_ path: String, against base: URL) -> URL? {
        guard !path.isEmpty,
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              let scheme = url.scheme?.lowercased(),
              scheme == base.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              host == base.host?.lowercased(),
              effectivePort(url) == effectivePort(base)
        else { return nil }
        return url
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }
}

/// Memory and disk cache for document preview bytes, keyed by gateway and
/// preview path. Memory holds recently shown images up to `memoryLimit`
/// bytes, least recently used first out. Disk keeps up to `diskLimit` bytes
/// under `Caches/Omnesis/document-previews/`, which the system may also
/// purge, and drops the least recently used files first. Preview images are
/// corpus-derived, so the directory carries `ProtectedStore.documentPreviews`'
/// protection class and is excluded from backup; if the exclusion cannot be
/// confirmed, nothing is written to disk.
public actor DocumentPreviewCache {
    public struct Entry: Sendable, Equatable {
        public let data: Data
        public let etag: String?
        public let capturedAt: String
    }

    private struct Meta: Codable {
        let etag: String?
        let capturedAt: String
    }

    public static let shared = DocumentPreviewCache(directory: defaultDirectory())

    private let directory: URL?
    private let memoryLimit: Int
    private let diskLimit: Int
    private let fileManager: FileManager
    private var memory: [String: Entry] = [:]
    private var recency: [String] = []
    private var memoryBytes = 0

    public init(
        directory: URL?,
        memoryLimit: Int = 24 * 1024 * 1024,
        diskLimit: Int = 96 * 1024 * 1024,
        fileManager: FileManager = .default
    ) {
        self.directory = directory
        self.memoryLimit = memoryLimit
        self.diskLimit = diskLimit
        self.fileManager = fileManager
        if let directory {
            ProtectedStore.documentPreviews.applyProtection(toContentsOf: directory, fileManager: fileManager)
            ProtectedStore.documentPreviews.applyBackupExclusion(to: directory, fileManager: fileManager)
        }
    }

    static func defaultDirectory() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Omnesis", isDirectory: true)
            .appendingPathComponent("document-previews", isDirectory: true)
    }

    static func key(gateway: URL, path: String) -> String {
        let digest = SHA256.hash(data: Data("\(gateway.absoluteString)|\(path)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    public func entry(for key: String) -> Entry? {
        if let hit = memory[key] {
            touchMemory(key)
            return hit
        }
        guard let entry = readDisk(key) else { return nil }
        insertMemory(entry, for: key)
        return entry
    }

    public func store(_ entry: Entry, for key: String) {
        insertMemory(entry, for: key)
        writeDisk(entry, for: key)
    }

    public func remove(_ key: String) {
        if let old = memory.removeValue(forKey: key) {
            memoryBytes -= old.data.count
            recency.removeAll { $0 == key }
        }
        guard let directory else { return }
        try? fileManager.removeItem(at: dataURL(key, in: directory))
        try? fileManager.removeItem(at: metaURL(key, in: directory))
    }

    /// Forget every cached preview, in memory and on disk. Called on unpair,
    /// so another pairing never sees the previous gateway's images.
    public func removeAll() {
        memory = [:]
        recency = []
        memoryBytes = 0
        guard let directory else { return }
        try? fileManager.removeItem(at: directory)
    }

    var memoryKeys: [String] {
        recency
    }

    private func touchMemory(_ key: String) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private func insertMemory(_ entry: Entry, for key: String) {
        if let old = memory[key] { memoryBytes -= old.data.count }
        memory[key] = entry
        memoryBytes += entry.data.count
        touchMemory(key)
        while memoryBytes > memoryLimit, recency.count > 1, let oldest = recency.first {
            recency.removeFirst()
            if let dropped = memory.removeValue(forKey: oldest) {
                memoryBytes -= dropped.data.count
            }
        }
    }

    private func dataURL(_ key: String, in directory: URL) -> URL {
        directory.appendingPathComponent("\(key).img")
    }

    private func metaURL(_ key: String, in directory: URL) -> URL {
        directory.appendingPathComponent("\(key).json")
    }

    private func readDisk(_ key: String) -> Entry? {
        guard let directory,
              let data = try? Data(contentsOf: dataURL(key, in: directory)),
              let metaData = try? Data(contentsOf: metaURL(key, in: directory)),
              let meta = try? JSONDecoder().decode(Meta.self, from: metaData)
        else { return nil }
        try? fileManager.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: dataURL(key, in: directory).path
        )
        return Entry(data: data, etag: meta.etag, capturedAt: meta.capturedAt)
    }

    private func writeDisk(_ entry: Entry, for key: String) {
        guard let directory, entry.data.count <= diskLimit else { return }
        let store = ProtectedStore.documentPreviews
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            store.applyProtection(toContentsOf: directory, fileManager: fileManager)
            try store.requireBackupExclusion(to: directory, fileManager: fileManager)
            let meta = try JSONEncoder().encode(Meta(etag: entry.etag, capturedAt: entry.capturedAt))
            try entry.data.write(to: dataURL(key, in: directory), options: store.writingOptions)
            try meta.write(to: metaURL(key, in: directory), options: store.writingOptions)
        } catch {
            return
        }
        trimDisk(in: directory)
    }

    private struct CachedFile {
        let url: URL
        let size: Int
        let lastUsed: Date
    }

    private func trimDisk(in directory: URL) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: keys
        ) else { return }
        let files = urls.filter { $0.pathExtension == "img" }.compactMap { url -> CachedFile? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return CachedFile(
                url: url,
                size: values.fileSize ?? 0,
                lastUsed: values.contentModificationDate ?? .distantPast
            )
        }
        var total = files.reduce(0) { $0 + $1.size }
        for file in files.sorted(by: { $0.lastUsed < $1.lastUsed }) {
            guard total > diskLimit else { break }
            try? fileManager.removeItem(at: file.url)
            try? fileManager.removeItem(at: file.url.deletingPathExtension().appendingPathExtension("json"))
            total -= file.size
        }
    }
}
