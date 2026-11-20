// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { chatPreviewAssets, type DailyChatEntry } from "./fixtures.js";
import { chatPreviewOfferer, renderChatPreview } from "./imessage-previews.js";
import type { DocumentPreviewOffer, SourcePreviewSink } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

// A minimal JPEG header: SOI, a 128 x 96 baseline frame, EOI.
const TINY_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x60, 0x00, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff,
  0xd9,
]);

function universe(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-synth-previews-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "photo.jpg"), TINY_JPEG);
  return dir;
}

const entry: DailyChatEntry = {
  externalId: "chat-day",
  chatId: "chat",
  chatTitle: "Ridge run",
  date: "2026-10-03",
  counterparty: "maya",
  messages: [
    {
      from: "maya",
      guid: "GUID-1",
      at: "2026-10-03T10:01:00Z",
      text: "Photo from the ridge.",
      attachments: [
        {
          filename: "ridge.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 4096,
          previewAssetPath: "assets/photo.jpg",
        },
        { filename: "clip.mov", mimeType: "video/quicktime", sizeBytes: 9000 },
      ],
    },
  ],
};

function doc(externalId: string): DocumentInput {
  return { externalId } as DocumentInput;
}

describe("synthetic iMessage previews", () => {
  test("only an attachment that names a preview image has one", () => {
    const assets = chatPreviewAssets(entry);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.externalId).toMatch(/^chat-day\/att\//);
    expect(assets[0]!.capturedAt).toBe("2026-10-03T10:01:00Z");
  });

  test("renders the fixture JPEG at the size its header gives", () => {
    const rendered = renderChatPreview(chatPreviewAssets(entry)[0]!, universe());
    expect(rendered).toMatchObject({ contentType: "image/jpeg", width: 128, height: 96 });
    expect(rendered!.bytes).toEqual(TINY_JPEG);
  });

  test("offers each preview once, when its document is on a page", async () => {
    const offers: DocumentPreviewOffer[] = [];
    const sink: SourcePreviewSink = {
      offer: vi.fn(async (offer: DocumentPreviewOffer) => {
        offers.push(offer);
        return "stored" as const;
      }),
    };
    const dir = universe();
    const offer = chatPreviewOfferer([entry], sink, () => dir);
    const childId = chatPreviewAssets(entry)[0]!.externalId;
    offer([doc("chat-day")]);
    expect(offers).toHaveLength(0);
    offer([doc("chat-day"), doc(childId)]);
    offer([doc(childId)]);
    expect(offers.map((o) => o.externalId)).toEqual([childId]);
    await expect(offers[0]!.render()).resolves.toMatchObject({ width: 128, height: 96 });
  });

  test("a source lent no sink offers nothing", () => {
    expect(() => chatPreviewOfferer([entry], undefined)([doc("x")])).not.toThrow();
  });
});
