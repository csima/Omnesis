// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { takePageScreenshot, type ScreenshotBrowser } from "./screenshot.js";
import type { ScreenshotCodec } from "../capture/screenshot.js";

const PAGE = "https://news.example.com/invented-story";

const codec: ScreenshotCodec<{ width: number; height: number }> = {
  decode: () => Promise.resolve({ width: 1440, height: 900 }),
  encode: (_image, _w, _h, type) => Promise.resolve({ type, bytes: new Uint8Array([1, 2, 3]) }),
};

interface World {
  tab: { windowId: number; active: boolean; url?: string; incognito?: boolean };
  window: { focused: boolean; state?: string };
}

function browser(world: World, onCapture: (world: World) => void = () => undefined) {
  const capture = vi.fn(async () => {
    onCapture(world);
    return "data:image/jpeg;base64,AAAA";
  });
  const api: ScreenshotBrowser = {
    getTab: async () => ({ ...world.tab }),
    getWindow: async () => ({ ...world.window }),
    captureVisibleTab: capture,
  };
  return { api, capture };
}

function world(overrides: Partial<World["tab"]> = {}, win: Partial<World["window"]> = {}): World {
  return {
    tab: { windowId: 3, active: true, url: PAGE, ...overrides },
    window: { focused: true, state: "normal", ...win },
  };
}

describe("takePageScreenshot", () => {
  it("shoots the active tab of a focused window and returns the encoded image", async () => {
    const { api, capture } = browser(world());
    const shot = await takePageScreenshot(
      { tabId: 9, pageUrl: PAGE },
      { browser: api, codec, now: () => Date.parse("2026-04-01T12:00:00Z") },
    );
    expect(capture).toHaveBeenCalledWith(3, { format: "jpeg", quality: 92 });
    expect(shot).toEqual({
      contentType: "image/webp",
      width: 1280,
      height: 800,
      capturedAt: "2026-04-01T12:00:00.000Z",
      image: "AQID",
    });
  });

  it.each([
    ["a background tab", world({ active: false })],
    ["an unfocused window", world({}, { focused: false })],
    ["a minimized window", world({}, { state: "minimized" })],
    ["a tab on another site", world({ url: "https://other.example.org/" })],
    ["an incognito tab", world({ incognito: true })],
  ])("never shoots %s", async (_label, state) => {
    const { api, capture } = browser(state);
    expect(await takePageScreenshot({ tabId: 9, pageUrl: PAGE }, { browser: api, codec })).toBe(
      "not-in-view",
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["the user switched tabs", (w: World) => (w.tab.active = false)],
    ["the window lost focus", (w: World) => (w.window.focused = false)],
    ["the tab navigated", (w: World) => (w.tab.url = `${PAGE}/next`)],
    ["the tab moved to another window", (w: World) => (w.tab.windowId = 4)],
  ])("drops the shot when %s while it was taken", async (_label, change) => {
    const { api } = browser(world(), change);
    expect(await takePageScreenshot({ tabId: 9, pageUrl: PAGE }, { browser: api, codec })).toBe(
      "changed",
    );
  });

  it("accepts a canonical capture key on the same site as the address bar", async () => {
    const { api } = browser(world({ url: "https://news.example.com/" }));
    const shot = await takePageScreenshot({ tabId: 9, pageUrl: PAGE }, { browser: api, codec });
    expect(typeof shot).toBe("object");
  });

  it("reports a refused capture and an image too large to keep", async () => {
    const refusing: ScreenshotBrowser = {
      ...browser(world()).api,
      captureVisibleTab: () => Promise.reject(new Error("no permission")),
    };
    expect(
      await takePageScreenshot({ tabId: 9, pageUrl: PAGE }, { browser: refusing, codec }),
    ).toBe("capture-failed");
    const huge: typeof codec = {
      ...codec,
      encode: (_i, _w, _h, type) => Promise.resolve({ type, bytes: new Uint8Array(600 * 1024) }),
    };
    expect(
      await takePageScreenshot(
        { tabId: 9, pageUrl: PAGE },
        { browser: browser(world()).api, codec: huge },
      ),
    ).toBe("too-large");
  });
});
