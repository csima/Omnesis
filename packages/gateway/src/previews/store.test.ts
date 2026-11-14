// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { PREVIEW_STORE_SCHEMA_VERSION } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { DocumentPreviewStore, PreviewStoreVersionError, previewRef } from "./store.js";
import { sweepOrphanPreviews } from "./orphan-sweep.js";

const paths: string[] = [];

function tempPath(suffix: string): string {
  const path = `/tmp/omnesis-preview-store-${randomUUID()}${suffix}`;
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const extra of ["", "-wal", "-shm", "-journal"])
      rmSync(`${path}${extra}`, { force: true });
  }
});

function image(fill: number, size = 32): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function put(store: DocumentPreviewStore, documentId: string, bytes = image(1)) {
  return store.put({
    documentId,
    sourceId: "web",
    contentType: "image/webp",
    width: 640,
    height: 360,
    capturedAt: "2026-02-01T08:00:00.000Z",
    bytes,
  });
}

describe("DocumentPreviewStore", () => {
  test("keeps one preview per document, replacing it and changing its ETag", () => {
    const store = DocumentPreviewStore.open(tempPath(".db"), null);
    const first = put(store, "doc-1", image(1));
    const second = put(store, "doc-1", image(2, 48));
    expect(store.count()).toBe(1);
    expect(second.etag).not.toBe(first.etag);
    const read = store.read("doc-1");
    expect(read?.meta).toEqual(second);
    expect(new Uint8Array(read!.bytes)).toEqual(image(2, 48));
    expect(previewRef(second)).toEqual({
      url: "/documents/doc-1/preview",
      contentType: "image/webp",
      width: 640,
      height: 360,
      capturedAt: "2026-02-01T08:00:00.000Z",
    });
    store.close();
  });

  test("describes many documents at once and deletes in bounded batches", async () => {
    const store = DocumentPreviewStore.open(tempPath(".db"), null);
    const ids = Array.from({ length: 450 }, (_, i) => `doc-${String(i).padStart(4, "0")}`);
    for (const id of ids) put(store, id);
    expect(store.describeMany([...ids.slice(0, 3), "missing"]).size).toBe(3);
    expect(await store.deleteForDocuments(ids.slice(0, 430))).toBe(430);
    expect(store.count()).toBe(20);
    expect(await store.deleteForDocuments(["missing"])).toBe(0);
    store.close();
  });

  test("stamps its schema and refuses a file from a newer build", () => {
    const path = tempPath(".db");
    DocumentPreviewStore.open(path, null).close();
    const raw = new Database(path);
    expect(raw.pragma("user_version", { simple: true })).toBe(PREVIEW_STORE_SCHEMA_VERSION);
    raw.pragma(`user_version = ${PREVIEW_STORE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => DocumentPreviewStore.open(path, null)).toThrow(PreviewStoreVersionError);
  });

  test("with a storage key, the file holds no plaintext header and no image bytes", () => {
    const path = tempPath(".db");
    const store = DocumentPreviewStore.open(path, randomBytes(32));
    const marker = new TextEncoder().encode("INVENTED-SCREENSHOT-MARKER".repeat(4));
    put(store, "doc-secret", marker);
    store.close();
    expect(existsSync(path)).toBe(true);
    const file = readFileSync(path);
    expect(file.subarray(0, 15).toString("utf8")).not.toBe("SQLite format 3");
    expect(file.includes(Buffer.from("INVENTED-SCREENSHOT-MARKER"))).toBe(false);
  });
});

describe("sweepOrphanPreviews", () => {
  test("removes previews whose document is gone and keeps the rest", async () => {
    const dbPath = tempPath(".main.db");
    const db = createDatabase(dbPath);
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'web', 'web', ?, 'Invented page', 'text', 'hash', '{}',
               '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run("kept-doc", "ext-kept");
    const store = DocumentPreviewStore.open(tempPath(".db"), null);
    put(store, "kept-doc");
    for (let i = 0; i < 1_100; i += 1) put(store, `orphan-${String(i).padStart(5, "0")}`);
    expect(await sweepOrphanPreviews(db, store)).toBe(1_100);
    expect(store.count()).toBe(1);
    expect(store.describe("kept-doc")).not.toBeNull();
    store.close();
    db.close();
  });
});
