// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — renders the plain-JS attachment strip in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/router.js", () => ({ navigate: vi.fn() }));

import { AttachmentStrip, attachmentTileTarget, orderAttachments } from "./attachment-strip.js";
import { navigate } from "../lib/router.js";

const PHOTO = {
  id: "c0ffee00-0000-4000-8000-000000000001",
  title: "trail-sunrise.jpg",
  attachmentId: "att-photo",
  mimeType: "image/jpeg",
  sourceUrl: "example-app://open?item=photo-1",
  preview: {
    url: "/documents/c0ffee00-0000-4000-8000-000000000001/preview",
    contentType: "image/jpeg",
    width: 512,
    height: 384,
    capturedAt: "2026-03-01T08:00:00.000Z",
  },
};
const PDF = {
  id: "c0ffee00-0000-4000-8000-000000000002",
  title: "race-entry-form.pdf",
  attachmentId: "att-pdf",
  mimeType: "application/pdf",
  sourceUrl: "https://files.example.com/race-entry-form.pdf",
};
const NO_LINK = {
  id: "c0ffee00-0000-4000-8000-000000000003",
  title: "notes.txt",
  attachmentId: "att-text",
  mimeType: "text/plain",
  sourceUrl: null,
};

// linkedom has no MouseEvent; a plain event carrying the primary button stands in.
function leftClick() {
  const event = new window.Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: 0 });
  return event;
}

let host;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main");
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("attachmentTileTarget", () => {
  test("opens a web original in a new tab and an app link in place", () => {
    expect(attachmentTileTarget(PDF)).toEqual({ href: PDF.sourceUrl, original: true, newTab: true });
    expect(attachmentTileTarget(PHOTO)).toEqual({
      href: PHOTO.sourceUrl,
      original: true,
      newTab: false,
    });
  });

  test("falls back to the document page without an openable original", () => {
    const page = `/portal/doc/${NO_LINK.id}`;
    expect(attachmentTileTarget(NO_LINK)).toEqual({ href: page, original: false, newTab: false });
    expect(attachmentTileTarget({ ...NO_LINK, sourceUrl: "javascript:alert(1)" }).href).toBe(page);
  });
});

describe("AttachmentStrip", () => {
  test("renders nothing for a document without attachment children", () => {
    act(() => render(h(AttachmentStrip, { attachments: [] }), host));
    expect(host.innerHTML).toBe("");
    act(() => render(h(AttachmentStrip, { attachments: undefined }), host));
    expect(host.innerHTML).toBe("");
  });

  test("a child with a preview shows its thumbnail, named by its filename", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PHOTO] }), host));
    const img = host.querySelector(".att-tile img.att-tile-image");
    expect(img.getAttribute("src")).toBe(PHOTO.preview.url);
    expect(img.getAttribute("alt")).toBe("trail-sunrise.jpg");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(host.querySelector(".att-tile-name").textContent).toBe("trail-sunrise.jpg");
    expect(host.querySelector(".att-strip").getAttribute("aria-label")).toBe("Attachments");
  });

  test("the tile opens the original and a secondary link opens the document page", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PHOTO] }), host));
    const open = host.querySelector("a.att-tile-open");
    expect(open.getAttribute("href")).toBe(PHOTO.sourceUrl);
    expect(open.getAttribute("target")).toBeNull();
    expect(open.getAttribute("aria-label")).toBe("Open the original of trail-sunrise.jpg");
    const page = host.querySelector("a.att-tile-page");
    expect(page.getAttribute("href")).toBe(`/portal/doc/${PHOTO.id}`);
    expect(page.getAttribute("aria-label")).toBe("Document page for trail-sunrise.jpg");
    page.dispatchEvent(leftClick());
    expect(navigate).toHaveBeenCalledWith(`/portal/doc/${PHOTO.id}`);
  });

  test("a web original opens in a new tab", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PDF] }), host));
    const open = host.querySelector("a.att-tile-open");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener");
  });

  test("a child without a preview gets a typed placeholder instead of an image", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PDF] }), host));
    expect(host.querySelector(".att-tile img")).toBeNull();
    const icon = host.querySelector(".att-tile-placeholder svg.file-type-icon");
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("aria-label")).toBe("PDF");
  });

  test("a preview pointing anywhere but the gateway is not loaded", () => {
    const foreign = { ...PHOTO, preview: { ...PHOTO.preview, url: "https://elsewhere.example.com/x.jpg" } };
    act(() => render(h(AttachmentStrip, { attachments: [foreign] }), host));
    expect(host.querySelector(".att-tile img")).toBeNull();
    expect(host.querySelector(".att-tile-placeholder")).not.toBeNull();
  });

  test("an image that fails to load falls back to the placeholder", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PHOTO] }), host));
    const img = host.querySelector(".att-tile img");
    act(() => {
      img.dispatchEvent(new window.Event("error"));
    });
    expect(host.querySelector(".att-tile img")).toBeNull();
    expect(host.querySelector(".att-tile-placeholder")).not.toBeNull();
  });

  test("a child with no original opens its page from the tile, with no second link", () => {
    act(() => render(h(AttachmentStrip, { attachments: [NO_LINK] }), host));
    const open = host.querySelector("a.att-tile-open");
    expect(open.getAttribute("href")).toBe(`/portal/doc/${NO_LINK.id}`);
    expect(host.querySelector("a.att-tile-page")).toBeNull();
    open.dispatchEvent(leftClick());
    expect(navigate).toHaveBeenCalledWith(`/portal/doc/${NO_LINK.id}`);
  });

  test("every tile is reachable by keyboard as a link", () => {
    act(() => render(h(AttachmentStrip, { attachments: [PHOTO, PDF, NO_LINK] }), host));
    const tiles = host.querySelectorAll(".att-tile");
    expect(tiles.length).toBe(3);
    for (const tile of tiles) {
      expect(tile.querySelector("a.att-tile-open").getAttribute("href")).toBeTruthy();
    }
  });
});

describe("orderAttachments", () => {
  test("follows the parent's markers, keeping unnamed children after them", () => {
    const a = { id: "a", attachmentId: "att-a" };
    const b = { id: "b", attachmentId: "att-b" };
    const c = { id: "c", attachmentId: "att-c" };
    const infos = [{ attachmentId: "att-b" }, { attachmentId: "att-a" }];
    expect(orderAttachments([a, c, b], infos).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(orderAttachments([a, c, b], undefined).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  test("the strip renders its tiles in that order", () => {
    act(() =>
      render(
        h(AttachmentStrip, {
          attachments: [PDF, PHOTO],
          attachmentInfos: [{ attachmentId: "att-photo" }, { attachmentId: "att-pdf" }],
        }),
        host,
      ),
    );
    const names = [...host.querySelectorAll(".att-tile-name")].map((n) => n.textContent);
    expect(names).toEqual(["trail-sunrise.jpg", "race-entry-form.pdf"]);
  });
});
