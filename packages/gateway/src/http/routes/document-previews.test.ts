// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for document previews and their life beside their documents.
 *
 * A browser's `write:web` token uploads a page screenshot only while the
 * shared capture policy has screenshots on and still allows the page; a read
 * token gets the bytes back with their type, a private cache policy and an
 * ETag; documents carry a `preview` reference only when one exists; and every
 * way a page leaves the corpus takes its preview with it. All page data is
 * invented.
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  SourceType,
  writeScope,
  SourceId,
} from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { resetOwnedWebDomains } from "../../owned-web-domains.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { isSourceCleanupPending } from "../../data/repositories/SourceRepository.js";
import { DocumentPreviewStore, MAX_PREVIEW_BYTES } from "../../previews/store.js";
import type { Scope } from "@omnesis/types";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let previewPath: string;
let analyticsPath: string;
let analyticsDb: AnalyticsDb;
let store: DocumentPreviewStore;
let browserToken: string;
let readToken: string;
let adminToken: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(kind: "browser" | "cli", scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind });
  return createToken(db, dev.id, scopes).token;
}

function call(path: string, token: string | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function webp(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  for (let i = 12; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

function jpeg(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

function externalIdFor(url: string): string {
  return `id-${url}`;
}

async function pushPage(url: string) {
  const res = await call("/documents", browserToken, {
    method: "POST",
    body: JSON.stringify({
      documents: [
        {
          providerId: "web",
          sourceId: "web",
          externalId: externalIdFor(url),
          documentType: "webpage",
          title: `Page at ${url}`,
          content: "Invented readable text of a fictional page, long enough to keep.",
          contentHash: `hash-${url}`,
          metadata: { sourceUrl: url },
          sourceCreatedAt: "2026-01-15T10:00:00Z",
          sourceUpdatedAt: "2026-01-15T10:00:00Z",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

function documentIdFor(url: string): string {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalIdFor(url));
  if (!row) throw new Error(`no document for ${url}`);
  return row.id;
}

async function setScreenshots(enabled: boolean) {
  const res = await call("/web-capture-policy/screenshots", browserToken, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
  expect(res.status).toBe(200);
}

function uploadBody(url: string, image = webp(), overrides: Record<string, unknown> = {}) {
  return {
    providerId: "web",
    sourceId: "web",
    externalId: externalIdFor(url),
    contentType: "image/webp",
    width: 1280,
    height: 720,
    capturedAt: "2026-01-15T10:00:05.000Z",
    image: Buffer.from(image).toString("base64"),
    ...overrides,
  };
}

function upload(url: string, image = webp(), overrides: Record<string, unknown> = {}) {
  return call("/documents/preview", browserToken, {
    method: "PUT",
    body: JSON.stringify(uploadBody(url, image, overrides)),
  });
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-previews-test-${randomUUID()}.db`;
  previewPath = `/tmp/omnesis-previews-test-${randomUUID()}.previews.db`;
  analyticsPath = `/tmp/omnesis-previews-test-${randomUUID()}.duckdb`;
  db = createDatabase(dbPath);
  store = DocumentPreviewStore.open(previewPath, null);
  analyticsDb = new AnalyticsDb(analyticsPath);
  await analyticsDb.open();
  app = createServer(db, undefined, { analyticsDb, previewStore: store });
  resetOwnedWebDomains();
  browserToken = mintToken("browser", [writeScope(SourceType("web"))]);
  readToken = mintToken("cli", [SCOPE_READ]);
  adminToken = mintToken("cli", [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
});

afterEach(async () => {
  await analyticsDb.close();
  store.close();
  db.close();
  cleanupDb(dbPath);
  cleanupDb(previewPath);
  rmSync(analyticsPath, { force: true });
  rmSync(`${analyticsPath}.wal`, { force: true });
  resetOwnedWebDomains();
});

describe("PUT /documents/preview", () => {
  test("is refused while screenshots are off, and stored once they are on", async () => {
    await pushPage("https://news.example.com/story");
    const refused = await upload("https://news.example.com/story");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("SCREENSHOTS_DISABLED");
    expect(store.count()).toBe(0);

    await setScreenshots(true);
    const stored = await upload("https://news.example.com/story");
    expect(stored.status).toBe(200);
    const id = documentIdFor("https://news.example.com/story");
    expect(await stored.json()).toEqual({
      stored: true,
      preview: {
        url: `/documents/${id}/preview`,
        contentType: "image/webp",
        width: 1280,
        height: 720,
        capturedAt: "2026-01-15T10:00:05.000Z",
      },
    });
  });

  test("keeps one latest preview per document", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    expect((await upload("https://news.example.com/story", webp(64))).status).toBe(200);
    const replaced = await upload("https://news.example.com/story", jpeg(80), {
      contentType: "image/jpeg",
      width: 800,
      height: 600,
    });
    expect(replaced.status).toBe(200);
    expect(store.count()).toBe(1);
    const meta = store.describe(documentIdFor("https://news.example.com/story"));
    expect(meta).toMatchObject({ contentType: "image/jpeg", width: 800, byteLength: 80 });
  });

  test("refuses a page the policy no longer allows, an unknown page and one deleted for good", async () => {
    await setScreenshots(true);
    await pushPage("https://shop.example/item");
    await pushPage("https://news.example.com/gone");
    await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "shop.example" }),
    });
    const excluded = await upload("https://shop.example/item");
    expect(excluded.status).toBe(409);
    expect(((await excluded.json()) as { code: string }).code).toBe("PREVIEW_NOT_ALLOWED");

    const unknown = await upload("https://news.example.com/never-pushed");
    expect(unknown.status).toBe(404);

    const id = documentIdFor("https://news.example.com/gone");
    expect((await call(`/documents/${id}`, browserToken, { method: "DELETE" })).status).toBe(200);
    const suppressed = await upload("https://news.example.com/gone");
    expect(suppressed.status).toBe(410);
    expect(store.count()).toBe(0);
  });

  test("refuses a paused capture", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    await call("/web-capture-policy/pause", browserToken, {
      method: "PUT",
      body: JSON.stringify({ until: null }),
    });
    const res = await upload("https://news.example.com/story");
    expect(res.status).toBe(409);
  });

  test("refuses an image of another type, a mislabelled one, an oversize one and bad dimensions", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    const png = await upload("https://news.example.com/story", webp(), {
      contentType: "image/png",
    });
    expect(png.status).toBe(415);
    const mislabelled = await upload("https://news.example.com/story", jpeg(), {
      contentType: "image/webp",
    });
    expect(mislabelled.status).toBe(415);
    const big = await upload("https://news.example.com/story", webp(MAX_PREVIEW_BYTES + 1));
    expect([400, 413]).toContain(big.status);
    const wide = await upload("https://news.example.com/story", webp(), { width: 0 });
    expect(wide.status).toBe(400);
    expect(store.count()).toBe(0);
  });

  test("refuses a read token and a writer for another source", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    const otherWriter = mintToken("cli", [writeScope(SourceType("gmail"))]);
    for (const token of [readToken, otherWriter]) {
      const res = await call("/documents/preview", token, {
        method: "PUT",
        body: JSON.stringify(uploadBody("https://news.example.com/story")),
      });
      expect(res.status).toBe(403);
    }
    expect((await call("/documents/preview", null, { method: "PUT", body: "{}" })).status).toBe(
      401,
    );
  });

  test("refuses a source that keeps no previews", async () => {
    const res = await call("/documents/preview", adminToken, {
      method: "PUT",
      body: JSON.stringify(
        uploadBody("https://news.example.com/story", webp(), { sourceId: "gmail:a@example.com" }),
      ),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PREVIEWS_NOT_ACCEPTED");
  });

  test("accepts the same upload as multipart form data", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    const form = new FormData();
    const {
      image: _image,
      contentType: _type,
      ...fields
    } = uploadBody("https://news.example.com/story");
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
    form.set("image", new Blob([jpeg()], { type: "image/jpeg" }), "shot.jpg");
    const res = await app.request("/documents/preview", {
      method: "PUT",
      headers: { Authorization: `Bearer ${browserToken}` },
      body: form,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(store.describe(documentIdFor("https://news.example.com/story"))?.contentType).toBe(
      "image/jpeg",
    );
  });
});

describe("GET /documents/:id/preview", () => {
  test("serves the bytes with their type, a private cache policy and an ETag", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/story");
    const image = webp(96);
    await upload("https://news.example.com/story", image);
    const id = documentIdFor("https://news.example.com/story");

    const res = await call(`/documents/${id}/preview`, readToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(image);

    const again = await call(`/documents/${id}/preview`, readToken, {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
  });

  test("is 404 for a document without a preview and for no document", async () => {
    await pushPage("https://news.example.com/story");
    const id = documentIdFor("https://news.example.com/story");
    expect((await call(`/documents/${id}/preview`, readToken)).status).toBe(404);
    expect((await call(`/documents/${randomUUID()}/preview`, readToken)).status).toBe(404);
    expect((await call(`/documents/${id}/preview`, null)).status).toBe(401);
  });
});

describe("the document's preview reference", () => {
  test("GET /documents/:id and the source's recent list carry it only when one exists", async () => {
    await setScreenshots(true);
    await pushPage("https://news.example.com/with");
    await pushPage("https://news.example.com/without");
    await upload("https://news.example.com/with");
    const withId = documentIdFor("https://news.example.com/with");
    const withoutId = documentIdFor("https://news.example.com/without");

    const shown = (await (await call(`/documents/${withId}`, readToken)).json()) as {
      preview?: { url: string };
    };
    expect(shown.preview?.url).toBe(`/documents/${withId}/preview`);
    const bare = (await (await call(`/documents/${withoutId}`, readToken)).json()) as object;
    expect(bare).not.toHaveProperty("preview");

    const recent = (await (await call("/sources/web/recent?limit=10", readToken)).json()) as {
      documents: Array<{ id: string; preview?: unknown }>;
    };
    expect(recent.documents.find((d) => d.id === withId)?.preview).toBeDefined();
    expect(recent.documents.find((d) => d.id === withoutId)).not.toHaveProperty("preview");
  });
});

describe("a preview leaves with its document", () => {
  async function pageWithPreview(url: string): Promise<string> {
    await pushPage(url);
    expect((await upload(url)).status).toBe(200);
    return documentIdFor(url);
  }

  beforeEach(async () => {
    await setScreenshots(true);
  });

  test("on a copy-only delete and on a delete for good", async () => {
    const copy = await pageWithPreview("https://news.example.com/copy");
    const forGood = await pageWithPreview("https://news.example.com/good");
    await call(`/documents/${copy}?tombstone=0`, browserToken, { method: "DELETE" });
    await call(`/documents/${forGood}`, browserToken, { method: "DELETE" });
    expect(store.describe(copy)).toBeNull();
    expect(store.describe(forGood)).toBeNull();
  });

  test("on an excluded domain with purge, leaving other domains' previews", async () => {
    const purged = await pageWithPreview("https://shop.example/item");
    const kept = await pageWithPreview("https://news.example.com/story");
    const res = await call("/web-capture-policy/excluded-domains", browserToken, {
      method: "POST",
      body: JSON.stringify({ domain: "shop.example", purge: true }),
    });
    expect(res.status).toBe(200);
    expect(store.describe(purged)).toBeNull();
    expect(store.describe(kept)).not.toBeNull();
  });

  test("on a whole-source delete", async () => {
    const id = await pageWithPreview("https://news.example.com/story");
    const res = await call("/documents/delete-all/source/web", adminToken, { method: "POST" });
    expect(res.status).toBe(200);
    expect(store.describe(id)).toBeNull();
    expect(store.count()).toBe(0);
  });

  test("on removing the source, through its post-removal sweep", async () => {
    const id = await pageWithPreview("https://news.example.com/story");
    const res = await call("/admin/sources/web", adminToken, { method: "DELETE" });
    expect(res.status, await res.clone().text()).toBe(200);
    const deadline = Date.now() + 10_000;
    while (
      (store.describe(id) !== null || isSourceCleanupPending(db, SourceId("web"))) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(store.describe(id)).toBeNull();
  });

  test("on a pushed tombstone", async () => {
    const id = await pageWithPreview("https://news.example.com/story");
    const res = await call("/documents/delete", browserToken, {
      method: "POST",
      body: JSON.stringify({
        providerId: "web",
        sourceId: "web",
        externalIds: [externalIdFor("https://news.example.com/story")],
      }),
    });
    expect(res.status).toBe(200);
    expect(store.describe(id)).toBeNull();
  });
});
