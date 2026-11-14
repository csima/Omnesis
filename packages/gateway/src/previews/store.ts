// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The document preview store — one image per document, in its own database
 * beside the document store.
 *
 * Separate on purpose. A preview is a few hundred kilobytes where a document
 * row is a few, and every write to `omnesis.db` goes through one writer
 * thread: a page screenshot written there would hold every other write on the
 * gateway for the length of its blob. Here it is one row on its own
 * connection, so an upload costs the writer nothing, and a document read that
 * wants to know whether a preview exists selects only the small columns ahead
 * of the image and never pulls its overflow pages.
 *
 * The document store is the authority. A preview names its document by id and
 * lives exactly as long as it: every path that deletes documents removes their
 * previews through {@link DocumentPreviewStore.deleteForDocuments}, a read
 * serves a preview only while its document is still readable, and the orphan
 * sweep (`orphan-sweep.ts`) removes any a crash left behind.
 *
 * The file is keyed with its own storage key when the install has live
 * storage encryption armed: a screenshot of a page is corpus material, and is
 * not redacted the way captured text is.
 *
 * Its schema is numbered in its own `user_version`, independent of the main
 * store's migration chain. A file stamped by a newer build is refused rather
 * than guessed at; the gateway then runs without previews.
 */

import { createHash } from "node:crypto";
import { PREVIEW_STORE_SCHEMA_VERSION } from "@omnesis/core";
import { openEncryptedSqlite, type EncryptedSqliteDatabase } from "../sqlite-encryption.js";

/** Image types a preview may carry. */
export const PREVIEW_CONTENT_TYPES = ["image/webp", "image/jpeg"] as const;
export type PreviewContentType = (typeof PREVIEW_CONTENT_TYPES)[number];

/** Largest image a preview may carry, in bytes. */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** Largest side of a preview image, in pixels. */
export const MAX_PREVIEW_DIMENSION = 4096;

/** Rows a delete removes per statement before it yields to the event loop. */
const DELETE_BATCH = 200;

/** What a reader learns about a stored preview without its bytes. */
export interface StoredPreviewMeta {
  documentId: string;
  sourceId: string;
  contentType: PreviewContentType;
  width: number;
  height: number;
  capturedAt: string;
  byteLength: number;
  etag: string;
}

/** The `preview` field documents carry on the wire. */
export interface DocumentPreviewRef {
  url: string;
  contentType: PreviewContentType;
  width: number;
  height: number;
  capturedAt: string;
}

export interface PutPreviewInput {
  documentId: string;
  sourceId: string;
  contentType: PreviewContentType;
  width: number;
  height: number;
  capturedAt: string;
  bytes: Uint8Array;
}

interface MetaRow {
  document_id: string;
  source_id: string;
  content_type: string;
  width: number;
  height: number;
  captured_at: string;
  byte_length: number;
  etag: string;
}

const META_COLUMNS =
  "document_id, source_id, content_type, width, height, captured_at, byte_length, etag";

/** The wire reference for a stored preview. */
export function previewRef(meta: StoredPreviewMeta): DocumentPreviewRef {
  return {
    url: `/documents/${encodeURIComponent(meta.documentId)}/preview`,
    contentType: meta.contentType,
    width: meta.width,
    height: meta.height,
    capturedAt: meta.capturedAt,
  };
}

export class PreviewStoreVersionError extends Error {
  constructor(path: string, found: number) {
    super(
      `Preview store at ${path} has schema ${found}, newer than this build's ${PREVIEW_STORE_SCHEMA_VERSION}`,
    );
    this.name = "PreviewStoreVersionError";
  }
}

export class DocumentPreviewStore {
  private constructor(private readonly db: EncryptedSqliteDatabase) {}

