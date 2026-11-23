// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashText } from "../capture/content-hash.js";
import { MAX_SCREENSHOT_BYTES, type ScreenshotCodec } from "../capture/screenshot.js";
import { capturePairingId } from "../chrome/handoff-storage.js";
import { CAPTURE_PENDING_PREFIX } from "../chrome/messages.js";
import { PENDING_SCREENSHOTS_KEY } from "../chrome/screenshot-scheduler.js";
import { offscreenCodec } from "../chrome/screenshot.js";
import { QUEUE_STORAGE_KEY } from "../push/queue.js";
import {
  createSafariBackground,
  type SafariBackground,
  type SafariMessageSender,
} from "./background.js";
import { SAFARI_GATEWAY_ORIGIN } from "./native-bridge.js";
import {
  pageCanvasCodec,
  safariScreenshotBrowser,
  safariScreenshotCodec,
  type SafariScreenshotApi,
} from "./screenshot.js";
import { capturePolicy, FakeNativeApp, MemoryStorageArea } from "./test-fakes.js";

const RUNTIME_ID = "safari-extension-id";
const PAGE = "https://recipes.example.org/invented-lentil-soup";

/** A JPEG of `size` bytes: the SOI marker the gateway checks, then filler. */
function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

/** Safari's canvas as the encoder sees it: no WebP, JPEG of a chosen size. */
function fakeCodec(jpegSize = 40_000): ScreenshotCodec & { encodes: string[] } {
  const encodes: string[] = [];
  return {
    encodes,
    decode: async () => ({ width: 1179, height: 2556 }),
    encode: async (_image, width, height, type) => {
      encodes.push(`${type} ${width}x${height}`);
      return type === "image/webp"
        ? { type: "image/png", bytes: new Uint8Array(8) }
        : { type, bytes: jpegBytes(jpegSize) };
    },
  };
}

interface Screen {
  active: boolean;
  focused: boolean;
  url: string;
  incognito: boolean | undefined;
  answer: unknown;
}

let storage: MemoryStorageArea;
let app: FakeNativeApp;
let screen: Screen;
let captureVisibleTab: ReturnType<typeof vi.fn>;
let askPage: ReturnType<typeof vi.fn>;
let background: SafariBackground;

function boot(codec: ScreenshotCodec = fakeCodec()): SafariBackground {
  captureVisibleTab = vi.fn(async () => "data:image/png;base64,iVBORw0KGgo=");
  askPage = vi.fn(async () => screen.answer);
  const api: SafariScreenshotApi = {
    tabs: {
      get: async (tabId) => ({
        id: tabId,
        windowId: 1,
        active: screen.active,
        url: screen.url,
        ...(screen.incognito !== undefined ? { incognito: screen.incognito } : {}),
      }),
      captureVisibleTab,
    },
    windows: { get: async () => ({ focused: screen.focused }) },
  };
  return createSafariBackground({
    storage,
    sendNative: app.send,
    runtimeId: RUNTIME_ID,
    popupUrl: "safari-web-extension://x/popup.html",
    nativeTimeoutMs: 200,
    screenshots: {
      browser: safariScreenshotBrowser(api),
      codec,
      askPage,
      settleMs: 0,
    },
  });
}

function sender(overrides: Partial<NonNullable<SafariMessageSender["tab"]>> = {}) {
  return { id: RUNTIME_ID, url: PAGE, tab: { id: 7, incognito: false, ...overrides } };
}

async function capture(from: SafariMessageSender = sender()): Promise<unknown> {
  const text = "Invented soup: lentils, a carrot and an onion, simmered slowly.";
  const message = {
    type: "capture",
    emission: {
      kind: "visit",
      normalizedUrl: PAGE,
      title: "Lentil soup",
      text,
      contentHash: await hashText(text),
      visitedAt: "2026-03-01T10:00:00.000Z",
      dwellMs: 7000,
      contentChanged: true,
    },
    handoffKey: `${CAPTURE_PENDING_PREFIX}page.visit.${await hashText(PAGE)}`,
    pairingId: await capturePairingId({
      gatewayUrl: SAFARI_GATEWAY_ORIGIN,
      deviceId: app.pairing?.deviceId ?? "",
    }),
  };
  return new Promise((resolve, reject) => {
    if (!background.handleMessage(message, from, resolve)) reject(new Error("unhandled"));
  });
}

