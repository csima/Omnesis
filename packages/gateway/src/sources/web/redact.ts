// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, createLogger } from "@omnesis/core";
import { redactSecrets } from "@omnesis/provider-web/redact-secrets";
import { WEB_SOURCE_ID } from "../../web-dataset.js";
import type { DocumentInput } from "@omnesis/types";

const log = createLogger("gateway").child("web-redact");

/** The analytics table the browser extension writes one row per visit into. */
const PAGE_VISITS_TABLE = "page_visits";

/**
 * The gateway's backstop for secrets in captured web pages.
 *
 * The browser extension redacts credentials from a page's title and text
 * before the page leaves the browser. A browser running an older or modified
 * extension may not, so every web page is redacted again here, on ingest,
 * with the same rules (`@omnesis/provider-web/redact-secrets`), before
 * anything is stored or indexed. Redaction is idempotent, so a page the
 * extension already redacted is stored exactly as sent, content hash
 * included; a page this pass changes gets the hash of its redacted text.
 *
 * Only `web` documents and the `web` source's `page_visits` rows are touched:
 * every other source's documents are the user's own records, stored as the
 * source wrote them.
 */
export function redactWebDocuments(documents: readonly DocumentInput[]): DocumentInput[] {
  let changed = 0;
  const out = documents.map((document) => {
    if (document.sourceId !== WEB_SOURCE_ID) return document;
    const title =
      typeof document.title === "string" ? redactSecrets(document.title) : document.title;
    const content =
      typeof document.content === "string" ? redactSecrets(document.content) : document.content;
    if (title === document.title && content === document.content) return document;
    changed += 1;
    return {
      ...document,
      title,
      content,
      contentHash:
        content === document.content ? document.contentHash : computeContentHash(content),
    };
  });
  if (changed > 0) log.info(`Redacted secrets from ${changed} captured web page(s) on ingest`);
  return out;
}

/** Redact the page titles in a `web` source `page_visits` batch; any other batch is returned as is. */
export function redactWebVisitRecords(
  sourceId: string | undefined,
  tableName: string,
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (sourceId !== WEB_SOURCE_ID || tableName !== PAGE_VISITS_TABLE) return records;
  return records.map((record) => {
    const title = record.title;
    if (typeof title !== "string") return record;
    const redacted = redactSecrets(title);
    return redacted === title ? record : { ...record, title: redacted };
  });
}
