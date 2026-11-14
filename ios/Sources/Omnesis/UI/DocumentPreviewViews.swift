// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import ImageIO
import SwiftUI
import UIKit

/// The largest pixel edge each surface decodes a preview at. A viewport
/// screenshot can be several thousand pixels wide; decoding it whole for a
/// row thumbnail would cost far more memory than the tile shows.
enum DocumentPreviewPixelSize {
    static let thumbnail = 216
    static let banner = 1400
    static let full = 2800
}

/// Decoded preview images, keyed by preview and pixel size, so a row that
/// scrolls back into view or a reopened document shows its image at once.
/// The encoded bytes live in `DocumentPreviewCache`; this holds only what
/// was drawn recently and lets the system reclaim it under memory pressure.
final class DocumentPreviewImageCache: @unchecked Sendable {
    static let shared = DocumentPreviewImageCache()

    private let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()

    func image(for preview: DocumentPreview, maxPixelSize: Int) -> UIImage? {
        images.object(forKey: Self.key(preview, maxPixelSize))
    }

    func insert(_ image: UIImage, for preview: DocumentPreview, maxPixelSize: Int) {
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        images.setObject(image, forKey: Self.key(preview, maxPixelSize), cost: cost)
    }

    func removeAll() {
        images.removeAllObjects()
    }

    private static func key(_ preview: DocumentPreview, _ maxPixelSize: Int) -> NSString {
        "\(preview.url)|\(preview.capturedAt)|\(maxPixelSize)" as NSString
    }
}

enum DocumentPreviewDecoder {
    /// Decode `data` (WebP, JPEG or any format ImageIO reads) with its
    /// longest edge capped at `maxPixelSize`, without first decoding the
    /// full-size bitmap.
    static func image(from data: Data, maxPixelSize: Int) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image)
    }

    /// The same decode, off the caller's actor.
    static func decode(_ data: Data, maxPixelSize: Int) async -> UIImage? {
        image(from: data, maxPixelSize: maxPixelSize)
    }
}

/// Drop every cached preview image, decoded and encoded. Called when the
/// pairing ends, so a later pairing never shows the previous gateway's
/// images.
@MainActor
func clearDocumentPreviewCaches() {
    DocumentPreviewImageCache.shared.removeAll()
    Task { await DocumentPreviewCache.shared.removeAll() }
}

private struct DocumentPreviewSourceKey: EnvironmentKey {
    static let defaultValue: (any DocumentPreviewImageSource)? = nil
}

extension EnvironmentValues {
    /// Where preview images come from when not from the paired gateway.
    /// Unset in the app, which loads through the read client's
    /// `DocumentPreviewLoader`; previews and snapshot tests set an
    /// in-memory source.
    var documentPreviewSource: (any DocumentPreviewImageSource)? {
        get { self[DocumentPreviewSourceKey.self] }
        set { self[DocumentPreviewSourceKey.self] = newValue }
    }
}

enum DocumentPreviewPhase {
    case loading
    case loaded(UIImage)
    case failed
}

/// Loads one preview image and hands its phase to `content`. A decoded copy
/// already in `DocumentPreviewImageCache` renders on the first frame.
@available(iOS 17.0, *)
struct DocumentPreviewPicture<Content: View>: View {
    @Environment(AppStore.self) private var store
    @Environment(\.documentPreviewSource) private var sourceOverride

    let preview: DocumentPreview
    let maxPixelSize: Int
    @ViewBuilder let content: (DocumentPreviewPhase) -> Content

    @State private var loaded: (preview: DocumentPreview, image: UIImage)?
    @State private var failed = false

    var body: some View {
        content(phase)
            .task(id: preview) { await load() }
    }

    private var phase: DocumentPreviewPhase {
        if let loaded, loaded.preview == preview {
            return .loaded(loaded.image)
        }
        if let image = DocumentPreviewImageCache.shared.image(for: preview, maxPixelSize: maxPixelSize) {
            return .loaded(image)
        }
        return failed ? .failed : .loading
    }