function bridged(): string[] {
  return app.requests.map((request) => `${request.method} ${request.path}`);
}

async function settled(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function queueIsEmpty(): boolean {
  return JSON.parse(String(storage.data.get(QUEUE_STORAGE_KEY) ?? "[]")).length === 0;
}

beforeEach(() => {
  storage = new MemoryStorageArea();
  app = new FakeNativeApp();
  app.policy = capturePolicy({ screenshots: { enabled: true } });
  screen = { active: true, focused: true, url: PAGE, incognito: false, answer: { ok: true } };
  background = boot();
});

describe("Safari page screenshots", () => {
  it("hands the app a JPEG of the visible tab, after its page", async () => {
    await background.start();
    await expect(capture()).resolves.toEqual({ ok: true, accepted: true });
    await vi.waitFor(() => expect(bridged()).toContain("PUT /documents/preview"));
    expect(bridged().indexOf("POST /documents")).toBeLessThan(
      bridged().indexOf("PUT /documents/preview"),
    );
    expect(askPage).toHaveBeenCalledWith(7, {
      type: "screenshot-check",
      url: PAGE,
      contentHash: await hashText(
        "Invented soup: lentils, a carrot and an onion, simmered slowly.",
      ),
    });
    expect(captureVisibleTab).toHaveBeenCalledWith(1, { format: "jpeg", quality: 92 });
    const upload = app.requests.find((request) => request.path === "/documents/preview");
    const body = upload?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      providerId: "web",
      sourceId: "web",
      externalId: await hashText(PAGE),
      contentType: "image/jpeg",
      width: 590,
      height: 1280,
    });
    expect(body).not.toHaveProperty("contentHash");
    expect(typeof body.capturedAt).toBe("string");
    const bytes = Buffer.from(String(body.image), "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await vi.waitFor(() => expect(queueIsEmpty()).toBe(true));
  });

  it("keeps no shot it cannot make small enough", async () => {
    background = boot(fakeCodec(MAX_SCREENSHOT_BYTES + 1));
    await background.start();
    await capture();
    await vi.waitFor(() => expect(captureVisibleTab).toHaveBeenCalled());
    await settled();
    expect(bridged()).not.toContain("PUT /documents/preview");
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toEqual([]);
  });

  it("takes none while the shared policy has screenshots off", async () => {
    app.policy = capturePolicy({ screenshots: { enabled: false } });
    await background.start();
    await capture();
    await settled();
    expect(bridged()).toContain("POST /documents");
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(bridged()).not.toContain("PUT /documents/preview");
  });

  it("takes nothing at all from a private tab", async () => {
    await background.start();
    await expect(capture(sender({ incognito: true }))).rejects.toThrow("unhandled");
    await settled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("never shoots a tab Safari does not mark as non-private", async () => {
    await background.start();
    await expect(capture(sender({ incognito: undefined }))).resolves.toEqual({
      ok: true,
      accepted: true,
    });
    await settled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toBeUndefined();
  });

  it("never shoots a tab the tabs API reports as private or cannot place", async () => {
    screen.incognito = undefined;
    await background.start();
    await capture();
    await settled();
    await background.tabInView(7);
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    ["the tab is not the front tab", () => (screen.active = false)],
    ["the window is not focused", () => (screen.focused = false)],
    ["the page declines", () => (screen.answer = { ok: false, reason: "typing" })],
    ["the tab shows another address", () => (screen.url = `${PAGE}/print`)],
  ])("waits when %s, and shoots once the tab is back in view", async (_label, hide) => {
    hide();
    await background.start();
    await capture();
    await vi.waitFor(() =>
      expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toEqual([
        expect.objectContaining({ tabId: 7, frameUrl: PAGE, attempts: 1 }),
      ]),
    );
    expect(bridged()).not.toContain("PUT /documents/preview");

    screen = { active: true, focused: true, url: PAGE, incognito: false, answer: { ok: true } };
    await expect(background.tabInView(7)).resolves.toBe("queued");
    await vi.waitFor(() => expect(bridged()).toContain("PUT /documents/preview"));
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toEqual([]);
  });

  it("retries when the page says it is visible again", async () => {
    screen.active = false;
    await background.start();
    await capture();
    await vi.waitFor(() => expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toHaveLength(1));
    screen.active = true;
    expect(background.handleMessage({ type: "screenshot-in-view" }, sender(), () => {})).toBe(
      false,
    );
    await vi.waitFor(() => expect(bridged()).toContain("PUT /documents/preview"));
  });

  it("drops a waiting shot when the tab navigates or closes", async () => {
    screen.active = false;
    await background.start();
    await capture();
    await vi.waitFor(() => expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toHaveLength(1));
    await background.tabNavigated(7, PAGE);
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toHaveLength(1);
    await background.tabNavigated(7, "https://recipes.example.org/another-invented-dish");
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toEqual([]);
    screen.active = true;
    await expect(background.tabInView(7)).resolves.toBe("idle");

    screen.active = false;
    await capture();
    await vi.waitFor(() => expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toHaveLength(1));
    await background.tabClosed(7);
    expect(storage.data.get(PENDING_SCREENSHOTS_KEY)).toEqual([]);
    expect(captureVisibleTab).toHaveBeenCalledTimes(0);
  });

  it("asks nothing of the tabs when the extension has no screenshot support", async () => {
    background = createSafariBackground({
      storage,
      sendNative: app.send,
      runtimeId: RUNTIME_ID,
      popupUrl: "safari-web-extension://x/popup.html",
      nativeTimeoutMs: 200,
    });
    await background.start();
    await capture();
    await settled();
    expect(bridged()).toContain("POST /documents");
    await expect(background.tabInView(7)).resolves.toBe("idle");
  });

  it("keeps pages flowing past an app that refuses the screenshot upload", async () => {
    app.allowsPreviews = false;
    await background.start();
    await capture();
    await vi.waitFor(() => expect(bridged()).toContain("PUT /documents/preview"));
    await vi.waitFor(() => expect(queueIsEmpty()).toBe(true));
    const status = await new Promise<{ status?: { refused?: boolean } }>((resolve) =>
      background.handleMessage(
        { type: "safari-status" },
        { id: RUNTIME_ID, url: "safari-web-extension://x/popup.html" },
        (answer) => resolve(answer as { status?: { refused?: boolean } }),
      ),
    );
    expect(status.status?.refused).toBe(false);
  });
});

describe("Safari's screenshot tabs and codec", () => {
  it("reads a tab with no private flag as private", async () => {
    const browser = safariScreenshotBrowser({
      tabs: {
        get: async () => ({ id: 3, windowId: 1, active: true, url: PAGE }),
        captureVisibleTab: async () => "",
      },
    });
    expect(await browser.getTab(3)).toMatchObject({ incognito: true, active: true });
    expect(await browser.getWindow(1), "no window lookup: the page's check decides").toEqual({
      focused: true,
    });
  });

  it("uses OffscreenCanvas where Safari has it, the page's canvas where not", () => {
    expect(
      safariScreenshotCodec({ OffscreenCanvas: class {}, createImageBitmap: () => undefined }),
    ).toBe(offscreenCodec);
    const document = { createElement: vi.fn() };
    expect(safariScreenshotCodec({ document })).not.toBe(offscreenCodec);
    expect(safariScreenshotCodec({})).toBeNull();
  });

  it("scales on the page canvas and reports the type Safari actually encoded", async () => {
    const drawn: number[][] = [];
    const codec = pageCanvasCodec({
      createImage: () => ({
        src: "",
        naturalWidth: 1179,
        naturalHeight: 2556,
        decode: async () => undefined,
      }),
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingQuality: "low",
          drawImage: (_image, _x, _y, width, height) => void drawn.push([width, height]),
        }),
        toBlob: (callback, type) =>
          callback(new Blob([jpegBytes(64)], { type: type === "image/webp" ? "image/png" : type })),
      }),
    });
    const image = await codec.decode("data:image/png;base64,iVBORw0KGgo=");
    expect(image).toMatchObject({ width: 1179, height: 2556 });
    expect((await codec.encode(image, 591, 1280, "image/webp", 0.7)).type).toBe("image/png");
    const jpeg = await codec.encode(image, 591, 1280, "image/jpeg", 0.7);
    expect(jpeg.type).toBe("image/jpeg");
    expect(jpeg.bytes.byteLength).toBe(64);
    expect(drawn).toEqual([
      [591, 1280],
      [591, 1280],
    ]);
  });
});