  static open(path: string, key: Buffer | null): DocumentPreviewStore {
    const db = openEncryptedSqlite(path, { key });
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("busy_timeout = 5000");
      migrate(db, path);
    } catch (error) {
      db.close();
      throw error;
    }
    return new DocumentPreviewStore(db);
  }

  /** Store `input` as its document's preview, replacing any earlier one. */
  put(input: PutPreviewInput): StoredPreviewMeta {
    const etag = `"${createHash("sha256").update(input.bytes).digest("hex").slice(0, 32)}"`;
    this.db
      .prepare(
        `INSERT INTO document_previews
           (document_id, source_id, content_type, width, height, captured_at,
            byte_length, etag, stored_at, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           source_id = excluded.source_id,
           content_type = excluded.content_type,
           width = excluded.width,
           height = excluded.height,
           captured_at = excluded.captured_at,
           byte_length = excluded.byte_length,
           etag = excluded.etag,
           stored_at = excluded.stored_at,
           image = excluded.image`,
      )
      .run(
        input.documentId,
        input.sourceId,
        input.contentType,
        input.width,
        input.height,
        input.capturedAt,
        input.bytes.byteLength,
        etag,
        new Date().toISOString(),
        Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      );
    return {
      documentId: input.documentId,
      sourceId: input.sourceId,
      contentType: input.contentType,
      width: input.width,
      height: input.height,
      capturedAt: input.capturedAt,
      byteLength: input.bytes.byteLength,
      etag,
    };
  }

  describe(documentId: string): StoredPreviewMeta | null {
    const row = this.db
      .prepare<[string], MetaRow>(
        `SELECT ${META_COLUMNS} FROM document_previews WHERE document_id = ?`,
      )
      .get(documentId);
    return row ? toMeta(row) : null;
  }

  /** The previews of `documentIds` that exist, keyed by document id. */
  describeMany(documentIds: readonly string[]): Map<string, StoredPreviewMeta> {
    const out = new Map<string, StoredPreviewMeta>();
    const unique = [...new Set(documentIds)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.db
        .prepare<string[], MetaRow>(
          `SELECT ${META_COLUMNS} FROM document_previews
            WHERE document_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk);
      for (const row of rows) out.set(row.document_id, toMeta(row));
    }
    return out;
  }

  read(documentId: string): { meta: StoredPreviewMeta; bytes: Buffer } | null {
    const row = this.db
      .prepare<[string], MetaRow & { image: Buffer }>(
        `SELECT ${META_COLUMNS}, image FROM document_previews WHERE document_id = ?`,
      )
      .get(documentId);
    return row ? { meta: toMeta(row), bytes: row.image } : null;
  }

  /**
   * Delete the previews of `documentIds`, a bounded batch per statement with a
   * yield between batches, so a source removal of many thousands of documents
   * never holds the event loop. Returns the number of previews removed.
   */
  async deleteForDocuments(documentIds: readonly string[]): Promise<number> {
    const unique = [...new Set(documentIds)];
    let removed = 0;
    for (let i = 0; i < unique.length; i += DELETE_BATCH) {
      const chunk = unique.slice(i, i + DELETE_BATCH);
      removed += this.db
        .prepare<string[]>(
          `DELETE FROM document_previews WHERE document_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .run(...chunk).changes;
      if (i + DELETE_BATCH < unique.length) await yieldToEventLoop();
    }
    return removed;
  }

  /** Document ids with a preview, in id order after `afterId`, for the orphan sweep. */
  listDocumentIds(afterId: string, limit: number): string[] {
    return this.db
      .prepare<[string, number], { document_id: string }>(
        `SELECT document_id FROM document_previews WHERE document_id > ?
          ORDER BY document_id LIMIT ?`,
      )
      .all(afterId, limit)
      .map((row) => row.document_id);
  }

  count(): number {
    return (
      this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_previews").get()?.n ??
      0
    );
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: EncryptedSqliteDatabase, path: string): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > PREVIEW_STORE_SCHEMA_VERSION) throw new PreviewStoreVersionError(path, version);
  if (version === PREVIEW_STORE_SCHEMA_VERSION) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_previews (
        document_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        etag TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        image BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_previews_source ON document_previews (source_id);
    `);
    db.pragma(`user_version = ${PREVIEW_STORE_SCHEMA_VERSION}`);
  })();
}

function toMeta(row: MetaRow): StoredPreviewMeta {
  return {
    documentId: row.document_id,
    sourceId: row.source_id,
    contentType: row.content_type as PreviewContentType,
    width: row.width,
    height: row.height,
    capturedAt: row.captured_at,
    byteLength: row.byte_length,
    etag: row.etag,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
