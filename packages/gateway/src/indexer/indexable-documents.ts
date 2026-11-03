// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which gateway documents the indexer is expected to index.
 *
 * A source's retention cutoff (`maxAge`) keeps documents already stored from
 * before it, but the indexer skips them. Every figure that compares the
 * gateway against the index — the `reindexMissing` gap, the `/status` backlog,
 * the `/index/stats` denominators and the doctor's backlog check — has to
 * count the same population the skip leaves in, or the skipped documents read
 * as a backlog that can never drain. This module is that population, as one
 * predicate in two forms: `isBeforeCutoff` for a document in hand and the
 * queries below for documents in `omnesis.db`.
 *
 * Nothing is recorded about a skipped document. The cutoff is resolved again
 * on every call, so widening or lifting it brings the older documents back
 * into scope on the next pass with nothing to undo.
 *
 * Each query reads through `idx_documents_source_id_created_at` (the window
 * arm) or the partial `idx_documents_contact_type` (the exempt arm), pinned
 * with `INDEXED BY` so losing either index is an error rather than a scan of
 * every document's metadata.
 */

import { DOCUMENT_ID_PAGE_ROWS } from "../data/repositories/DocumentRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The ISO cutoff for a source's documents, or null when none applies. */
export type SourceCutoffResolver = (sourceId: string) => string | null;

/**
 * The document type the retention cutoff does not apply to. The gateway
 * boundary already refuses to drop contacts on ingest
 * (`DocumentService.applyMaxAgeCutoff` — a contact stays relevant however old
 * the record is), so a cutoff applied here would keep them retained and
 * permanently unsearchable. The partial index `idx_documents_contact_type`
 * is declared on the same literal.
 */
export const CUTOFF_EXEMPT_DOCUMENT_TYPE = "contact";

const EXEMPT_PREDICATE = `json_extract(metadata, '$.documentType') = '${CUTOFF_EXEMPT_DOCUMENT_TYPE}'`;

/** Whether the retention cutoff keeps a document out of the index. */
export function isBeforeCutoff(
  cutoff: string | null,
  sourceCreatedAt: string,
  documentType: string | null | undefined,
): boolean {
  return (
    cutoff !== null && sourceCreatedAt < cutoff && documentType !== CUTOFF_EXEMPT_DOCUMENT_TYPE
  );
}

/**
 * Every distinct `source_id` in `documents`, read as a skip-scan: one index
 * seek per source rather than a walk of every document's index entry.
 */
export function listDocumentSourceIds(db: Db): string[] {
  return db
    .prepare<[], string>(
      `WITH RECURSIVE sources(source_id) AS (
         SELECT (SELECT MIN(source_id) FROM documents INDEXED BY idx_documents_source_id)
         UNION ALL
         SELECT (SELECT MIN(source_id) FROM documents INDEXED BY idx_documents_source_id
                  WHERE source_id > sources.source_id)
           FROM sources
          WHERE sources.source_id IS NOT NULL
       )
       SELECT source_id FROM sources WHERE source_id IS NOT NULL`,
    )
    .pluck()
    .all();
}

/**
 * Ids of `sourceId`'s documents the indexer is expected to index: everything
 * created at or after `cutoff`, plus exempt documents from before it. A null
 * cutoff means every document of the source.
 *
 * The window arm is read by keyset on `(source_created_at, id)`, `pageRows`
 * per statement, so a large source does not hold one WAL snapshot open (see
 * `docs/conventions.md`, "A long read holds the WAL open"). Each id is read as
 * of its own page, which the caller tolerates for the reason
 * `listDocumentIds`' callers do: a document written or re-dated while this
 * runs is seen by the next pass.
 */
