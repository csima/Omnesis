// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, normalizeUrl } from "@omnesis/core";
import { redactShapedSecrets } from "@omnesis/provider-web/redact-secrets";
import { documentsMetadataCodec } from "../../data/json-columns.js";
import { createCanonicalizationStateTable } from "../../data/repositories/CanonicalizationStateRepository.js";
import { WEB_PROVIDER_ID } from "../../web-dataset.js";
import { isWebSourceId, redactWebDocument } from "./ingest.js";
import type { DocumentInput } from "@omnesis/types";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { Db } from "../../data/types.js";

const log = createLogger("gateway").child("web-backfill");

/**
 * The redaction rules stored web data was last brought up to. Bump it when
 * the shaped rules change and stored data should be redacted again.
 */
export const WEB_REDACTION_RULES_VERSION = "1";

/** `canonicalization_state` keys holding the rules version each store was redacted with. */
export const WEB_PAGES_REDACTION_KEY = "web_redaction_pages";
export const WEB_VISITS_REDACTION_KEY = "web_redaction_visits";

/** Documents read per planned page; each page is one bounded writer transaction. */
export const WEB_REDACTION_PAGE_SIZE = 50;

/**
 * Migration 207: record that stored web data is due a redaction pass. The
 * pass itself runs in the background after boot ({@link WebRedactionBackfill},
 * {@link redactStoredWebVisits}), so the boot transaction stays short.
 */
export function markWebRedactionDue(db: Db): void {
  createCanonicalizationStateTable(db);
  db.prepare("DELETE FROM canonicalization_state WHERE key IN (?, ?)").run(
    WEB_PAGES_REDACTION_KEY,
    WEB_VISITS_REDACTION_KEY,
  );
}

/** Whether `key`'s store has been redacted with the current rules. */
export function webRedactionIsCurrent(db: Db, key: string): boolean {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM canonicalization_state WHERE key = ?")
    .get(key);
  return row?.value === WEB_REDACTION_RULES_VERSION;
}

