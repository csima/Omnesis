// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The population the indexer is expected to index, read from `omnesis.db`:
 * the retention cutoff's skip expressed as queries, the counts that must
 * agree with them, and the plans that keep them off a full scan.
 *
 * Fixture data is invented per the repo's privacy rule.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, upsertDocuments } from "../db.js";
import {
  countIndexableDocuments,
  countIndexableDocumentsForSource,
  indexableCountsBySource,
  isBeforeCutoff,
  listDocumentSourceIds,
  listIndexableDocumentIds,
  listIndexableDocumentIdsForSource,
} from "./indexable-documents.js";
import type { DocumentInput } from "@omnesis/types";

const NOTES = "notes:maya@example.org";
const DRIVE = "drive:jamie@example.org";
const CUTOFF = "2024-06-01T00:00:00.000Z";

let directory: string;
let writer: Database.Database;
let reader: Database.Database;
let statements: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-indexable-"));
  const path = join(directory, "gateway.db");
  writer = createDatabase(path);
  statements = [];
  reader = new Database(path, { readonly: true });
  const prepare = reader.prepare.bind(reader);
  reader.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof reader.prepare;
  upsertDocuments(writer, [
    doc(NOTES, "recent-a", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-b", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-c", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-d", "2025-09-15T00:00:00.000Z"),
    doc(NOTES, "at-cutoff", CUTOFF),
    doc(NOTES, "old-1", "2021-03-01T00:00:00.000Z"),
    doc(NOTES, "old-2", "2019-11-20T00:00:00.000Z"),
    doc(NOTES, "old-contact", "2018-05-05T00:00:00.000Z", "contact"),
    doc(DRIVE, "drive-old", "2017-01-01T00:00:00.000Z"),
    doc(DRIVE, "drive-new", "2026-01-01T00:00:00.000Z"),
  ] as never);
});

afterEach(() => {
  reader.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

function doc(
  sourceId: string,
  externalId: string,
  createdAt: string,
  documentType = "note",
): DocumentInput {
  return {
    providerId: sourceId.split(":")[0] as DocumentInput["providerId"],
    sourceId: sourceId as DocumentInput["sourceId"],
    externalId,
    title: `Invented ${documentType} ${externalId}`,
    content: `Invented ${documentType} ${externalId} about a Q4 budget review.`,
    contentHash: `hash-${externalId}`,
    metadata: { documentType },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: createdAt,
  };
}

function externalIds(ids: readonly string[]): string[] {
  const lookup = writer.prepare<[string], string>("SELECT external_id FROM documents WHERE id = ?");
  return ids.map((id) => lookup.pluck().get(id)!).sort();
}

function plan(sql: string): string {
  const params = Array.from(sql.matchAll(/\?/g), () => "2024-01-01T00:00:00.000Z");
  return writer
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
}

describe("the indexable population", () => {
  test("a cutoff leaves older documents out and keeps in-window ones and exempt contacts", () => {
    const ids = listIndexableDocumentIdsForSource(reader, NOTES, CUTOFF);
    expect(externalIds(ids)).toEqual([
      "at-cutoff",
      "old-contact",
      "recent-a",
      "recent-b",
      "recent-c",
      "recent-d",
    ]);
    expect(countIndexableDocumentsForSource(reader, NOTES, CUTOFF)).toBe(ids.length);
  });

  test("no cutoff means every document of the source", () => {
    expect(listIndexableDocumentIdsForSource(reader, NOTES, null)).toHaveLength(8);
    expect(countIndexableDocumentsForSource(reader, NOTES, null)).toBe(8);
  });

  test("widening the cutoff brings older documents back without anything to undo", () => {
    const widened = "2020-01-01T00:00:00.000Z";
    expect(externalIds(listIndexableDocumentIdsForSource(reader, NOTES, widened))).toContain(
      "old-1",
    );
    expect(externalIds(listIndexableDocumentIdsForSource(reader, NOTES, widened))).not.toContain(
      "old-2",
    );
    expect(countIndexableDocumentsForSource(reader, NOTES, widened)).toBe(7);
  });

  test("paging by keyset returns the single-statement set, ties on the date included", () => {
    const whole = listIndexableDocumentIdsForSource(reader, NOTES, CUTOFF);
    for (const pageRows of [1, 2, 3]) {
      const paged = listIndexableDocumentIdsForSource(reader, NOTES, CUTOFF, pageRows);
      expect(new Set(paged).size).toBe(paged.length);
      expect([...paged].sort()).toEqual([...whole].sort());
    }
  });

  test("the cutoff resolves per source across the corpus, and the count agrees with the list", () => {
    const cutoffFor = (sourceId: string) => (sourceId === NOTES ? CUTOFF : null);
    expect(listDocumentSourceIds(reader).sort()).toEqual([DRIVE, NOTES].sort());
    const ids = listIndexableDocumentIds(reader, cutoffFor);
    expect(externalIds(ids)).toContain("drive-old");
    expect(externalIds(ids)).not.toContain("old-1");
    expect(ids).toHaveLength(8);
    expect(countIndexableDocuments(reader, cutoffFor)).toBe(8);
    expect(indexableCountsBySource(reader, { [NOTES]: 8, [DRIVE]: 2 }, cutoffFor)).toEqual({
      [NOTES]: 6,
      [DRIVE]: 2,
    });
  });

  test("the in-memory skip and the queries draw the same line", () => {
    const rows = writer
      .prepare<[], { id: string; source_id: string; created: string; type: string }>(
        "SELECT id, source_id, source_created_at AS created, json_extract(metadata, '$.documentType') AS type FROM documents",
      )
      .all();
    const kept = rows
      .filter((row) => !isBeforeCutoff(CUTOFF, row.created, row.type))
      .map((row) => row.id);
    const cutoffFor = () => CUTOFF;
    expect([...listIndexableDocumentIds(reader, cutoffFor)].sort()).toEqual(kept.sort());
  });

  test("every statement reads through an index, never a scan of documents", () => {
    const cutoffFor = (sourceId: string) => (sourceId === NOTES ? CUTOFF : null);
    listIndexableDocumentIds(reader, cutoffFor, 2);
    countIndexableDocuments(reader, cutoffFor);
    const distinct = [...new Set(statements)];
    expect(distinct.length).toBeGreaterThanOrEqual(5);
    for (const sql of distinct) {
      const detail = plan(sql);
      expect(detail, sql).not.toMatch(/SCAN documents/);
      expect(detail, sql).toMatch(
        /SEARCH documents USING (COVERING )?INDEX idx_documents_(source_id|source_id_created_at|contact_type)\b/,
      );
    }
    const windowPage = distinct.find((sql) => sql.includes("NOT (source_created_at = ?"))!;
    expect(plan(windowPage)).toContain(
      "SEARCH documents USING INDEX idx_documents_source_id_created_at (source_id=? AND source_created_at>?)",
    );
  });
});
