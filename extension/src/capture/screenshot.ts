// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turning a visible-tab capture into the screenshot a page keeps as its
 * preview: scaled so its longest side is at most {@link MAX_SCREENSHOT_SIDE}
 * pixels, encoded as WebP at about {@link SCREENSHOT_QUALITY}, JPEG when the
 * browser cannot encode WebP, and dropped when it is still over
 * {@link MAX_SCREENSHOT_BYTES}. Chrome-free: the decoder and encoder are
 * injected, so the rules run under Node with a fake codec and in the worker
 * with `createImageBitmap` and `OffscreenCanvas`.
 */

export const MAX_SCREENSHOT_SIDE = 1280;
export const SCREENSHOT_QUALITY = 0.7;
/** The gateway's limit on one preview image. */
export const MAX_SCREENSHOT_BYTES = 512 * 1024;

export type ScreenshotType = "image/webp" | "image/jpeg";

/** A decoded capture the encoder can draw. */
export interface DecodedImage {
  width: number;
  height: number;
}

export interface ScreenshotCodec<Image extends DecodedImage = DecodedImage> {
  decode(dataUrl: string): Promise<Image>;
  /**
   * Draw `image` at `width` × `height` and encode it as `type`. Returns the
   * type actually produced, which a browser that cannot encode WebP reports
   * as PNG.
   */
  encode(
    image: Image,
    width: number,
    height: number,
    type: ScreenshotType,
    quality: number,
  ): Promise<{ type: string; bytes: Uint8Array }>;
  /** Release a decoded image. */
  release?(image: Image): void;
}

export interface EncodedScreenshot {
  contentType: ScreenshotType;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** The size a `width` × `height` capture is drawn at: the longest side at most `maxSide`. */
export function scaledSize(
  width: number,
  height: number,
  maxSide = MAX_SCREENSHOT_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Scale and encode a capture, or null when it cannot be made small enough. */
export async function encodeScreenshot<Image extends DecodedImage>(
  dataUrl: string,
  codec: ScreenshotCodec<Image>,
): Promise<EncodedScreenshot | null> {
  const image = await codec.decode(dataUrl);
  try {
    if (image.width < 1 || image.height < 1) return null;
    const size = scaledSize(image.width, image.height);
    for (const type of ["image/webp", "image/jpeg"] as const) {
      const encoded = await codec.encode(image, size.width, size.height, type, SCREENSHOT_QUALITY);
      if (encoded.type !== type) continue;
      if (encoded.bytes.byteLength === 0 || encoded.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
        return null;
      }
      return { contentType: type, ...size, bytes: encoded.bytes };
    }
    return null;
  } finally {
    codec.release?.(image);
  }
}

/** Base64 of `bytes`, in chunks so a large image never overflows the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