/** Record that `key`'s store has been redacted with the current rules. */
export function markWebRedactionCurrent(db: Db, key: string): void {
  db.prepare(
    `INSERT INTO canonicalization_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, WEB_REDACTION_RULES_VERSION, new Date().toISOString());
}

/** Where a pass over the web documents has reached, in index order. */
export interface WebRedactionCursor {
  sourceId: string;
  externalId: string;
  streamId: string;
  scanned: number;
}

/** One stored web page to rewrite, with the `updated_at` it was read at. */
export interface WebRedactionMutation {
  id: string;
  expectedUpdatedAt: string;
  title: string;
  content: string;
  contentHash: string;
  metadata: string;
  sourceUrl: string | null;
}

export interface WebRedactionPlan {
  cursor: WebRedactionCursor;
  mutations: WebRedactionMutation[];
  done: boolean;
}

interface StoredPage {
  id: string;
  source_id: string;
  external_id: string;
  stream_id: string;
  title: string;
  content: string;
  content_hash: string;
  metadata: string;
  updated_at: string;
}

/**
 * Plan one page of the pass on a read handle: read the next
 * {@link WEB_REDACTION_PAGE_SIZE} web documents through the
 * `(provider_id, source_id, external_id, stream_id)` index and redact them
 * with the shaped rules only. The assignment and table rules judge a value by
 * its look, which is right for a page arriving now and too loose to rewrite
 * stored text that cannot be recovered. Only a document whose redacted form
 * differs becomes a mutation.
 */
export function planWebRedactionPage(db: Db, prior?: WebRedactionCursor): WebRedactionPlan {
  const cursor = prior ?? { sourceId: "", externalId: "", streamId: "", scanned: 0 };
  const rows = db
    .prepare<[string, string, string, string, number], StoredPage>(
      `SELECT id, source_id, external_id, stream_id, title, content, content_hash, metadata, updated_at
         FROM documents
        WHERE provider_id = ? AND (source_id, external_id, stream_id) > (?, ?, ?)
        ORDER BY source_id, external_id, stream_id
        LIMIT ?`,
    )
    .all(
      WEB_PROVIDER_ID,
      cursor.sourceId,
      cursor.externalId,
      cursor.streamId,
      WEB_REDACTION_PAGE_SIZE,
    );
  const mutations: WebRedactionMutation[] = [];
  for (const row of rows) {
    if (!isWebSourceId(row.source_id)) continue;
    const metadata = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id });
    const stored = {
      sourceId: row.source_id,
      title: row.title,
      content: row.content,
      contentHash: row.content_hash,
      metadata,
    } as unknown as DocumentInput;
    const redacted = redactWebDocument(stored, redactShapedSecrets);
    if (redacted === stored) continue;
    mutations.push({
      id: row.id,
      expectedUpdatedAt: row.updated_at,
      title: redacted.title,
      content: redacted.content,
      contentHash: redacted.contentHash,
      metadata: documentsMetadataCodec.serialize(redacted.metadata as Record<string, unknown>),
      sourceUrl:
        typeof redacted.metadata?.sourceUrl === "string"
          ? normalizeUrl(redacted.metadata.sourceUrl)
          : null,
    });
  }
  const last = rows.at(-1);
  return {
    cursor: last
      ? {
          sourceId: last.source_id,
          externalId: last.external_id,
          streamId: last.stream_id,
          scanned: cursor.scanned + rows.length,
        }
      : cursor,
    mutations,
    done: rows.length < WEB_REDACTION_PAGE_SIZE,
  };
}

/**
 * Apply one planned page on the writer, in one transaction of at most
 * {@link WEB_REDACTION_PAGE_SIZE} indexed updates. A row written since it was
 * read is left alone (its `updated_at` moved): the write that changed it went
 * through ingest, which redacts. A rewritten row gets a fresh `updated_at` so
 * the indexer re-embeds it, and the derived-state markers ingest clears on a
 * content change. With `finishedKey`, the store is recorded as current in the
 * same transaction.
 */
export function applyWebRedactionPage(
  db: Db,
  mutations: readonly WebRedactionMutation[],
  finishedKey: string | null,
): number {
  if (mutations.length > WEB_REDACTION_PAGE_SIZE) {
    throw new Error(`web redaction page exceeds ${WEB_REDACTION_PAGE_SIZE}`);
  }
  return db.transaction(() => {
    const update = db.prepare(
      `UPDATE documents
          SET title = ?, content = ?, content_hash = ?, metadata = ?, source_url = ?, updated_at = ?,
              links_extracted_at = NULL, people_resolved_at = NULL, dates_extracted_at = NULL,
              vocabulary_processed_at = NULL, vocabulary_revision = vocabulary_revision + 1
        WHERE id = ? AND updated_at = ?`,
    );
    const now = new Date().toISOString();
    let touched = 0;
    for (const mutation of mutations) {
      touched += update.run(
        mutation.title,
        mutation.content,
        mutation.contentHash,
        mutation.metadata,
        mutation.sourceUrl,
        now,
        mutation.id,
        mutation.expectedUpdatedAt,
      ).changes;
    }
    if (finishedKey) markWebRedactionCurrent(db, finishedKey);
    return touched;
  })();
}

export interface WebRedactionGates {
  /** Whether the stored pages are already current; read on any handle. */
  isCurrent(): boolean;
  plan(cursor?: WebRedactionCursor): Promise<WebRedactionPlan>;
  apply(mutations: readonly WebRedactionMutation[], finishedKey: string | null): Promise<number>;
}

/** Progress is logged once per this many pages read, and at the end. */
const PROGRESS_EVERY_PAGES = 100;

/**
 * Redact the web pages already stored, once per rules version, in the
 * background: plan a page on a reader, apply it through the writer, repeat.
 * Other writes interleave between pages, and an interrupted pass starts over
 * on the next boot, which finds the rows it already rewrote unchanged.
 */
export class WebRedactionBackfill {
  constructor(private readonly gates: WebRedactionGates) {}

  async run(): Promise<{ scanned: number; touched: number }> {
    if (this.gates.isCurrent()) return { scanned: 0, touched: 0 };
    let cursor: WebRedactionCursor | undefined;
    let touched = 0;
    let pages = 0;
    for (;;) {
      const plan = await this.gates.plan(cursor);
      cursor = plan.cursor;
      pages += 1;
      if (plan.mutations.length > 0 || plan.done) {
        touched += await this.gates.apply(
          plan.mutations,
          plan.done ? WEB_PAGES_REDACTION_KEY : null,
        );
      }
      if (plan.done) {
        log.info(`Web page redaction pass done: ${cursor.scanned} scanned, ${touched} redacted`);
        return { scanned: cursor.scanned, touched };
      }
      if (pages % PROGRESS_EVERY_PAGES === 0) {
        log.info(`Web page redaction pass: ${cursor.scanned} scanned, ${touched} redacted so far`);
      }
    }
  }
}

/**
 * Visit addresses that might hold a credential: a user and password before
 * the host, a query or fragment parameter (an `=`), or a shaped token's
 * prefix. Every other row is skipped by the scan without being read.
 */
const VISIT_URL_CANDIDATES = String.raw`url LIKE '%@%' OR url LIKE '%=%' OR regexp_matches(url, '(gh[pousr]_|github_pat_|eyJ|xox[abceoprs]-|sk-|AKIA|ASIA|glpat-|hvs\.|npm_|hf_)')`;

/** The text columns of a web `page_visits` row the stored-visit pass rewrites in place. */
const VISIT_TEXT_COLUMNS = ["title", "browser_profile_label"];

/** A visit address as it is stored now: no user or password, credential params stripped, shaped secrets redacted. */
function storedVisitUrl(url: string): string {
  let clean = url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      clean = parsed.toString();
    }
  } catch {
    return redactShapedSecrets(url);
  }
  return redactShapedSecrets(normalizeUrl(clean));
}

export interface WebVisitRedactionState {
  isCurrent(): boolean;
  markCurrent(): Promise<void>;
}

/**
 * Redact the web `page_visits` rows already stored, once per rules version,
 * in the background after the analytics store opens, a page of rows per
 * write turn. Titles and browser labels are rewritten in place. An address
 * that still carries a credential parameter or a user and password — rules
 * that came after the row was captured — is part of the row's key, so its row
 * moves to the cleaned key; when a row already holds that key the two merge,
 * keeping the longer dwell and the non-empty title. Shaped rules only, as for
 * stored pages.
 */
export async function redactStoredWebVisits(
  analyticsDb: AnalyticsDb,
  state: WebVisitRedactionState,
): Promise<number> {
  if (state.isCurrent()) return 0;
  const schema = await analyticsDb.getRecordTableSchema("page_visits");
  let changed = 0;
  if (schema && isWebSourceId(schema.sourceId)) {
    const present = new Set(schema.columns.map((column) => column.name));
    const columns = VISIT_TEXT_COLUMNS.filter((column) => present.has(column));
    changed += await analyticsDb.rewriteTextColumns("page_visits", columns, redactShapedSecrets);
    if (present.has("url")) {
      const merge = [
        present.has("dwell_ms")
          ? `dwell_ms = greatest(COALESCE(dwell_ms, 0), COALESCE(excluded.dwell_ms, 0))`
          : null,
        present.has("title") ? `title = COALESCE(NULLIF(title, ''), excluded.title)` : null,
      ].filter((clause): clause is string => clause !== null);
      changed += await analyticsDb.rewriteKeyColumn("page_visits", "url", storedVisitUrl, {
        candidates: VISIT_URL_CANDIDATES,
        ...(merge.length > 0 ? { onConflict: merge.join(", ") } : {}),
      });
    }
  }
  await state.markCurrent();
  log.info(`Page visit redaction pass done: ${changed} visit(s) rewritten`);
  return changed;
}
