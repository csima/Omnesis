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

    @State private var pushedAttachment: DocumentAttachment?

    var body: some View {
        FlatSection("Attachments") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: Theme.Spacing.md) {
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

    private var tileSize: CGSize {
        let scale = min(
            max(ScaledType.bodySize(at: dynamicTypeSize) / ScaledType.defaultBodySize, 1),
            Self.maximumScale
        )
        return CGSize(width: Self.baseSize.width * scale, height: Self.baseSize.height * scale)
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
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.black.opacity(0.45), in: Circle())
            }
        }
        .frame(width: tileSize.width, height: tileSize.height)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 0.5)
        )
    }

    /// The file type's glyph and short label, in its colour, for a child
    /// with no preview image or one that could not load.
    private var placeholder: some View {
        VStack(spacing: 4) {
            Image(systemName: kind.systemImage)
                .font(.system(size: 24))
                .foregroundStyle(kind.color)
            Text(FileTypeIcons.label(mimeType: attachment.mimeType, filename: attachment.displayName))
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
