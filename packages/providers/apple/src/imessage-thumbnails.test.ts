// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAX_THUMBNAIL_BYTES,
  SMALL_ENOUGH_BYTES,
  ThumbnailTimeoutError,
  jpegDimensions,
  renderIMessageThumbnail,
  thumbnailKind,
  type ThumbnailCommandRunner,
} from "./imessage-thumbnails.js";

/** A minimal JPEG: SOI, an APP0 segment, a baseline frame header, EOI, padded to `size`. */
function jpeg(width: number, height: number, size = 64): Uint8Array {
  const head = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ];
  const bytes = new Uint8Array(Math.max(size, head.length + 2));
  bytes.set(head, 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

interface Call {
  command: string;
  args: string[];
  timeoutMs: number;
}

/**
 * Stands in for sips and qlmanage: sips writes a JPEG of the requested size
 * to its `--out`, qlmanage writes a PNG into its `-o` directory.
 */
function fakeTools(jpegBytesFor: (size: number) => number = () => 2048) {
  const calls: Call[] = [];
  const run: ThumbnailCommandRunner = async (command, args, { timeoutMs }) => {
    calls.push({ command, args, timeoutMs });
    if (command === "qlmanage") {
      const dir = args[args.indexOf("-o") + 1]!;
      const input = args[args.length - 1]!;
      await writeFile(join(dir, `${input.split("/").pop()}.png`), "png");
      return;
    }
    const size = Number(args[args.indexOf("-Z") + 1]);
    const out = args[args.indexOf("--out") + 1]!;
    await writeFile(out, jpeg(size, Math.round((size * 3) / 4), jpegBytesFor(size)));
  };
  return { run, calls };
}

const now = () => new Date("2026-03-04T08:13:00.000Z");
let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("renderIMessageThumbnail", () => {
  test("turns a photo into a 512-pixel JPEG with sips, writing only into a private temp dir", async () => {
    const { run, calls } = fakeTools();
    const preview = await renderIMessageThumbnail(
      "/Users/maya/Library/IMG_0001.HEIC",
      "image/heic",
      {
        run,
        platform: "darwin",
        now,
      },
    );
    expect(preview).toMatchObject({
      contentType: "image/jpeg",
      width: 512,
      height: 384,
      capturedAt: "2026-03-04T08:13:00.000Z",
    });
    expect(calls).toHaveLength(1);
    const [sips] = calls;
    expect(sips!.command).toBe("sips");
    expect(sips!.timeoutMs).toBe(20_000);
    const out = sips!.args[sips!.args.indexOf("--out") + 1]!;
    expect(sips!.args).toEqual([
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "60",
      "-Z",
      "512",
      "/Users/maya/Library/IMG_0001.HEIC",
      "--out",
      out,
    ]);
    expect(out.startsWith(tmpdir())).toBe(true);
    // The temporary directory is gone once the thumbnail is read back.
    expect(existsSync(dirname(out))).toBe(false);
  });

  test.each([
    ["video/quicktime", "/Users/maya/Library/clip.MOV"],
    ["application/pdf", "/Users/maya/Library/menu.pdf"],
  ])("renders a %s with qlmanage first, then converts its PNG", async (mimeType, file) => {
    const { run, calls } = fakeTools();
    const preview = await renderIMessageThumbnail(file, mimeType, { run, platform: "darwin", now });
    expect(preview?.width).toBe(512);
    expect(calls.map((c) => c.command)).toEqual(["qlmanage", "sips"]);
    const [ql, sips] = calls;
    const dir = ql!.args[ql!.args.indexOf("-o") + 1]!;
    expect(ql!.args).toEqual(["-t", "-s", "512", "-o", dir, file]);
    expect(sips!.args[8]).toBe(join(dir, `${file.split("/").pop()}.png`));
    expect(sips!.args[sips!.args.indexOf("--out") + 1]!.startsWith(dir)).toBe(true);
  });

  test("makes a heavy thumbnail again at 384 pixels, and gives up on one still too heavy", async () => {
    const heavy = fakeTools((size) => (size === 512 ? SMALL_ENOUGH_BYTES + 1 : 4096));
    const smaller = await renderIMessageThumbnail("/tmp/photo.jpg", "image/jpeg", {
      run: heavy.run,
      platform: "darwin",
      now,
    });
    expect(smaller).toMatchObject({ width: 384, height: 288 });
    expect(heavy.calls.map((c) => c.args[c.args.indexOf("-Z") + 1])).toEqual(["512", "384"]);

    const huge = fakeTools(() => MAX_THUMBNAIL_BYTES + 1);
    expect(
      await renderIMessageThumbnail("/tmp/photo.jpg", "image/jpeg", {
        run: huge.run,
        platform: "darwin",
        now,
      }),
    ).toBeNull();
  });

  test("a tool that fails gives no thumbnail; one that times out throws so it is tried again", async () => {
    let dir: string | undefined;
    const failing: ThumbnailCommandRunner = async (_command, args) => {
      dir = dirname(args[args.indexOf("--out") + 1]!);
      throw new Error("sips: unable to render");
    };
    expect(
      await renderIMessageThumbnail("/tmp/photo.jpg", "image/jpeg", {
        run: failing,
        platform: "darwin",
      }),
    ).toBeNull();
    expect(existsSync(dir!)).toBe(false);

    const slow: ThumbnailCommandRunner = async (command, _args, { timeoutMs }) => {
      throw new ThumbnailTimeoutError(command, timeoutMs);
    };
    await expect(
      renderIMessageThumbnail("/tmp/clip.mov", "video/mp4", {
        run: slow,
        platform: "darwin",
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(ThumbnailTimeoutError);
  });

  test("qlmanage that writes nothing gives no thumbnail", async () => {
    const silent: ThumbnailCommandRunner = async () => {};
    expect(
      await renderIMessageThumbnail("/tmp/clip.mov", "video/mp4", {
        run: silent,
        platform: "darwin",
      }),
    ).toBeNull();
  });

  test("runs nothing off macOS or for a type with no thumbnail", async () => {
    const { run, calls } = fakeTools();
    expect(
      await renderIMessageThumbnail("/tmp/photo.jpg", "image/jpeg", { run, platform: "linux" }),
    ).toBeNull();
    expect(
      await renderIMessageThumbnail("/tmp/notes.txt", "text/plain", { run, platform: "darwin" }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("thumbnailKind", () => {
  test("names photos, videos and PDFs only", () => {
    expect(thumbnailKind("image/heic")).toBe("image");
    expect(thumbnailKind("video/quicktime")).toBe("video");
    expect(thumbnailKind("application/pdf; charset=binary")).toBe("pdf");
    expect(thumbnailKind("audio/x-caf")).toBeNull();
  });
});

describe("jpegDimensions", () => {
  test("reads the frame header past other segments", () => {
    expect(jpegDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });

  test("is null for bytes that are not a JPEG or carry no frame", () => {
    expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

/** A flat grey PNG of the given size, encoded here so the test needs no image file. */
function grayPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const row = Buffer.alloc(width + 1, 0x80);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.runIf(process.platform === "darwin")("renderIMessageThumbnail with the real sips", () => {
  test("makes a JPEG thumbnail of a generated image", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-thumb-real-"));
    const source = join(scratch, "source.png");
    writeFileSync(source, grayPng(1024, 768));
    const before = readFileSync(source);
    const preview = await renderIMessageThumbnail(source, "image/png");
    expect(preview?.contentType).toBe("image/jpeg");
    expect(Math.max(preview!.width, preview!.height)).toBe(512);
    expect(readFileSync(source)).toEqual(before);
  });
});
