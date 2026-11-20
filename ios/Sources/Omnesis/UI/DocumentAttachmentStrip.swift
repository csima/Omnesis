// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A document's attachments as a horizontal row of thumbnails, under its
/// quick facts. Each tile shows the child's preview image when its source
/// captured one, and a placeholder drawn for the file's type otherwise,
/// with the filename and a short type and size line beneath.
///
/// Tapping a tile opens the original through the child's own links (the
/// native-app link first, then the source link), falling back to the
/// child document in the app when it has none. The context menu always
/// offers the child document. Nothing here knows which source the
/// attachments came from.
@available(iOS 17.0, *)
struct DocumentAttachmentStrip: View {
    let attachments: [DocumentAttachment]

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var pushedAttachment: DocumentAttachment?

    var body: some View {
        FlatSection("Attachments") {
            ScrollView(.horizontal, showsIndicators: false) {
                // The gap grows with the tiles, so at large text sizes the
                // neighbouring captions keep a clear gutter between them.
                HStack(alignment: .top, spacing: Theme.Spacing.md * DocumentAttachmentTile.scale(at: dynamicTypeSize)) {
                    ForEach(attachments) { attachment in
                        DocumentAttachmentTile(
                            attachment: attachment,
                            onOpenDocument: { pushedAttachment = attachment }
                        )
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollClipDisabled()
        }
        .navigationDestination(item: $pushedAttachment) { attachment in
            DocumentDetailView(documentId: attachment.id, presetTitle: attachment.displayName)
        }
    }
}

/// One attachment: thumbnail over its caption.
@available(iOS 17.0, *)
struct DocumentAttachmentTile: View {
    /// The thumbnail's size at the default text size: narrow enough that a
    /// phone shows three tiles and the edge of a fourth, so the row reads as
    /// scrollable. The tile widens with the reader's text size, up to
    /// `maximumScale`, and at accessibility sizes the filename gets a second
    /// line, so a larger caption keeps a useful part of the name.
    static let baseSize = CGSize(width: 104, height: 78)
    static let maximumScale: CGFloat = 1.6

    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let attachment: DocumentAttachment
    let onOpenDocument: () -> Void

    private var kind: FileTypeKind {
        FileTypeIcons.kind(mimeType: attachment.mimeType, filename: attachment.displayName) ?? .file
    }

    private var openURLs: [URL] {
        docOpenURLs(appUrl: attachment.appUrl, sourceUrl: attachment.sourceUrl)
    }

    /// How much larger than `baseSize` a tile draws at `dynamicTypeSize`:
    /// the body text's growth, never below 1 or above `maximumScale`.
    static func scale(at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        min(
            max(ScaledType.bodySize(at: dynamicTypeSize) / ScaledType.defaultBodySize, 1),
            maximumScale
        )
    }

    private var scale: CGFloat {
        Self.scale(at: dynamicTypeSize)
    }

    private var tileSize: CGSize {
        CGSize(width: Self.baseSize.width * scale, height: Self.baseSize.height * scale)
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                thumbnail
                caption
            }
            .frame(width: tileSize.width, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpenDocument) {
                Label("Open document", systemImage: "doc.text")
            }
            if !openURLs.isEmpty {
                Button {
                    openURL.openFirst(openURLs[...])
                } label: {
                    Label("Open in source", systemImage: "arrow.up.right.square")
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(openURLs.isEmpty ? "Opens the document" : "Opens the original")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open document", onOpenDocument)
    }

    private func open() {
        if openURLs.isEmpty {
            onOpenDocument()
        } else {
            openURL.openFirst(openURLs[...])
        }
    }

    // MARK: Thumbnail

    private var thumbnail: some View {
        AttachmentThumbnail(
            attachment: attachment,
            size: tileSize,
            scale: scale,
            cornerRadius: Theme.Radius.large
        )
    }

    // MARK: Caption

    private var caption: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(attachment.displayName)
                .scaledFont(size: 12, weight: .medium)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .truncationMode(.middle)
            Text(detailLine)
                .scaledFont(size: 11)
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
        }
    }

    /// "Video · 4.2 MB", "PDF · 3 pages": the type's name, then the size
    /// or page count when the gateway sent one.
    private var detailLine: String {
        var parts = [kind.label]
        if let pages = attachment.pages, pages > 0 {
            parts.append(pages == 1 ? "1 page" : "\(pages) pages")
        } else if let size = attachment.sizeBytes, size > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }

    private var accessibilityLabel: String {
        var parts = [attachment.displayName, kind.label]
        if attachment.preview == nil { parts.append("no preview") }
        return parts.joined(separator: ", ")
    }
}

/// An attachment's picture: its preview image when the source captured one,
/// and the file type's glyph and short label otherwise, or when the image
/// cannot load. A video's preview carries a play badge. Shared by the
/// document page's strip and the inspector's graph rows, so both surfaces
/// show a child the same way. `scale` grows the glyph, label and badge
/// with the reader's text size.
@available(iOS 17.0, *)
struct AttachmentThumbnail: View {
    /// The placeholder and badge sizes for a tile of `referenceSize` at
    /// scale 1; a smaller tile draws them proportionally smaller.
    static let referenceSize = DocumentAttachmentTile.baseSize

    let attachment: DocumentAttachment
    let size: CGSize
    var scale: CGFloat = 1
    var cornerRadius: CGFloat = Theme.Radius.large

    private var kind: FileTypeKind {
        FileTypeIcons.kind(mimeType: attachment.mimeType, filename: attachment.displayName) ?? .file
    }

    /// The tile's size relative to the strip's tile at the same text size.
    private var proportion: CGFloat {
        min(size.width / (Self.referenceSize.width * scale), 1)
    }

    /// Glyph and label sizes: the strip's sizes, grown with the text and
    /// shrunk with a smaller tile. A compact tile drops the label when it
    /// would be too small to read.
    private var glyphSize: CGFloat {
        24 * scale * proportion
    }

    private var labelSize: CGFloat {
        9 * scale * proportion
    }

    private var showsLabel: Bool {
        labelSize >= 7
    }

    private var badgeSize: CGFloat {
        max(28 * scale * proportion, 18)
    }

    var body: some View {
        ZStack {
            Theme.bgTertiary
            if let preview = attachment.preview {
                DocumentPreviewPicture(preview: preview, maxPixelSize: DocumentPreviewPixelSize.thumbnail) { phase in
                    switch phase {
                    case .loaded(let image):
                        Color.clear.overlay(alignment: kind == .image || kind == .video ? .center : .top) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        }
                    case .loading:
                        Color.clear
                    case .failed:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
            if kind == .video, attachment.preview != nil {
                Image(systemName: "play.fill")
                    .font(.system(size: badgeSize * 0.43, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: badgeSize, height: badgeSize)
                    .background(.black.opacity(0.45), in: Circle())
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .stroke(Theme.border, lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }

    /// The file type's glyph and short label, in its colour.
    private var placeholder: some View {
        VStack(spacing: 4 * scale * proportion) {
            Image(systemName: kind.systemImage)
                .font(.system(size: glyphSize))
                .foregroundStyle(kind.color)
            if showsLabel {
                Text(FileTypeIcons.label(mimeType: attachment.mimeType, filename: attachment.displayName))
                    .font(.system(size: labelSize, weight: .semibold))
                    .tracking(0.4 * scale)
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension AttachmentThumbnail {
    /// The inspector graph tab's compact thumbnail, the size of a search
    /// row's preview.
    init(graphRow attachment: DocumentAttachment) {
        self.init(
            attachment: attachment,
            size: DocumentPreviewThumbnail.size,
            cornerRadius: Theme.Radius.medium
        )
    }
}

extension DocumentAttachment {
    /// The filename to show: the title, or the attachment id when the
    /// source sent no title.
    var displayName: String {
        title.isEmpty ? attachmentId : title
    }
}

extension OpenURLAction {
    /// Open the first of `urls` the system accepts. The action reports
    /// `false` when no installed app handles a scheme, so an app link for an
    /// app this phone lacks falls through to the next link.
    func openFirst(_ urls: ArraySlice<URL>) {
        guard let url = urls.first else { return }
        self(url) { accepted in
            if !accepted { openFirst(urls.dropFirst()) }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private struct AttachmentStripPreviewPage: View {
    let attachments: [DocumentAttachment]

    var body: some View {
        NavigationStack {
            ScrollView {
                DocumentAttachmentStrip(attachments: attachments)
                    .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
        }
        .environment(AppStore.preview())
        .environment(\.documentPreviewSource, PreviewMocks.documentPreviewSource)
    }
}

@available(iOS 17.0, *)
#Preview("Attachment strip — previews") {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsWithPreviews)
}

@available(iOS 17.0, *)
#Preview("Attachment strip — mixed") {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsMixed)
}

@available(iOS 17.0, *)
#Preview("Attachment strip — no previews") {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsWithoutPreviews)
}

@available(iOS 17.0, *)
#Preview("Attachment strip — long filename") {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsLongFilename)
}

@available(iOS 17.0, *)
#Preview("Attachment strip — large text") {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsMixed)
        .dynamicTypeSize(.accessibility3)
}

@available(iOS 17.0, *)
#Preview("Attachment strip — Duo inner display", traits: .fixedLayout(width: 951, height: 669)) {
    AttachmentStripPreviewPage(attachments: PreviewMocks.attachmentsMixed)
}
#endif
#endif
