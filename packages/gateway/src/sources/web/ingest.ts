// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, createLogger, normalizeUrl } from "@omnesis/core";
import { judgeCaptureUrl, type WebCapturePolicy } from "@omnesis/provider-web/capture-policy";
import { redactSecrets, redactShapedSecrets } from "@omnesis/provider-web/redact-secrets";
import { SCOPE_ADMIN, SCOPE_WRITE_ALL, scopeSatisfies, sourceTypeOf } from "@omnesis/types";
import { ForbiddenError } from "../../http/errors.js";
import { WEB_SOURCE_ID } from "../../web-dataset.js";
import type { DocumentInput, Scope } from "@omnesis/types";

const log = createLogger("gateway").child("web-ingest");

/** The analytics table the browser extension writes one row per visit into. */
const PAGE_VISITS_TABLE = "page_visits";

/**
 * The gateway's backstop for captured web pages.
 *
 * The browser extension redacts credentials from a page before it leaves the
 * browser, and skips the pages the capture policy refuses. A browser running
 * an older or modified extension may do neither, so the gateway does both
 * again on ingest, before anything is stored or indexed:
 *
 * - every web document's title, text, address, tags and extra metadata, and
 *   every visit row's title, address and browser label, are redacted with the
 *   extension's own rules (`@omnesis/provider-web/redact-secrets`);
 * - a page or visit whose address the policy refuses — a built-in mail,
 *   messaging or password-manager site, one of the operator's own sites, an
 *   excluded or owned domain, a credential path — is turned away the way a
 *   page deleted for good is.
 *
 * Redaction is idempotent, so a page the extension already redacted is stored
 * exactly as sent, content hash included; a page this pass changes gets the
 * hash of its redacted text. Every document and row of the `web` source type
 * is covered, whatever account suffix its source id carries; every other
 * source's records are the user's own, stored as the source wrote them.
 */

/** Whether `sourceId` names the web source type, with or without an account suffix. */
export function isWebSourceId(sourceId: string | undefined): boolean {
  return sourceId !== undefined && sourceTypeOf(sourceId) === WEB_SOURCE_ID;
}

/**
 * Refuse a web-typed source id other than the one web source. The web source
 * is single-instance, so `web:<account>` names nothing a browser may write;
 * only a broad writer, which bypasses every source scope anyway, is let
 * through.
 */
export function assertCanonicalWebSourceIds(
  scopes: readonly Scope[],
  sourceIds: Iterable<string>,
): void {
  if (scopeSatisfies(scopes, SCOPE_ADMIN) || scopeSatisfies(scopes, SCOPE_WRITE_ALL)) return;
  for (const sourceId of sourceIds) {
    if (isWebSourceId(sourceId) && sourceId !== WEB_SOURCE_ID) {
      throw new ForbiddenError(`Forbidden: browser captures go to the "${WEB_SOURCE_ID}" source`);
    }
  }
}

/**
 * An address as it is stored: without a user or password, normalized (which
 * strips credential params, in the fragment too) and redacted with the shaped
 * rules only — an address holds no assignments, and a path such as
 * `/token=…/docs` must keep its shape.
 */
function redactUrl(url: string): string {
  let clean = url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      clean = parsed.toString();
    }
  } catch {
    // Not a URL: redacted as text below.
  }
  return redactShapedSecrets(normalizeUrl(clean));
}

function redactStrings(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactStrings(entry, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactStrings(entry, redact),
      ]),
    );
  }
  return value;
}

/**
 * Redact one web document's metadata — every string in it, at any depth,
 * except the `documentType` that routes it — with `sourceUrl` treated as an
 * address. The same object when nothing changed.
 */
function redactMetadata(
  metadata: DocumentInput["metadata"],
  redact: (text: string) => string,
): DocumentInput["metadata"] {
  if (!metadata || typeof metadata !== "object") return metadata;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "documentType") next[key] = value;
    else if (key === "sourceUrl" && typeof value === "string") next[key] = redactUrl(value);
    else next[key] = redactStrings(value, redact);
  }
  return JSON.stringify(next) === JSON.stringify(metadata)
    ? metadata
    : (next as DocumentInput["metadata"]);
}

