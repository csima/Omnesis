// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_QUALITY,
  bytesToBase64,
  encodeScreenshot,
  scaledSize,
  type ScreenshotCodec,
} from "./screenshot.js";

interface FakeImage {
  width: number;
  height: number;
}

function fakeCodec(
  image: FakeImage,
  produce: (type: string) => { type: string; size: number },
): ScreenshotCodec<FakeImage> & { calls: unknown[]; released: number } {
  const calls: unknown[] = [];
  const codec = {
    calls,
    released: 0,
    decode: () => Promise.resolve(image),
    encode: (_image: FakeImage, width: number, height: number, type: string, quality: number) => {
      calls.push({ width, height, type, quality });
      const out = produce(type);
      return Promise.resolve({ type: out.type, bytes: new Uint8Array(out.size) });
    },
    release: () => {
      codec.released += 1;
    },
  };
  return codec;
}

describe("scaledSize", () => {
  it("keeps a capture that already fits and scales the longest side to 1280", () => {
    expect(scaledSize(1024, 640)).toEqual({ width: 1024, height: 640 });
    expect(scaledSize(2560, 1440)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize(900, 3000)).toEqual({ width: 384, height: 1280 });
  });
});

describe("encodeScreenshot", () => {
  it("encodes WebP at the screenshot quality, downscaled", async () => {
    const codec = fakeCodec({ width: 2880, height: 1800 }, (type) => ({ type, size: 90_000 }));
    const shot = await encodeScreenshot("data:image/jpeg;base64,AA==", codec);
    expect(shot).toMatchObject({ contentType: "image/webp", width: 1280, height: 800 });
    expect(codec.calls).toEqual([
      { width: 1280, height: 800, type: "image/webp", quality: SCREENSHOT_QUALITY },
    ]);
    expect(codec.released).toBe(1);
  });

  it("falls back to JPEG when the browser cannot encode WebP", async () => {
    const codec = fakeCodec({ width: 1280, height: 720 }, (type) =>
      type === "image/webp" ? { type: "image/png", size: 10 } : { type, size: 70_000 },
    );
    const shot = await encodeScreenshot("data:,", codec);
    expect(shot?.contentType).toBe("image/jpeg");
  });

  it("drops a shot still over the size limit", async () => {
    const codec = fakeCodec({ width: 1280, height: 720 }, (type) => ({
      type,
      size: MAX_SCREENSHOT_BYTES + 1,
    }));
    expect(await encodeScreenshot("data:,", codec)).toBeNull();
    expect(codec.released).toBe(1);
  });
});

describe("bytesToBase64", () => {
  it("round-trips a buffer larger than one chunk", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(Buffer.from(bytesToBase64(bytes), "base64")).toEqual(Buffer.from(bytes));
  });
});
