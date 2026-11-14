// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Export worker — serializes the documents table to a portable
 * JSONL or CSV file entirely off the gateway main thread. better-sqlite3
 * is synchronous, so walking a 100k-doc corpus on the main thread would
 * park the HTTP path for the whole run; hosting it here keeps the gateway
 * responsive while an export streams.
 *
 * One-shot: the job arrives via `workerData` (`ExportWorkerInput`),
 * progress streams back as `progress` messages, and the worker exits after
 * posting `done` (or `error`). Protocol types live in `export-protocol.ts`.
 *
 * Memory stays flat regardless of corpus size: documents are read in
 * `batchSize` keyset pages (`WHERE id > ? ORDER BY id ASC LIMIT ?`) and
 * each page is written to a `WriteStream` with backpressure honored before
 * the next page is fetched. No full result set is ever materialized.
 *
 * The source database is opened read-only, so the writer worker's
 * concurrent commits never block the export and the export never mutates
 * the live store.
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
type Db = Database.Database;

import { openEncryptedSqlite } from "../sqlite-encryption.js";
import type { ExportWorkerInput, ExportWorkerMessage } from "./export-protocol.js";

if (!parentPort) {
  throw new Error("export-worker must be run as a Node worker_thread");
}

function post(msg: ExportWorkerMessage): void {
  parentPort!.postMessage(msg);
}

/** One row as read from the documents table. */
interface DocRow {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  content: string;
  source_url: string | null;
  source_created_at: string;
  source_updated_at: string;
  updated_at: string;
  metadata: string;
}

/** RFC 4180 field escaping: wrap in quotes and double embedded quotes when
 * the value contains a comma, quote, CR, or LF; pass simple values through. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Header + per-row column subset for the documents CSV. The full `content`
 * blob is deliberately omitted — see ExportService docs / the doc page. */
const CSV_COLUMNS = [
  "id",
  "sourceId",
  "externalId",
  "title",
  "sourceUrl",
  "sourceCreatedAt",
  "sourceUpdatedAt",
  "updatedAt",
] as const;

function csvRow(row: DocRow): string {
  const cells = [
    row.id,
    row.source_id,
    row.external_id,
    row.title,
    row.source_url ?? "",
    row.source_created_at,
    row.source_updated_at,
    row.updated_at,
  ];
  return cells.map(csvField).join(",") + "\n";
}

/** One JSONL line: the full document, including the content blob and parsed
 * metadata object. `metadata` is stored as a JSON string; parse it so the
 * line is a single well-formed object rather than a string-in-a-string. */
function jsonlLine(row: DocRow): string {
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    // Corrupt metadata blob — preserve the raw string rather than drop it.
    metadata = row.metadata;
  }
  return (
    JSON.stringify({
      id: row.id,
      sourceId: row.source_id,
      externalId: row.external_id,
      title: row.title,
      content: row.content,
      sourceUrl: row.source_url,
      sourceCreatedAt: row.source_created_at,
      sourceUpdatedAt: row.source_updated_at,
      updatedAt: row.updated_at,
      metadata,
    }) + "\n"
  );
}

/** Write a chunk, awaiting the drain event when the stream is backed up so
 * a fast producer can't outrun a slow disk and balloon the buffer. */
