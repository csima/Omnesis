// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_ATTEMPTS, PushClient, PREVIEW_LEDGER_KEY, clearPushQueue } from "./client.js";
import { PersistentQueue } from "./queue.js";
import { buildWebPageDocument } from "./documents.js";
import { FakeFetch, MemoryStore, jsonResponse } from "./test-fakes.js";
import type { PagePreviewUpload, QueueItem } from "./types.js";

const GATEWAY = "https://gateway.example.ts.net:7600";
const TOKEN = "tok_write_web_fake";

function preview(externalId: string, contentHash = "hash-1"): PagePreviewUpload {
  return {
    providerId: "web",
    sourceId: "web",
    externalId,
    contentHash,
    contentType: "image/webp",
    width: 1280,
    height: 720,
    capturedAt: "2026-01-01T00:00:05.000Z",
    image: "UklGRgAAAABXRUJQ",
  };
}

async function pageDoc(url: string, hash = "h1") {
  return buildWebPageDocument({
    normalizedUrl: url,
    title: "An invented page",
    text: `text for ${url}`,
    contentHash: hash,
    visitedAt: "2026-01-01T00:00:00.000Z",
  });
}

function client(store: MemoryStore, fetch: FakeFetch) {
  return new PushClient({ gatewayUrl: GATEWAY, token: TOKEN, fetch: fetch.fetch, store });
}

