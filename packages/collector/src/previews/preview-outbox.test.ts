// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { PreviewOutbox, type PreviewUploader } from "./preview-outbox.js";
import type {
  DocumentPreviewUpload,
  DocumentPreviewUploadResult,
  RenderedDocumentPreview,
} from "@omnesis/source-sdk";

const SOURCE = { sourceId: "photos-synth:maya@example.com", providerId: "photos-synth" };
const OTHER = { sourceId: "photos-synth:jamie@example.com", providerId: "photos-synth" };

const image: RenderedDocumentPreview = {
  contentType: "image/jpeg",
  width: 512,
  height: 384,
  capturedAt: "2026-03-04T08:12:00.000Z",
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
};

/** An uploader that answers from a script and records every upload. */
function scriptedUploader(
  answer: (upload: DocumentPreviewUpload, call: number) => DocumentPreviewUploadResult,
) {
  const uploads: DocumentPreviewUpload[] = [];
  const uploader: PreviewUploader = {
    putDocumentPreview: async (upload) => {
      uploads.push(upload);
      return answer(upload, uploads.length);
    },
  };
  return { uploader, uploads };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("PreviewOutbox", () => {
  test("nothing renders or uploads before the page is released", async () => {
    const { uploader, uploads } = scriptedUploader(() => ({ outcome: "stored" }));
    const outbox = new PreviewOutbox({ uploader });
    let renders = 0;
    const outcome = outbox.sinkFor(SOURCE).offer({
      externalId: "day-1/att/a",
      render: async () => {
        renders++;
        return image;
      },
    });
    await flush();
    expect(renders).toBe(0);
    expect(uploads).toHaveLength(0);
    expect(outbox.pending).toBe(1);

    outbox.release(SOURCE.sourceId);
    expect(await outcome).toBe("stored");
    expect(renders).toBe(1);
    expect(uploads).toEqual([
      {
        ...SOURCE,
        externalId: "day-1/att/a",
        contentType: "image/jpeg",
        width: 512,
        height: 384,
        capturedAt: image.capturedAt,
        bytes: image.bytes,
      },
    ]);
    expect(outbox.pending).toBe(0);
  });

  test("a page that is not written drops its offers as deferred, and only its own", async () => {
    const { uploader, uploads } = scriptedUploader(() => ({ outcome: "stored" }));
    const outbox = new PreviewOutbox({ uploader });
    let renders = 0;
    const render = async () => {
      renders++;
      return image;
    };
    const dropped = outbox.sinkFor(SOURCE).offer({ externalId: "a", render });
    const kept = outbox.sinkFor(OTHER).offer({ externalId: "b", render });

    outbox.drop(SOURCE.sourceId);
    expect(await dropped).toBe("deferred");
    outbox.release(SOURCE.sourceId);
    outbox.release(OTHER.sourceId);
    expect(await kept).toBe("stored");
    expect(renders).toBe(1);
    expect(uploads.map((u) => u.externalId)).toEqual(["b"]);
  });

  test("at most two jobs render or upload at once across every source", async () => {
    const gates: Array<ReturnType<typeof deferred<DocumentPreviewUploadResult>>> = [];
    let inFlight = 0;
    let peak = 0;
    const outbox = new PreviewOutbox({
      uploader: {
        putDocumentPreview: async () => {
          const gate = deferred<DocumentPreviewUploadResult>();
          gates.push(gate);
          const result = await gate.promise;
          inFlight--;
          return result;
        },
      },
    });
    const render = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return image;
    };
    const outcomes = [
      ...[1, 2, 3].map((n) => outbox.sinkFor(SOURCE).offer({ externalId: `s-${n}`, render })),
      ...[1, 2].map((n) => outbox.sinkFor(OTHER).offer({ externalId: `o-${n}`, render })),
    ];
    outbox.release(SOURCE.sourceId);
    outbox.release(OTHER.sourceId);
    for (let answered = 0; answered < 5; answered++) {
      while (gates.length <= answered) await flush();
      await flush();
      expect(inFlight).toBeLessThanOrEqual(2);
      gates[answered]!.resolve({ outcome: "stored" });
    }
    expect(await Promise.all(outcomes)).toEqual(Array(5).fill("stored"));
    expect(peak).toBe(2);
  });

  test("a gateway that keeps no previews pauses the source until the collector reconnects", async () => {
    const { uploader, uploads } = scriptedUploader((upload) =>
      upload.sourceId === SOURCE.sourceId
        ? { outcome: "unsupported", code: "PREVIEWS_NOT_ACCEPTED" }
        : { outcome: "stored" },
    );
    const outbox = new PreviewOutbox({ uploader, concurrency: 1 });
    const render = async () => image;
    const first = outbox.sinkFor(SOURCE).offer({ externalId: "a", render });
    const queued = outbox.sinkFor(SOURCE).offer({ externalId: "b", render });
    const sibling = outbox.sinkFor(OTHER).offer({ externalId: "c", render });
    outbox.release(SOURCE.sourceId);
    outbox.release(OTHER.sourceId);
    expect(await Promise.all([first, queued, sibling])).toEqual(["deferred", "deferred", "stored"]);
    expect(uploads.map((u) => u.externalId)).toEqual(["a", "c"]);

    // While paused an offer is deferred at once and never staged.
    expect(await outbox.sinkFor(SOURCE).offer({ externalId: "d", render })).toBe("deferred");
    expect(outbox.pending).toBe(0);

    outbox.resumeAll();
    const again = outbox.sinkFor(SOURCE).offer({ externalId: "e", render });
    outbox.release(SOURCE.sourceId);
    expect(await again).toBe("deferred");
    expect(uploads.map((u) => u.externalId)).toEqual(["a", "c", "e"]);
  });

  test("transient answers are retried with backoff and the gateway's wait, then deferred", async () => {
    const waits: number[] = [];
    const { uploader, uploads } = scriptedUploader(() => ({
      outcome: "transient",
      reason: "busy",
      retryAfterMs: 5_000,
    }));
    const outbox = new PreviewOutbox({
      uploader,
      retryDelayMs: (retry) => [1_000, 8_000, 90_000][retry]!,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const outcome = outbox.sinkFor(SOURCE).offer({ externalId: "a", render: async () => image });
    outbox.release(SOURCE.sourceId);
    expect(await outcome).toBe("deferred");
    expect(uploads).toHaveLength(4);
    expect(waits).toEqual([5_000, 8_000, 60_000]);
  });

  test("a transient answer that later succeeds is stored", async () => {
    const { uploader } = scriptedUploader((_upload, call) =>
      call === 1 ? { outcome: "transient", reason: "busy" } : { outcome: "stored" },
    );
    const outbox = new PreviewOutbox({ uploader, sleep: async () => {} });
    const outcome = outbox.sinkFor(SOURCE).offer({ externalId: "a", render: async () => image });
    outbox.release(SOURCE.sourceId);
    expect(await outcome).toBe("stored");
  });

  test("a render with nothing to give is refused, one that throws is deferred, neither uploads", async () => {
    const { uploader, uploads } = scriptedUploader(() => ({ outcome: "stored" }));
    const outbox = new PreviewOutbox({ uploader });
    const sink = outbox.sinkFor(SOURCE);
    const none = sink.offer({ externalId: "a", render: async () => null });
    const failed = sink.offer({
      externalId: "b",
      render: async () => {
        throw new Error("the tool timed out");
      },
    });
    outbox.release(SOURCE.sourceId);
    expect(await Promise.all([none, failed])).toEqual(["refused", "deferred"]);
    expect(uploads).toHaveLength(0);
  });

  test("refused and not-found answers pass through", async () => {
    const { uploader } = scriptedUploader((upload) =>
      upload.externalId === "a"
        ? { outcome: "refused", status: 409, code: "SOURCE_REJECTED" }
        : { outcome: "not-found" },
    );
    const outbox = new PreviewOutbox({ uploader });
    const sink = outbox.sinkFor(SOURCE);
    const refused = sink.offer({ externalId: "a", render: async () => image });
    const missing = sink.offer({ externalId: "b", render: async () => image });
    outbox.release(SOURCE.sourceId);
    expect(await Promise.all([refused, missing])).toEqual(["refused", "not-found"]);
  });

  test("a gateway client without uploads defers and pauses the source", async () => {
    const outbox = new PreviewOutbox({ uploader: {} });
    const outcome = outbox.sinkFor(SOURCE).offer({ externalId: "a", render: async () => image });
    outbox.release(SOURCE.sourceId);
    expect(await outcome).toBe("deferred");
    expect(await outbox.sinkFor(SOURCE).offer({ externalId: "b", render: async () => image })).toBe(
      "deferred",
    );
  });
});
