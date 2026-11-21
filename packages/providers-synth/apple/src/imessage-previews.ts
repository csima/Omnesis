// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  jpegDimensions,
  loadActiveUniverse,
  loadBinaryFixtureAssets,
} from "@omnesis/providers-synth-common";
import { chatPreviewAssets, type ChatPreviewAsset, type DailyChatEntry } from "./fixtures.js";
import type { RenderedDocumentPreview, SourcePreviewSink } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

/** Read a fixture's preview JPEG as the real source's thumbnailer would hand it over. */
export function renderChatPreview(
  asset: ChatPreviewAsset,
  universeDir: string,
): RenderedDocumentPreview | null {
  const [loaded] = loadBinaryFixtureAssets(
    [{ assetPath: asset.assetPath, filename: asset.filename, mimeType: "image/jpeg" }],
    universeDir,
  );
  const size = loaded ? jpegDimensions(loaded.content) : null;
  if (!loaded || !size) return null;
  return {
    contentType: "image/jpeg",
    width: size.width,
    height: size.height,
    capturedAt: asset.capturedAt,
    bytes: new Uint8Array(loaded.content),
  };
}

/**
 * The synthetic iMessage source's thumbnails: after each page, offer the
 * preview of every attachment on it whose fixture declares one, as the real
 * source offers the thumbnails it makes. Each is offered once per source
 * instance; the offer is made, not awaited, as the sink requires.
 */
export function chatPreviewOfferer(
  entries: DailyChatEntry[],
  sink: SourcePreviewSink | undefined,
  universeDir: () => string = () => loadActiveUniverse().dir,
): (documents: readonly DocumentInput[]) => void {
  if (!sink) return () => {};
  const assets = new Map(entries.flatMap(chatPreviewAssets).map((a) => [a.externalId, a]));
  const offered = new Set<string>();
  return (documents) => {
    for (const document of documents) {
      const asset = assets.get(document.externalId);
      if (!asset || offered.has(asset.externalId)) continue;
      offered.add(asset.externalId);
      void sink
        .offer({
          externalId: asset.externalId,
          render: async () => renderChatPreview(asset, universeDir()),
        })
        .catch(() => {});
    }
  };
}