/**
 * Redact one web document, with every rule by default or with the given
 * redactor (the stored-page pass uses only the shaped rules); the same object
 * when nothing changed.
 */
export function redactWebDocument(
  document: DocumentInput,
  redact: (text: string) => string = redactSecrets,
): DocumentInput {
  if (!isWebSourceId(document.sourceId)) return document;
  const title = typeof document.title === "string" ? redact(document.title) : document.title;
  const content =
    typeof document.content === "string" ? redact(document.content) : document.content;
  const metadata = redactMetadata(document.metadata, redact);
  if (title === document.title && content === document.content && metadata === document.metadata) {
    return document;
  }
  return {
    ...document,
    title,
    content,
    metadata,
    contentHash: content === document.content ? document.contentHash : computeContentHash(content),
  };
}

/** Redact every web document in a batch; other sources' documents are returned as they are. */
export function redactWebDocuments(documents: readonly DocumentInput[]): DocumentInput[] {
  let changed = 0;
  const out = documents.map((document) => {
    const redacted = redactWebDocument(document);
    if (redacted !== document) changed += 1;
    return redacted;
  });
  if (changed > 0) log.info(`Redacted secrets from ${changed} captured web page(s) on ingest`);
  return out;
}

/** Whether a batch is the web source type's `page_visits` table. */
function isWebVisitBatch(sourceId: string | undefined, tableName: string): boolean {
  return isWebSourceId(sourceId) && tableName.toLowerCase() === PAGE_VISITS_TABLE;
}

/** Redact the title, address and browser label of a web `page_visits` batch; any other batch is returned as is. */
export function redactWebVisitRecords(
  sourceId: string | undefined,
  tableName: string,
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!isWebVisitBatch(sourceId, tableName)) return records;
  return records.map((record) => {
    const next = { ...record };
    if (typeof next.title === "string") next.title = redactSecrets(next.title);
    if (typeof next.url === "string") next.url = redactUrl(next.url);
    if (typeof next.browser_profile_label === "string") {
      next.browser_profile_label = redactSecrets(next.browser_profile_label);
    }
    return next.title === record.title &&
      next.url === record.url &&
      next.browser_profile_label === record.browser_profile_label
      ? record
      : next;
  });
}

/** Whether `url` is an http(s) address, the only kind a browser captures. */
function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether the policy refuses a page at `url`. The pause is not consulted —
 * a page captured before a pause began is still delivered. An address that is
 * missing or not http(s) is refused: a captured page always has one.
 */
export function refusesWebUrl(policy: WebCapturePolicy | null | undefined, url: unknown): boolean {
  if (!isHttpUrl(url)) return true;
  if (!policy) return false;
  return !judgeCaptureUrl({ ...policy, pause: null }, url, { gatewayHost: "", now: 0 }).allowed;
}

/** Split a batch into the documents the policy lets in and the web pages it refuses. */
export function partitionCapturableDocuments(
  documents: readonly DocumentInput[],
  policy: WebCapturePolicy | null | undefined,
): { kept: DocumentInput[]; refused: DocumentInput[] } {
  const kept: DocumentInput[] = [];
  const refused: DocumentInput[] = [];
  for (const document of documents) {
    const refuse =
      isWebSourceId(document.sourceId) && refusesWebUrl(policy, document.metadata?.sourceUrl);
    (refuse ? refused : kept).push(document);
  }
  if (refused.length > 0) {
    log.info(`Refused ${refused.length} captured web page(s) the capture policy does not allow`);
  }
  return { kept, refused };
}

/** Drop the visit rows the policy refuses from a web `page_visits` batch; any other batch is returned as is. */
export function filterCapturableVisits(
  sourceId: string | undefined,
  tableName: string,
  records: Record<string, unknown>[],
  policy: WebCapturePolicy | null | undefined,
): Record<string, unknown>[] {
  if (!isWebVisitBatch(sourceId, tableName)) return records;
  const kept = records.filter((record) => !refusesWebUrl(policy, record.url));
  if (kept.length < records.length) {
    log.info(
      `Refused ${records.length - kept.length} page visit(s) the capture policy does not allow`,
    );
  }
  return kept;
}