async function write(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function run(input: ExportWorkerInput): Promise<void> {
  const db: Db = input.gatewayDbKeyHex
    ? (openEncryptedSqlite(input.gatewayDbPath, {
        key: Buffer.from(input.gatewayDbKeyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(input.gatewayDbPath, { readonly: true, fileMustExist: true });
  db.exec("PRAGMA busy_timeout = 30000");

  const conditions: string[] = ["id > ?"];
  const baseParams: string[] = [];
  if (input.sourceId) {
    conditions.push("source_id = ?");
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const sql =
    `SELECT id, source_id, external_id, title, content, ` +
    `json_extract(metadata, '$.sourceUrl') AS source_url, ` +
    `source_created_at, source_updated_at, updated_at, metadata ` +
    `FROM documents ${where} ORDER BY id ASC LIMIT ?`;
  const stmt = db.prepare<(string | number)[], DocRow>(sql);

  const stream = createWriteStream(input.destPath, { encoding: "utf8" });
  const perSource: Record<string, number> = {};
  let total = 0;

  try {
    if (input.format === "csv") {
      await write(stream, CSV_COLUMNS.join(",") + "\n");
    }

    let afterId = "";
    for (;;) {
      const params: (string | number)[] = [afterId, ...baseParams];
      if (input.sourceId) params.push(input.sourceId);
      params.push(input.batchSize);
      const rows = stmt.all(...params);
      if (rows.length === 0) break;

      let chunk = "";
      for (const row of rows) {
        chunk += input.format === "csv" ? csvRow(row) : jsonlLine(row);
        perSource[row.source_id] = (perSource[row.source_id] ?? 0) + 1;
      }
      await write(stream, chunk);

      total += rows.length;
      afterId = rows[rows.length - 1].id;
      post({ type: "progress", documents: total });

      if (rows.length < input.batchSize) break;
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } finally {
    db.close();
  }

  const previewFiles = input.previewDbPath ? exportPreviews(input) : [];

  const { statSync } = await import("node:fs");
  post({
    type: "done",
    documents: total,
    bytes: statSync(input.destPath).size,
    perSource,
    previewFiles,
  });
}

interface PreviewRow {
  document_id: string;
  source_id: string;
  content_type: string;
  width: number;
  height: number;
  captured_at: string;
  image: Buffer;
}

/** Previews ride in the export as files, one per document, with a JSONL index. */
const PREVIEWS_INDEX = "previews.jsonl";
const PREVIEWS_DIR = "previews";

/**
 * Write the previews of the exported documents: one image file per document
 * under `previews/`, named by the document id, and one `previews.jsonl` line
 * per file saying which document it belongs to and what it is. A preview
 * whose document is gone is left out.
 */
function exportPreviews(input: ExportWorkerInput): string[] {
  const path = input.previewDbPath!;
  if (!existsSync(path)) return [];
  const previews: Db = input.previewDbKeyHex
    ? (openEncryptedSqlite(path, {
        key: Buffer.from(input.previewDbKeyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { readonly: true, fileMustExist: true });
  const documents: Db = input.gatewayDbKeyHex
    ? (openEncryptedSqlite(input.gatewayDbPath, {
        key: Buffer.from(input.gatewayDbKeyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(input.gatewayDbPath, { readonly: true, fileMustExist: true });
  const exportDir = dirname(input.destPath);
  const files: string[] = [];
  const index: string[] = [];
  try {
    previews.exec("PRAGMA busy_timeout = 30000");
    documents.exec("PRAGMA busy_timeout = 30000");
    const page = previews.prepare<(string | number)[], PreviewRow>(
      `SELECT document_id, source_id, content_type, width, height, captured_at, image
         FROM document_previews
        WHERE document_id > ?${input.sourceId ? " AND source_id = ?" : ""}
        ORDER BY document_id LIMIT ?`,
    );
    const exists = documents.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM documents WHERE id = ?",
    );
    let after = "";
    for (;;) {
      const rows = page.all(...(input.sourceId ? [after, input.sourceId, 100] : [after, 100]));
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!exists.get(row.document_id)) continue;
        const extension = row.content_type === "image/jpeg" ? "jpg" : "webp";
        const file = `${PREVIEWS_DIR}/${row.document_id}.${extension}`;
        mkdirSync(join(exportDir, PREVIEWS_DIR), { recursive: true });
        writeFileSync(join(exportDir, file), row.image);
        files.push(file);
        index.push(
          JSON.stringify({
            documentId: row.document_id,
            sourceId: row.source_id,
            file,
            contentType: row.content_type,
            width: row.width,
            height: row.height,
            capturedAt: row.captured_at,
          }),
        );
      }
      after = rows[rows.length - 1].document_id;
      if (rows.length < 100) break;
    }
  } finally {
    previews.close();
    documents.close();
  }
  if (files.length === 0) return [];
  writeFileSync(join(exportDir, PREVIEWS_INDEX), `${index.join("\n")}\n`);
  return [PREVIEWS_INDEX, ...files];
}

run(workerData as ExportWorkerInput).catch((err) => {
  post({
    type: "error",
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
});
