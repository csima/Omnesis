// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { withResultPreviews } from "./search.js";

const ref = {
  url: "/documents/doc-a/preview",
  contentType: "image/webp" as const,
  width: 1280,
  height: 720,
  capturedAt: "2026-03-01T09:00:00.000Z",
};

describe("search results' previews", () => {
  test("a result whose document has a preview carries it; the others are unchanged", () => {
    const response = {
      results: [
        { documentId: "doc-a", title: "Invented page A" },
        { documentId: "doc-b", title: "Invented page B" },
      ],
      timing: { totalMs: 3 },
    };
    let asked: readonly string[] = [];
    const out = withResultPreviews(response, {
      refsFor: (ids) => {
        asked = ids;
        return new Map([["doc-a", ref]]);
      },
    });
    expect(asked).toEqual(["doc-a", "doc-b"]);
    expect(out.results[0]).toEqual({ documentId: "doc-a", title: "Invented page A", preview: ref });
    expect(out.results[1]).not.toHaveProperty("preview");
    expect(out.timing).toEqual({ totalMs: 3 });
  });

  test("without a preview store or results the response is returned as it was", () => {
    const response = { results: [{ documentId: "doc-a" }] };
    expect(withResultPreviews(response, undefined)).toBe(response);
    const empty = { results: [] };
    expect(withResultPreviews(empty, { refsFor: () => new Map() })).toBe(empty);
  });
});