describe("page screenshot uploads", () => {
  it("are sent after their page, as PUT /documents/preview without the text hash", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch((req) =>
      req.url.includes("/documents/preview")
        ? jsonResponse(200, { stored: true, preview: {} })
        : jsonResponse(200, { ingested: 1 }),
    );
    const push = client(store, fetch);
    const doc = await pageDoc("https://news.example.com/a");
    await push.enqueueDocument(doc);
    await push.enqueuePreview(preview(doc.externalId));
    const result = await push.drain();
    expect(result.delivered).toBe(2);
    expect(fetch.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /documents",
      "PUT /documents/preview",
    ]);
    const body = fetch.requests[1].body as Record<string, unknown>;
    expect(body).toEqual({
      providerId: "web",
      sourceId: "web",
      externalId: doc.externalId,
      contentType: "image/webp",
      width: 1280,
      height: 720,
      capturedAt: "2026-01-01T00:00:05.000Z",
      image: "UklGRgAAAABXRUJQ",
    });
  });

  it("a newer page snapshot moves the page's queued screenshot behind it", async () => {
    const store = new MemoryStore();
    const push = client(store, new FakeFetch(() => jsonResponse(503, {})));
    const first = await pageDoc("https://news.example.com/a", "h1");
    await push.enqueueDocument(first);
    await push.enqueuePreview(preview(first.externalId));
    await push.enqueueDocument(await pageDoc("https://news.example.com/a", "h2"));
    const kinds = (await new PersistentQueue(store).list()).map((item) => item.kind);
    expect(kinds).toEqual(["document", "preview"]);
  });

  it("keeps one queued screenshot per page", async () => {
    const store = new MemoryStore();
    const push = client(store, new FakeFetch(() => jsonResponse(503, {})));
    await push.enqueuePreview(preview("page-a", "h1"));
    await push.enqueuePreview(preview("page-a", "h2"));
    await push.enqueuePreview(preview("page-b", "h1"));
    const queued = (await new PersistentQueue(store).list()) as Extract<
      QueueItem,
      { kind: "preview" }
    >[];
    expect(queued.map((item) => [item.preview.externalId, item.preview.contentHash])).toEqual([
      ["page-a", "h2"],
      ["page-b", "h1"],
    ]);
  });

  it("are wanted again only when the page text changed since the last uploaded shot", async () => {
    const store = new MemoryStore();
    const push = client(store, new FakeFetch(() => jsonResponse(200, { stored: true })));
    expect(await push.previewWanted("page-a", "h1")).toBe(true);
    await push.enqueuePreview(preview("page-a", "h1"));
    expect(await push.previewWanted("page-a", "h1")).toBe(false);
    await push.drain();
    expect(await push.previewWanted("page-a", "h1")).toBe(false);
    expect(await push.previewWanted("page-a", "h2")).toBe(true);
    expect(JSON.parse((await store.get(PREVIEW_LEDGER_KEY))!)).toEqual({ "page-a": "h1" });
    await clearPushQueue(store);
    expect(await push.previewWanted("page-a", "h1")).toBe(true);
  });

  it.each([400, 404, 409, 410, 413, 415, 422])(
    "a %i refusal drops the shot silently without recording it or a failure",
    async (status) => {
      const store = new MemoryStore();
      const push = client(
        store,
        new FakeFetch(() => jsonResponse(status, { error: "refused", code: "REFUSED" })),
      );
      await push.enqueuePreview(preview("page-a"));
      const result = await push.drain();
      expect(result).toMatchObject({ delivered: 0, dropped: 0, suppressed: 1, retained: 0 });
      expect(await push.getFailure()).toBeNull();
      expect(await push.previewWanted("page-a", "hash-1")).toBe(true);
    },
  );

  it.each([500, 503])(
    "a %i on a screenshot never holds back the pages behind it, and is given up after a few tries",
    async (status) => {
      const store = new MemoryStore();
      let now = 1_000_000;
      const fetch = new FakeFetch((req) =>
        req.url.includes("/documents/preview")
          ? jsonResponse(status, { error: "the preview store failed" })
          : jsonResponse(200, { ingested: 1 }),
      );
      const push = new PushClient({
        gatewayUrl: GATEWAY,
        token: TOKEN,
        fetch: fetch.fetch,
        store,
        batchSize: 1,
        now: () => now,
      });
      const first = await pageDoc("https://news.example.com/a");
      await push.enqueueDocument(first);
      await push.enqueuePreview(preview(first.externalId));
      await push.enqueueDocument(await pageDoc("https://news.example.com/b"));
      await push.enqueueDocument(await pageDoc("https://news.example.com/c"));

      const delivered: number[] = [];
      for (let pass = 0; pass < 4; pass += 1) delivered.push((await push.drain()).delivered);
      expect(delivered).toEqual([1, 0, 1, 1]);
      const pages = fetch.requests.filter((r) => new URL(r.url).pathname === "/documents");
      expect(pages).toHaveLength(3);
      expect(await push.getRetry()).toBeNull();

      let previewTries = 1;
      for (let pass = 0; pass < 10; pass += 1) {
        now += 10 * 60 * 1000;
        const before = fetch.requests.length;
        const result = await push.drain();
        if (fetch.requests.length > before) previewTries += 1;
        if (result.retained === 0) break;
      }
      expect(previewTries).toBe(MAX_PREVIEW_ATTEMPTS);
      expect(await push.queueDepth()).toBe(0);
      expect(await push.getFailure()).toBeNull();
    },
  );

  it.each([429, 408])("a %i holds the queue back like any upload", async (status) => {
    const store = new MemoryStore();
    const push = client(store, new FakeFetch(() => jsonResponse(status, {})));
    await push.enqueuePreview(preview("page-a"));
    const result = await push.drain();
    expect(result.retained).toBe(1);
    expect(result.suppressed).toBe(0);
  });

  it("a revoked credential keeps the shot for after a re-pair", async () => {
    const store = new MemoryStore();
    const push = client(store, new FakeFetch(() => jsonResponse(401, { error: "revoked" })));
    await push.enqueuePreview(preview("page-a"));
    const result = await push.drain();
    expect(result.retained).toBe(1);
    expect(await push.getHealth()).toMatchObject({ ok: false });
  });

  it("are the first thing evicted when the local budget is reached, with no loss notice", async () => {
    const store = new MemoryStore();
    const queue = new PersistentQueue(store, undefined, { maxItems: 2, maxBytes: 1_000_000 });
    const doc = await pageDoc("https://news.example.com/a");
    const base = { attempts: 0, notBefore: 0, enqueuedAt: 0 };
    await queue.enqueue({ ...base, kind: "preview", id: "p1", preview: preview("page-a") });
    await queue.enqueue({ ...base, kind: "document", id: "d1", doc });
    await queue.enqueue({ ...base, kind: "document", id: "d2", doc });
    expect((await queue.list()).map((item) => item.id)).toEqual(["d1", "d2"]);
    expect(await store.get("omnesis.push.queueOverflow.v1")).toBeUndefined();
  });

  it("a queued shot survives a worker restart", async () => {
    const store = new MemoryStore();
    await client(store, new FakeFetch(() => jsonResponse(503, {}))).enqueuePreview(
      preview("page-a"),
    );
    const revived = new PersistentQueue(store);
    await revived.load();
    expect((await revived.list()).map((item) => item.kind)).toEqual(["preview"]);
  });
});
