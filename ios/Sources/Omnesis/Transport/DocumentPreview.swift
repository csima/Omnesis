// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A document's preview image, as the gateway describes it on
/// `GET /documents/:id`, on search results and on recent-item rows.
/// Generic across sources: whichever source captured an image for a
/// document (the browser extension's viewport screenshot is the first)
/// shows it the same way, and the app never asks which source it was.
///
/// `url` is a gateway path (`/documents/<id>/preview`) fetched with the
/// app's read token through `DocumentPreviewLoader`. `width` and `height`
/// are the image's pixel size, known before the bytes arrive, so a view
/// can reserve the right shape while it loads. `capturedAt` changes when
/// the preview is recaptured, which is how a cached copy knows to
/// revalidate.
public struct DocumentPreview: Decodable, Hashable, Sendable {
    public let url: String
    public let contentType: String
    public let width: Int
    public let height: Int
    public let capturedAt: String

    public init(url: String, contentType: String, width: Int, height: Int, capturedAt: String) {
        self.url = url
        self.contentType = contentType
        self.width = width
        self.height = height
        self.capturedAt = capturedAt
    }

    /// Width over height, or nil when the gateway sent a size that cannot
    /// make a shape (zero or negative), so callers fall back to a default.
    public var aspectRatio: Double? {
        guard width > 0, height > 0 else { return nil }
        return Double(width) / Double(height)
    }
}

extension KeyedDecodingContainer {
    /// The optional `preview` block, read leniently: absent on older
    /// gateways and on documents without one, and a block this build cannot
    /// read (or one naming no image path) decodes as nil instead of failing
    /// the document or search response that carries it.
    func decodeDocumentPreview(forKey key: Key) -> DocumentPreview? {
        guard let preview = try? decodeIfPresent(DocumentPreview.self, forKey: key),
              !preview.url.isEmpty else { return nil }
        return preview
    }
}