export function listIndexableDocumentIdsForSource(
  db: Db,
  sourceId: string,
  cutoff: string | null,
  pageRows: number = DOCUMENT_ID_PAGE_ROWS,
): string[] {
  const limit = Math.max(1, Math.floor(pageRows));
  const first = db.prepare<[string, string, number], { id: string; created: string }>(
    `SELECT id, source_created_at AS created
       FROM documents INDEXED BY idx_documents_source_id_created_at
      WHERE source_id = ? AND source_created_at >= ?
      ORDER BY source_created_at, id
      LIMIT ?`,
  );
  const next = db.prepare<
    [string, string, string, string, number],
    { id: string; created: string }
  >(
    `SELECT id, source_created_at AS created
       FROM documents INDEXED BY idx_documents_source_id_created_at
      WHERE source_id = ? AND source_created_at >= ?
        AND NOT (source_created_at = ? AND id <= ?)
      ORDER BY source_created_at, id
      LIMIT ?`,
  );
  const ids: string[] = [];
  let rows = first.all(sourceId, cutoff ?? "", limit);
  for (;;) {
    for (const row of rows) ids.push(row.id);
    if (rows.length < limit) break;
    const last = rows[rows.length - 1]!;
    rows = next.all(sourceId, last.created, last.created, last.id, limit);
  }
  if (cutoff !== null) {
    const exempt = db
      .prepare<[string, string], string>(
        `SELECT id FROM documents INDEXED BY idx_documents_contact_type
          WHERE ${EXEMPT_PREDICATE} AND source_id = ? AND source_created_at < ?`,
      )
      .pluck()
      .all(sourceId, cutoff);
    for (const id of exempt) ids.push(id);
  }
  return ids;
}

/** Ids of every document the indexer is expected to index, across all sources. */
export function listIndexableDocumentIds(
  db: Db,
  cutoffFor: SourceCutoffResolver,
  pageRows: number = DOCUMENT_ID_PAGE_ROWS,
): string[] {
  const ids: string[] = [];
  for (const sourceId of listDocumentSourceIds(db)) {
    for (const id of listIndexableDocumentIdsForSource(
      db,
      sourceId,
      cutoffFor(sourceId),
      pageRows,
    )) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * How many of `sourceId`'s documents the indexer is expected to index under
 * `cutoff` — the count of `listIndexableDocumentIdsForSource`. A null cutoff
 * counts every document of the source.
 */
export function countIndexableDocumentsForSource(
  db: Db,
  sourceId: string,
  cutoff: string | null,
): number {
  const inWindow =
    db
      .prepare<[string, string], number>(
        `SELECT COUNT(*) FROM documents INDEXED BY idx_documents_source_id_created_at
          WHERE source_id = ? AND source_created_at >= ?`,
      )
      .pluck()
      .get(sourceId, cutoff ?? "") ?? 0;
  if (cutoff === null) return inWindow;
  const exempt =
    db
      .prepare<[string, string], number>(
        `SELECT COUNT(*) FROM documents INDEXED BY idx_documents_contact_type
          WHERE ${EXEMPT_PREDICATE} AND source_id = ? AND source_created_at < ?`,
      )
      .pluck()
      .get(sourceId, cutoff) ?? 0;
  return inWindow + exempt;
}

/** How many documents the indexer is expected to index, across all sources. */
export function countIndexableDocuments(db: Db, cutoffFor: SourceCutoffResolver): number {
  let total = 0;
  for (const sourceId of listDocumentSourceIds(db)) {
    total += countIndexableDocumentsForSource(db, sourceId, cutoffFor(sourceId));
  }
  return total;
}

/**
 * Per-source indexable counts for callers that already hold each source's
 * full document count (`source_stats.doc_count`): a source with no cutoff
 * keeps that count, and only a source with one pays for the windowed count.
 */
export function indexableCountsBySource(
  db: Db,
  fullCounts: Readonly<Record<string, number>>,
  cutoffFor: SourceCutoffResolver,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sourceId, full] of Object.entries(fullCounts)) {
    const cutoff = cutoffFor(sourceId);
    counts[sourceId] =
      cutoff === null ? full : countIndexableDocumentsForSource(db, sourceId, cutoff);
  }
  return counts;
}
