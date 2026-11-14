// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api.js", () => ({
  getWebCapturePolicy: vi.fn(),
  setWebCaptureScreenshots: vi.fn(),
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { DocumentPreview, previewSrc } from "./document-preview.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { BrowserCaptureSettings, hasPairedBrowser } from "./browser-capture-settings.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { getWebCapturePolicy, setWebCaptureScreenshots } from "../api.js";

const PREVIEW = {
  url: "/documents/1b2c3d4e-0000-4000-8000-000000000001/preview",
  contentType: "image/webp",
  width: 1280,
  height: 800,
  capturedAt: "2026-02-01T08:00:00.000Z",
};

describe("previewSrc", () => {
  test("uses only a same-origin document preview path", () => {
    expect(previewSrc(PREVIEW)).toBe(PREVIEW.url);
    expect(previewSrc(undefined)).toBeNull();
    expect(previewSrc({ url: "https://elsewhere.example.com/x.png" })).toBeNull();
    expect(previewSrc({ url: "//elsewhere.example.com/documents/a/preview" })).toBeNull();
    expect(previewSrc({ url: "/documents/a/preview?x=1" })).toBeNull();
    expect(previewSrc({ url: "javascript:alert(1)" })).toBeNull();
  });
});

describe("hasPairedBrowser", () => {
  test("is true only for an unrevoked browser device", () => {
    expect(hasPairedBrowser([{ kind: "browser" }])).toBe(true);
    expect(hasPairedBrowser([{ kind: "browser", revokedAt: 5 }])).toBe(false);
    expect(hasPairedBrowser([{ kind: "ios" }])).toBe(false);
    expect(hasPairedBrowser(undefined)).toBe(false);
  });
});

describe("rendered", () => {
  let host: HTMLElement;
  let originalDocument: Document | undefined;
  let originalWindow: (Window & typeof globalThis) | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    vi.clearAllMocks();
  });

  test("a document preview renders its image with its size and a caption", () => {
    act(() => render(h(DocumentPreview, { preview: PREVIEW, title: "Invented page" }), host));
    const img = host.querySelector("img.doc-preview-image");
    expect(img?.getAttribute("src")).toBe(PREVIEW.url);
    expect(img?.getAttribute("width")).toBe("1280");
    expect(img?.getAttribute("alt")).toBe("Preview of Invented page");
    expect(host.querySelector(".doc-preview-caption")?.textContent).toMatch(/^Preview captured /);
  });

  test("no preview renders nothing", () => {
    act(() => render(h(DocumentPreview, { preview: undefined, title: "x" }), host));
    expect(host.innerHTML).toBe("");
  });

  test("the browser capture card shows the shared switch and flips it", async () => {
    (getWebCapturePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
      screenshots: { enabled: false },
    });
    (setWebCaptureScreenshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      screenshots: { enabled: true },
    });
    await act(async () => {
      render(h(BrowserCaptureSettings, {}), host);
    });
    await vi.waitFor(() =>
      expect(Boolean((host.querySelector("input[type=checkbox]") as HTMLInputElement).disabled)).toBe(
        false,
      ),
    );
    const box = host.querySelector("input[type=checkbox]") as HTMLInputElement;
    // linkedom reports an unset boolean property as undefined; a browser says false.
    expect(Boolean(box.checked)).toBe(false);
    expect(Boolean(box.disabled)).toBe(false);
    expect(host.textContent).toContain("Screenshots are not redacted");
    box.checked = true;
    await act(async () => {
      box.dispatchEvent(new (globalThis.window as unknown as typeof globalThis).Event("change"));
    });
    expect(setWebCaptureScreenshots).toHaveBeenCalledWith(true);
    expect(Boolean((host.querySelector("input[type=checkbox]") as HTMLInputElement).checked)).toBe(
      true,
    );
  });

  test("a refused edit is shown", async () => {
    (getWebCapturePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
      screenshots: { enabled: false },
    });
    (setWebCaptureScreenshots as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Pair a browser before changing its capture settings"),
    );
    await act(async () => {
      render(h(BrowserCaptureSettings, {}), host);
    });
    await vi.waitFor(() =>
      expect(Boolean((host.querySelector("input[type=checkbox]") as HTMLInputElement).disabled)).toBe(
        false,
      ),
    );
    const box = host.querySelector("input[type=checkbox]") as HTMLInputElement;
    box.checked = true;
    await act(async () => {
      box.dispatchEvent(new (globalThis.window as unknown as typeof globalThis).Event("change"));
    });
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      "Pair a browser before changing its capture settings",
    );
  });
});
