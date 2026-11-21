// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { jpegDimensions } from "./binary-assets.js";

function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);
}
const APP0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
const DHT = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
// Height 384, width 512.
const SOF0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x80, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00];

describe("jpegDimensions", () => {
  test("reads the frame header past other segments", () => {
    expect(jpegDimensions(jpeg(APP0, DHT, SOF0))).toEqual({ width: 512, height: 384 });
  });

  test("is null for bytes that are not a JPEG or carry no frame", () => {
    expect(jpegDimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegDimensions(jpeg(APP0))).toBeNull();
    expect(jpegDimensions(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});
