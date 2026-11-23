// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { offscreenCodec, type ScreenshotBrowser } from "../chrome/screenshot.js";
import type { DecodedImage, ScreenshotCodec, ScreenshotType } from "../capture/screenshot.js";

/**
 * Safari's side of a page screenshot: the tabs and windows it reads, and the
 * codec that scales and encodes the shot.
 *
 * `tabs.captureVisibleTab` returns the visible viewport of Safari's front tab
 * as a data URL (PNG unless Safari honours the JPEG request). The shot goes
 * through the same rules as Chrome's (`chrome/screenshot.ts`): the tab must
 * be active, show the exact address the capture came from before and after
 * the shot, and the page must confirm it still holds that capture, is visible
 * and focused, and shows no sensitive field or typed value.
 *
 * TODO(device check): on iPhone the image is reported to be padded or cropped
 * at the top by the collapsible address bar. Nothing here crops it: compare
 * the shot with the page on a physical iPhone, in both address-bar positions
 * and with the bar collapsed and expanded, before deciding on a crop rule.
 */

interface SafariTab {
  id?: number;
  windowId?: number;
  active?: boolean;
  url?: string;
  incognito?: boolean;
}

/** The slice of Safari's `browser` API a screenshot needs. */
export interface SafariScreenshotApi {
  tabs: {
    get(tabId: number): Promise<SafariTab>;
    captureVisibleTab(
      windowId: number,
      options: { format?: "jpeg" | "png"; quality?: number },
    ): Promise<string>;
  };
  windows?: { get?(windowId: number): Promise<{ focused: boolean; state?: string }> };
}

/**
 * Safari's tabs and windows as {@link ScreenshotBrowser} reads them. A tab
 * Safari does not say is outside Private Browsing is treated as a private one,
 * which is never shot. Where Safari offers no window lookup, the window counts
 * as focused and the page's own check that it is visible and focused decides.
 */
export function safariScreenshotBrowser(api: SafariScreenshotApi): ScreenshotBrowser {
  return {
    async getTab(tabId) {
      const tab = await api.tabs.get(tabId);
      if (tab.windowId === undefined) throw new Error("the tab has no window");
      return {
        ...(tab.id !== undefined ? { id: tab.id } : {}),
        ...(tab.url !== undefined ? { url: tab.url } : {}),
        windowId: tab.windowId,
        active: tab.active === true,
        incognito: tab.incognito !== false,
      };
    },
    async getWindow(windowId) {
      const get = api.windows?.get;
      if (typeof get !== "function") return { focused: true };
      return get.call(api.windows, windowId);
    },
    captureVisibleTab: (windowId, options) => api.tabs.captureVisibleTab(windowId, options),
  };
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): {
    imageSmoothingQuality: string;
    drawImage(image: unknown, x: number, y: number, width: number, height: number): void;
  } | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

interface ImageLike {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decode(): Promise<void>;
}

/** What the background page offers for drawing, when it has no `OffscreenCanvas`. */
export interface PageCanvasEnvironment {
  createCanvas(): CanvasLike;
  createImage(): ImageLike;
}

interface PageImage extends DecodedImage {
  element: ImageLike;
}

/** A codec on the background page's own `<canvas>` and `<img>`. */
export function pageCanvasCodec(env: PageCanvasEnvironment): ScreenshotCodec<PageImage> {
  return {
    async decode(dataUrl) {
      const element = env.createImage();
      element.src = dataUrl;
      await element.decode();
      return { element, width: element.naturalWidth, height: element.naturalHeight };
    },
    async encode(image, width, height, type: ScreenshotType, quality) {
      const canvas = env.createCanvas();
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2D context");
      context.imageSmoothingQuality = "high";
      context.drawImage(image.element, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality),
      );
      if (!blob) throw new Error("the canvas encoded nothing");
      return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    },
  };
}

/**
 * The codec Safari's background page can run: `createImageBitmap` and
 * `OffscreenCanvas` where both exist, else the page's own canvas, else none.
 * Safari encodes no WebP from a canvas, so the shared encoder falls back to
 * JPEG there.
 */
export function safariScreenshotCodec(
  scope: {
    OffscreenCanvas?: unknown;
    createImageBitmap?: unknown;
    document?: { createElement(tag: string): unknown };
  } = globalThis as never,
): ScreenshotCodec<DecodedImage> | null {
  if (
    typeof scope.OffscreenCanvas === "function" &&
    typeof scope.createImageBitmap === "function"
  ) {
    return offscreenCodec;
  }
  const document = scope.document;
  if (!document) return null;
  return pageCanvasCodec({
    createCanvas: () => document.createElement("canvas") as CanvasLike,
    createImage: () => document.createElement("img") as ImageLike,
  });
}