    private func load() async {
        if let cached = DocumentPreviewImageCache.shared.image(for: preview, maxPixelSize: maxPixelSize) {
            loaded = (preview, cached)
            return
        }
        loaded = nil
        failed = false
        let gatewaySource: (any DocumentPreviewImageSource)? = store.search?.previews
        guard let source = sourceOverride ?? gatewaySource else {
            failed = true
            return
        }
        do {
            let data = try await source.imageData(for: preview)
            guard let image = await DocumentPreviewDecoder.decode(data, maxPixelSize: maxPixelSize) else {
                failed = true
                return
            }
            DocumentPreviewImageCache.shared.insert(image, for: preview, maxPixelSize: maxPixelSize)
            loaded = (preview, image)
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// A small fixed-size tile for list rows. It holds its size whether the
/// image is loading, shown or unavailable, so the row never reflows; the
/// image fills the tile from its top edge, where a page's heading is.
@available(iOS 17.0, *)
struct DocumentPreviewThumbnail: View {
    static let size = CGSize(width: 64, height: 44)

    let preview: DocumentPreview

    var body: some View {
        DocumentPreviewPicture(preview: preview, maxPixelSize: DocumentPreviewPixelSize.thumbnail) { phase in
            ZStack {
                Theme.bgTertiary
                switch phase {
                case .loaded(let image):
                    Color.clear.overlay(alignment: .top) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    }
                case .loading:
                    EmptyView()
                case .failed:
                    Image(systemName: "photo")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .frame(width: Self.size.width, height: Self.size.height)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke(Theme.border, lineWidth: 0.5)
            )
        }
        .accessibilityHidden(true)
    }
}

/// The preview at the top of a document: shaped from the gateway's width and
/// height before the image arrives, tap to see it full size. A very tall
/// capture is shown from its top, capped at a square-ish frame, rather than
/// pushing the document below the fold. Hidden when the image cannot load.
@available(iOS 17.0, *)
struct DocumentPreviewBanner: View {
    static let defaultAspectRatio = 16.0 / 10.0
    static let minimumAspectRatio = 0.9

    let preview: DocumentPreview
    @State private var showFullSize = false

    private var frameAspectRatio: CGFloat {
        CGFloat(max(preview.aspectRatio ?? Self.defaultAspectRatio, Self.minimumAspectRatio))
    }

    var body: some View {
        DocumentPreviewPicture(preview: preview, maxPixelSize: DocumentPreviewPixelSize.banner) { phase in
            switch phase {
            case .failed:
                Color.clear.frame(height: 0)
            case .loading, .loaded:
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        showFullSize = true
                    } label: {
                        previewFrame(phase)
                    }
                    .buttonStyle(.plain)
                    .disabled(!phase.isLoaded)
                    .accessibilityLabel("Preview image")
                    .accessibilityHint("Shows the preview full size")
                    if let when = formatTimeAgo(preview.capturedAt) {
                        Text("Preview captured \(when)")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showFullSize) {
            DocumentPreviewFullScreen(preview: preview)
        }
    }

    private func previewFrame(_ phase: DocumentPreviewPhase) -> some View {
        Theme.bgTertiary
            .aspectRatio(frameAspectRatio, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .top) {
                switch phase {
                case .loaded(let image):
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed:
                    EmptyView()
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

extension DocumentPreviewPhase {
    var isLoaded: Bool {
        if case .loaded = self { return true }
        return false
    }
}

/// The whole preview on a dark canvas: pinch to zoom, drag to move a
/// zoomed image, double-tap to reset, Done to close.
@available(iOS 17.0, *)
struct DocumentPreviewFullScreen: View {
    @Environment(\.dismiss) private var dismiss

    let preview: DocumentPreview
    @State private var zoom: CGFloat = 1
    @State private var settledZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            DocumentPreviewPicture(preview: preview, maxPixelSize: DocumentPreviewPixelSize.full) { phase in
                ZStack {
                    Color.black.ignoresSafeArea()
                    switch phase {
                    case .loaded(let image):
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(zoom)
                            .offset(offset)
                            .gesture(magnify.simultaneously(with: pan))
                            .onTapGesture(count: 2) { reset() }
                            .accessibilityLabel("Preview image")
                    case .loading:
                        ProgressView().tint(.white)
                    case .failed:
                        VStack(spacing: 8) {
                            Image(systemName: "photo")
                                .font(.system(size: 28))
                            Text("The preview could not be loaded.")
                                .font(.footnote)
                        }
                        .foregroundStyle(Color.white.opacity(0.7))
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(.white)
                }
            }
        }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                zoom = min(max(settledZoom * value.magnification, 1), 5)
            }
            .onEnded { _ in
                settledZoom = zoom
                if zoom == 1 { reset() }
            }
    }

    private var pan: some Gesture {
        DragGesture()
            .onChanged { value in
                guard zoom > 1 else { return }
                offset = CGSize(
                    width: settledOffset.width + value.translation.width,
                    height: settledOffset.height + value.translation.height
                )
            }
            .onEnded { _ in
                settledOffset = offset
            }
    }

    private func reset() {
        withAnimation(.easeOut(duration: 0.2)) {
            zoom = 1
            settledZoom = 1
            offset = .zero
            settledOffset = .zero
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Preview thumbnail — states") {
    HStack(spacing: 12) {
        DocumentPreviewThumbnail(preview: PreviewMocks.webPagePreview)
        DocumentPreviewThumbnail(preview: PreviewMocks.tallPagePreview)
        DocumentPreviewThumbnail(preview: PreviewMocks.missingPagePreview)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .environment(\.documentPreviewSource, PreviewMocks.documentPreviewSource)
}

@available(iOS 17.0, *)
#Preview("Preview banner — landscape") {
    ScrollView {
        DocumentPreviewBanner(preview: PreviewMocks.webPagePreview)
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .environment(\.documentPreviewSource, PreviewMocks.documentPreviewSource)
}

@available(iOS 17.0, *)
#Preview("Preview banner — tall capture") {
    ScrollView {
        DocumentPreviewBanner(preview: PreviewMocks.tallPagePreview)
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .environment(\.documentPreviewSource, PreviewMocks.documentPreviewSource)
}

@available(iOS 17.0, *)
#Preview("Preview full size") {
    DocumentPreviewFullScreen(preview: PreviewMocks.webPagePreview)
        .environment(AppStore.preview())
        .environment(\.documentPreviewSource, PreviewMocks.documentPreviewSource)
}
#endif
#endif
