// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface BinaryFixtureAsset {
  /** Path relative to the universe directory, never the source directory. */
  assetPath: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
}
export interface LoadedBinaryFixtureAsset {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Fixture safety limits, independent of extraction settings. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function validateBinaryFixtureAssets(attachments: readonly BinaryFixtureAsset[]): void {
  if (!Array.isArray(attachments) || attachments.length > 20)
    throw new Error("Synthetic fixture attachments must be an array of at most 20 parts");
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment.filename !== "string" ||
      !attachment.filename.trim() ||
      !/^[^\x00-\x1f\x7f"\\/]{1,255}$/.test(attachment.filename) ||
      attachment.filename === "." ||
      attachment.filename === ".." ||
      typeof attachment.mimeType !== "string" ||
      attachment.mimeType.length > 127 ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(attachment.mimeType)
    )
      throw new Error("Synthetic fixture attachment has an invalid filename or MIME type");
    const path = attachment.assetPath;
    if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path))
      throw new Error("Synthetic fixture asset path must be universe-relative");
    if (
      attachment.sizeBytes !== undefined &&
      (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)
    )
      throw new Error("Synthetic fixture asset size must be a non-negative integer");
  }
}

/** Load bounded binary data; resolve symlinks before enforcing the universe boundary. */
export function loadBinaryFixtureAssets(
  attachments: readonly BinaryFixtureAsset[],
  universeDir: string,
): LoadedBinaryFixtureAsset[] {
  validateBinaryFixtureAssets(attachments);
  const root = realpathSync(universeDir);
  let totalBytes = 0;
  return attachments.map((attachment) => {
    const path = attachment.assetPath;
    const requested = resolve(root, path);
    if (!contained(root, requested))
      throw new Error("Synthetic fixture asset escapes its universe");
    const resolved = realpathSync(requested);
    if (!contained(root, resolved)) throw new Error("Synthetic fixture asset escapes its universe");
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES)
        throw new Error("Synthetic fixture asset must be a regular file of at most 25 MiB");
      if (totalBytes + stat.size > MAX_MESSAGE_ATTACHMENT_BYTES)
        throw new Error("Synthetic fixture message attachments exceed 50 MiB");
      const content = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < content.length) {
        const count = readSync(fd, content, length, content.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size) throw new Error("Synthetic fixture asset changed while being read");
      if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== length)
        throw new Error("Synthetic fixture asset size differs from its declared size");
      totalBytes += length;
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: content.subarray(0, length),
      };
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * The pixel size a JPEG says it has, read from its first start-of-frame
 * marker, or null for bytes that are not a JPEG or carry no frame header.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
