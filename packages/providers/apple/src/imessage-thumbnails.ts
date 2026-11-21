// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thumbnails of iMessage photos, videos and PDFs, made with the tools macOS
 * ships.
 *
 * A photo (HEIC included) goes through `sips`, which scales it to fit 512
 * pixels and writes a JPEG. A video or PDF has no image of its own for `sips`
 * to read, so Quick Look (`qlmanage -t`) renders its first frame or page to a
 * PNG first, and `sips` turns that into the JPEG. A thumbnail over
 * {@link SMALL_ENOUGH_BYTES} is made again at 384 pixels; one still over the
 * gateway's limit is given up on.
 *
 * Every file is written to a fresh private temporary directory, removed when
 * the thumbnail has been read back, and every tool runs under a deadline
 * after which it is killed. Elsewhere than macOS there is nothing to run and
 * no thumbnail.
 */

import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RenderedDocumentPreview } from "@omnesis/source-sdk";

const execFileAsync = promisify(execFile);

/** Largest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 512;
/** Largest side of a thumbnail made again because the first was too heavy. */
export const SMALLER_THUMBNAIL_SIZE = 384;
/** A thumbnail at or under this many bytes is kept as it is. */
export const SMALL_ENOUGH_BYTES = 80 * 1024;
/** The most the gateway keeps for one preview. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
/** How long one tool may run before it is killed. */
export const THUMBNAIL_TOOL_TIMEOUT_MS = 20_000;
const JPEG_QUALITY = "60";

/** Run a tool to completion, rejecting on a non-zero exit or the deadline. */
export type ThumbnailCommandRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<void>;

/** A tool that ran past its deadline and was killed, which is worth trying again. */
export class ThumbnailTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${timeoutMs}ms`);
    this.name = "ThumbnailTimeoutError";
  }
}

export const runThumbnailCommand: ThumbnailCommandRunner = async (command, args, { timeoutMs }) => {
  try {
    await execFileAsync(command, args, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const killed = (err as { killed?: boolean; signal?: string }).signal === "SIGKILL";
    if (killed) throw new ThumbnailTimeoutError(command, timeoutMs);
    throw err;
  }
};

export interface ThumbnailOptions {
  run?: ThumbnailCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => Date;
  timeoutMs?: number;
}

type ThumbnailKind = "image" | "video" | "pdf";

/** What kind of thumbnail a file of this MIME type gets, or null for none. */
export function thumbnailKind(mimeType: string): ThumbnailKind | null {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base === "application/pdf") return "pdf";
  return null;
}

/**
 * A JPEG thumbnail of the file at `filePath`, or null when it has none to
 * give: not macOS, a type with no thumbnail, a tool that failed on it, or a
 * thumbnail too heavy to keep. Throws {@link ThumbnailTimeoutError} when a
 * tool ran out of time, since that may go differently next time.
 */
export async function renderIMessageThumbnail(
  filePath: string,
  mimeType: string,
  opts: ThumbnailOptions = {},
): Promise<RenderedDocumentPreview | null> {
  if ((opts.platform ?? process.platform) !== "darwin") return null;
  const kind = thumbnailKind(mimeType);
  if (!kind) return null;
  const run = opts.run ?? runThumbnailCommand;
  const timeoutMs = opts.timeoutMs ?? THUMBNAIL_TOOL_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());

  const dir = await mkdtemp(join(tmpdir(), "omnesis-imessage-thumb-"));
  try {
    await chmod(dir, 0o700);
    let source = filePath;
    if (kind !== "image") {
      await run("qlmanage", ["-t", "-s", String(THUMBNAIL_SIZE), "-o", dir, filePath], {
        timeoutMs,
      });
      const rendered = (await readdir(dir)).find((name) => name.toLowerCase().endsWith(".png"));
      if (!rendered) return null;
      source = join(dir, rendered);
    }
    // Always with `--out`: without it sips rewrites its input in place, and
    // the input is the user's own file in the Messages library.
    const toJpeg = async (size: number, out: string): Promise<Uint8Array> => {
      await run(
        "sips",
        [
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          JPEG_QUALITY,
          "-Z",
          String(size),
          source,
          "--out",
          out,
        ],
        { timeoutMs },
      );
      return new Uint8Array(await readFile(out));
    };
    let bytes = await toJpeg(THUMBNAIL_SIZE, join(dir, "t.jpg"));
    if (bytes.byteLength > SMALL_ENOUGH_BYTES) {
      bytes = await toJpeg(SMALLER_THUMBNAIL_SIZE, join(dir, "t-small.jpg"));
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return null;
    const size = jpegDimensions(bytes);
    if (!size) return null;
    return {
      contentType: "image/jpeg",
      width: size.width,
      height: size.height,
      capturedAt: now().toISOString(),
      bytes,
    };
  } catch (err) {
    if (err instanceof ThumbnailTimeoutError) throw err;
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The width and height a JPEG's frame header declares, or null when the bytes
 * are not a JPEG or carry no frame header.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Fill bytes and markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}
