// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, normalizeUrl } from "@omnesis/core";
import { redactSecrets } from "@omnesis/provider-web/redact-secrets";
import { documentsMetadataCodec } from "../../data/json-columns.js";
import { WEB_PROVIDER_ID } from "../../web-dataset.js";
import { isWebSourceId, redactWebDocument } from "./ingest.js";
import type { DocumentInput } from "@omnesis/types";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { Db } from "../../data/types.js";

const log = createLogger("gateway").child("web-backfill");

/** Rows read per page; each page is one bounded read and its handful of updates. */
const PAGE_SIZE = 200;

interface StoredPage {
  id: string;
  source_id: string;
  external_id: string;
  stream_id: string;
  title: string;
  content: string;
  content_hash: string;
  metadata: string;
}

/**
 * Re-redact every web page already stored, once, with the rules ingest now
 * applies (migration 207). Pages captured before redaction existed — or by a
 * browser whose extension did not redact — can hold credentials in their
 * title, text, address, tags or extra metadata.
 *
 * The scan walks each web source's documents through the
 * `(provider_id, source_id, external_id, stream_id)` index a page at a time,
 * and rewrites only a row whose redacted form differs. A rewritten row gets
 * the hash of its redacted text, a fresh `updated_at` so the indexer
 * re-embeds it, and the derived-state markers cleared that ingest clears on a
 * content change. Redaction is idempotent, so running this again finds
 * nothing to change.
 */
export function redactStoredWebPages(db: Db): number {
  const sources = db
    .prepare<[string], { source_id: string }>(
      "SELECT DISTINCT source_id FROM documents WHERE provider_id = ?",
    )
    .all(WEB_PROVIDER_ID)
    .map((row) => row.source_id)
    .filter((sourceId) => isWebSourceId(sourceId));
  const read = db.prepare<[string, string, string, string, string, number], StoredPage>(
    `SELECT id, source_id, external_id, stream_id, title, content, content_hash, metadata
       FROM documents
      WHERE provider_id = ? AND source_id = ?
        AND (external_id > ? OR (external_id = ? AND stream_id > ?))
      ORDER BY external_id, stream_id
      LIMIT ?`,
  );
  const write = db.prepare(
    `UPDATE documents
        SET title = ?, content = ?, content_hash = ?, metadata = ?, source_url = ?, updated_at = ?,
            links_extracted_at = NULL, people_resolved_at = NULL, dates_extracted_at = NULL,
            vocabulary_processed_at = NULL, vocabulary_revision = vocabulary_revision + 1
      WHERE id = ?`,
  );
  let changed = 0;
  for (const sourceId of sources) {
    let after = { externalId: "", streamId: "" };
    for (;;) {
      const rows = read.all(
        WEB_PROVIDER_ID,
        sourceId,
        after.externalId,
        after.externalId,
        after.streamId,
        PAGE_SIZE,
      );
      if (rows.length === 0) break;
      const now = new Date().toISOString();
      for (const row of rows) {
        const metadata = documentsMetadataCodec.parseWithFallback(row.metadata, {
          rowId: row.id,
        });
        const stored = {
          sourceId: row.source_id,
          title: row.title,
          content: row.content,
          contentHash: row.content_hash,
          metadata,
        } as unknown as DocumentInput;
        const redacted = redactWebDocument(stored);
        if (redacted === stored) continue;
        const sourceUrl =
          typeof redacted.metadata?.sourceUrl === "string"
            ? normalizeUrl(redacted.metadata.sourceUrl)
            : null;
        write.run(
          redacted.title,
          redacted.content,
          redacted.contentHash,
          documentsMetadataCodec.serialize(redacted.metadata as Record<string, unknown>),
          sourceUrl,
          now,
          row.id,
        );
        changed += 1;
      }
      const last = rows[rows.length - 1]!;
      after = { externalId: last.external_id, streamId: last.stream_id };
    }
  }
  if (changed > 0) log.info(`Redacted secrets from ${changed} stored web page(s)`);
  return changed;
}

/** The text columns of a web `page_visits` row the stored-visit pass rewrites. */
const VISIT_TEXT_COLUMNS = ["title", "browser_profile_label"];

/**
 * Re-redact the titles and browser labels of the web `page_visits` rows
 * already stored. Runs in the background after the analytics store opens, a
 * page of rows per write turn, rewriting only a row whose redacted form
 * differs; a table with nothing left to redact costs one read per page and no
 * write. The address is left as stored: it is part of the row's key, and
 * every address was normalized, credential parameters stripped, on capture.
 */
export async function redactStoredWebVisits(analyticsDb: AnalyticsDb): Promise<number> {
  const schema = await analyticsDb.getRecordTableSchema("page_visits");
  if (!schema || !isWebSourceId(schema.sourceId)) return 0;
  const present = new Set(schema.columns.map((column) => column.name));
  const columns = VISIT_TEXT_COLUMNS.filter((column) => present.has(column));
  if (columns.length === 0) return 0;
  const changed = await analyticsDb.rewriteTextColumns("page_visits", columns, redactSecrets);
  if (changed > 0) log.info(`Redacted secrets from ${changed} stored page visit(s)`);
  return changed;
}
