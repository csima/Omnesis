// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  bytesToBase64,
  encodeScreenshot,
  type DecodedImage,
  type ScreenshotCodec,
  type ScreenshotType,
} from "../capture/screenshot.js";

/**
 * Taking a page's screenshot from the service worker, at the moment its text
 * capture is emitted.
 *
 * `chrome.tabs.captureVisibleTab` shoots whatever the window shows, not a tab
 * by id, so a shot is kept only when everything still describes the page that
 * emitted the capture: the tab is the active tab of a focused, unminimized
 * window, its address is exactly the frame address the capture was sent from,
 * both before and after the shot, and the page itself confirms — just before
 * the shot — that it is still showing that capture, is focused and visible,
 * carries no password, one-time-code or card field, and holds no focused
 * editable element or typed form value. A page that does not answer promptly
 * is not shot. Anything else, and the shot is dropped: an image of another
 * page, even one on the same site, must never become this page's preview.
 *
 * The shot is of the visible viewport only, and is not redacted the way the
 * captured text is. Chrome allows it only with the optional `<all_urls>` host
 * grant (see `host-permission.ts`), which the caller checks first.
 */

/** The slice of `chrome.tabs` and `chrome.windows` a screenshot needs. */
export interface ScreenshotBrowser {
  getTab(tabId: number): Promise<{
    id?: number;
    windowId: number;
    active: boolean;
    url?: string;
    incognito?: boolean;
  }>;
  getWindow(windowId: number): Promise<{ focused: boolean; state?: string }>;
  captureVisibleTab(
    windowId: number,
    options: { format: "jpeg" | "png"; quality?: number },
  ): Promise<string>;
}

export interface PageScreenshot {
  contentType: ScreenshotType;
  width: number;
  height: number;
  capturedAt: string;
  /** Base64 of the encoded image. */
  image: string;
}

/** Why no screenshot was kept, for tests and diagnostics. */
export type ScreenshotSkip =
  "not-in-view" | "unconfirmed" | "changed" | "capture-failed" | "too-large";

interface InView {
  windowId: number;
}

/**
 * Whether `tabId` is the active tab of a focused, visible window showing
 * exactly `frameUrl`, the address the capture was sent from.
 */
async function inView(
  browser: ScreenshotBrowser,
  tabId: number,
  frameUrl: string,
): Promise<InView | null> {
  try {
    const tab = await browser.getTab(tabId);
    if (!tab.active || tab.incognito || tab.url !== frameUrl) return null;
    const window = await browser.getWindow(tab.windowId);
    if (!window.focused || window.state === "minimized") return null;
    return { windowId: tab.windowId };
  } catch {
    return null;
  }
}

export interface ScreenshotTarget {
  tabId: number;
  /** The exact frame address the capture message came from. */
  frameUrl: string;
  /**
   * Ask the page whether it is still safe to shoot as this capture; resolves
   * false (or rejects) when it is not, or when it does not answer in time.
   */
  confirm: () => Promise<boolean>;
}

export async function takePageScreenshot<Image extends DecodedImage>(
  target: ScreenshotTarget,
  deps: { browser: ScreenshotBrowser; codec: ScreenshotCodec<Image>; now?: () => number },
): Promise<PageScreenshot | ScreenshotSkip> {
  const before = await inView(deps.browser, target.tabId, target.frameUrl);
  if (!before) return "not-in-view";
  const confirmed = await target.confirm().catch(() => false);
  if (!confirmed) return "unconfirmed";
  const capturedAt = new Date((deps.now ?? Date.now)()).toISOString();
  let dataUrl: string;
  try {
    dataUrl = await deps.browser.captureVisibleTab(before.windowId, {
      format: "jpeg",
      quality: 92,
    });
  } catch {
    return "capture-failed";
  }
  const after = await inView(deps.browser, target.tabId, target.frameUrl);
  if (!after || after.windowId !== before.windowId) return "changed";
  let encoded;
  try {
    encoded = await encodeScreenshot(dataUrl, deps.codec);
  } catch {
    return "capture-failed";
  }
  if (!encoded) return "too-large";
  return {
    contentType: encoded.contentType,
    width: encoded.width,
    height: encoded.height,
    capturedAt,
    image: bytesToBase64(encoded.bytes),
  };
}

/** How long the page has to confirm a screenshot before it is skipped. */
export const SCREENSHOT_CONFIRM_TIMEOUT_MS = 1_000;

/** The worker's codec: `createImageBitmap` to decode, `OffscreenCanvas` to scale and encode. */
export const offscreenCodec: ScreenshotCodec<ImageBitmap> = {
  async decode(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type }));
  },
  async encode(image, width, height, type, quality) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D context");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type, quality });
    return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
  },
  release(image) {
    image.close();
  },
};

/** The real `chrome.tabs` / `chrome.windows` behind {@link ScreenshotBrowser}. */
export function chromeScreenshotBrowser(): ScreenshotBrowser {
  return {
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === undefined) throw new Error("the tab has no window");
      return { ...tab, windowId: tab.windowId, active: tab.active === true };
    },
    getWindow: (windowId) => chrome.windows.get(windowId),
    captureVisibleTab: (windowId, options) => chrome.tabs.captureVisibleTab(windowId, options),
  };
}
