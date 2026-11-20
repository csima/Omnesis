// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import {
  attachmentStatusLabel,
  buildAttachmentRows,
  shouldRenderGraphPageSection,
  shouldRenderGraphPanel,
} from "./graph-card.js";

describe("graph paging boundaries", () => {
  test("keeps an edge-less graph mounted for pageable, loading, and failed pages", () => {
    expect(shouldRenderGraphPanel(0, { hasMore: true })).toBe(true);
    expect(shouldRenderGraphPanel(0, { loading: true })).toBe(true);
    expect(
      shouldRenderGraphPanel(0, { error: new Error("fictional graph failure") }),
    ).toBe(true);
    expect(shouldRenderGraphPanel(0, {})).toBe(false);
  });

  test("keeps an empty edge section mounted until its own pager settles", () => {
    expect(shouldRenderGraphPageSection([], { hasMore: true })).toBe(true);
    expect(shouldRenderGraphPageSection([], { loadingMore: true })).toBe(true);
    expect(
      shouldRenderGraphPageSection([], {
        loadMoreError: new Error("fictional append failure"),
      }),
    ).toBe(true);
    expect(shouldRenderGraphPageSection([], {})).toBe(false);
    expect(shouldRenderGraphPageSection([{ id: "edge-example" }], {})).toBe(true);
  });
});

describe("attachment status labels", () => {
  test("distinguishes a successful blank extraction from a failure", () => {
    expect(attachmentStatusLabel("no-text")).toBe("No text found");
    expect(attachmentStatusLabel("extraction-failed")).toBe("Extraction failed");
  });
});

describe("attachment rows", () => {
  const infos = [
    { filename: "photo.jpg", mimeType: "image/jpeg", size: 10, extracted: false, attachmentId: "att-a" },
    { filename: "photo.jpg", mimeType: "image/jpeg", size: 20, extracted: false, attachmentId: "att-b" },
  ];
  const childA = { id: "doc-a", title: "photo.jpg", attachmentId: "att-a", preview: { url: "/documents/doc-a/preview" } };
  const childB = { id: "doc-b", title: "photo.jpg", attachmentId: "att-b" };

  test("pairs each marker with its child by attachment id, even when names collide", () => {
    const rows = buildAttachmentRows({ attachmentInfos: infos, attachmentChildren: [childB, childA] });
    expect(rows.map((row: { child: { id: string } | null }) => row.child?.id)).toEqual(["doc-a", "doc-b"]);
  });

  test("falls back to the filename for a marker without an id, never reusing a child", () => {
    const legacy = infos.map(({ attachmentId: _id, ...info }) => info);
    const rows = buildAttachmentRows({ attachmentInfos: legacy, attachmentChildren: [childA] });
    expect(rows.map((row: { child: { id: string } | null }) => row.child?.id ?? null)).toEqual(["doc-a", null]);
  });

  test("no markers, no rows", () => {
    expect(buildAttachmentRows({ attachmentInfos: undefined, attachmentChildren: [childA] })).toEqual([]);
  });
});
