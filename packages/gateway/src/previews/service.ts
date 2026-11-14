// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Accepting and serving document previews.
 *
 * Shared code knows nothing about where a preview comes from. A source opts in
 * by registering a {@link PreviewAdmission} for its source id; an upload for a
 * source with none is refused. The admission is the source's own rule for
 * whether this preview may be kept — a browser screenshot, for instance, only
 * while its capture policy has screenshots switched on and still allows the
 * page — and runs after the checks every preview shares: the caller may write
 * the source, the source is neither paused nor removed, the document exists
 * and was not deleted for good, and the image is one this store accepts.
 */

import { createLogger } from "@omnesis/core";
import { isKnowledgeDocumentReadable } from "../brain/knowledge/retrieval-fence.js";
import { assertExternalDocumentWrite } from "../internal-sources.js";
import { HttpError } from "../http/errors.js";
import { enforceWriteScopeForSource } from "../http/scope.js";
import {
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_DIMENSION,
  PREVIEW_CONTENT_TYPES,
  previewRef,
  type DocumentPreviewRef,
  type DocumentPreviewStore,
  type PreviewContentType,
  type StoredPreviewMeta,
} from "./store.js";
import type { DeviceId, Scope } from "@omnesis/types";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway").child("previews");

const reportedFailures = new Set<string>();

/**
 * Log a preview-store failure once per operation. A broken `previews.db`
 * only ever costs the previews: every caller carries on without them, and the
 * orphan sweep removes whatever a failed delete left behind.
 */
export function reportPreviewStoreFailure(operation: string, error: unknown): void {
  if (reportedFailures.has(operation)) return;
  reportedFailures.add(operation);
  log.error(
    `The preview store failed to ${operation}; carrying on without previews: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Delete the previews of `documentIds`, never throwing: the documents are
 * already gone, and a preview a failure leaves behind is removed by the
 * orphan sweep.
 */
export async function deletePreviewsSafely(
  store: Pick<DocumentPreviewStore, "deleteForDocuments"> | undefined,
  documentIds: readonly string[],
): Promise<void> {
  if (!store || documentIds.length === 0) return;
  try {
    await store.deleteForDocuments(documentIds);
  } catch (error) {
    reportPreviewStoreFailure("delete previews", error);
  }
}

/** The document a preview is offered for, as the admission sees it. */
export interface PreviewTarget {
  id: string;
  providerId: string;
  sourceId: string;
  externalId: string;
  streamId: string;
  sourceUrl: string | null;
}

/** A source's refusal of one preview: an HTTP status, a stable code and a reason. */
export interface PreviewRefusal {
  status: 409 | 410 | 422;
  code: string;
  message: string;
}

export interface PreviewAdmissionContext {
  target: PreviewTarget;
  /** The host name the uploader addressed the gateway by. */
  requestHost: string;
}

/** A source's rule for keeping a preview; null admits it. */
export type PreviewAdmission = (context: PreviewAdmissionContext) => PreviewRefusal | null;

export interface PreviewUpload {
  providerId: string;
  sourceId: string;
  externalId: string;
  contentType: string;
  width: number;
  height: number;
  capturedAt: string;
  bytes: Uint8Array;
}

export interface PreviewUploadAuth {
  deviceId?: DeviceId | null;
  scopes: readonly Scope[];
}

export interface DocumentPreviewServiceDeps {
  db: Db;
  store: DocumentPreviewStore;
  /** Paused / removed verdict for the source, as ingest applies it. */
  gatePush: (
    sourceIds: readonly string[],
    auth: { scopes: readonly Scope[] },
  ) => { rejected: ReadonlyArray<{ sourceId: string; reason: string }> };
  /** The stream the caller's documents for a source live in. */
  streamFor: (sourceId: string, auth: { deviceId: DeviceId | null }) => string;
}

export class DocumentPreviewService {
  private readonly admissions = new Map<string, PreviewAdmission>();

  constructor(private readonly deps: DocumentPreviewServiceDeps) {}

  /** Let `sourceId` keep previews under `admission`. */
  registerAdmission(sourceId: string, admission: PreviewAdmission): void {
    this.admissions.set(sourceId, admission);
  }

  async upload(
    upload: PreviewUpload,
    auth: PreviewUploadAuth,
    requestHost: string,
  ): Promise<{ stored: true; preview: DocumentPreviewRef }> {
    enforceWriteScopeForSource(auth.scopes, upload.sourceId);
    assertExternalDocumentWrite(upload.sourceId);
    const contentType = checkImage(upload);

    const admission = this.admissions.get(upload.sourceId);
    if (!admission) {
      throw new HttpError(409, "PREVIEWS_NOT_ACCEPTED", "This source does not keep previews");
    }
    const rejection = this.deps.gatePush([upload.sourceId], auth).rejected[0];
    if (rejection) {
      throw new HttpError(409, "SOURCE_REJECTED", `The source is ${rejection.reason}`);
    }
    const streamId = this.deps.streamFor(upload.sourceId, { deviceId: auth.deviceId ?? null });
    if (this.isSuppressed(upload, streamId)) {
      throw new HttpError(410, "PREVIEW_SUPPRESSED", "The document was deleted for good");
    }
    const target = this.findTarget(upload, streamId);
    if (!target) {
      throw new HttpError(404, "PREVIEW_DOCUMENT_NOT_FOUND", "No such document");
    }
    const refusal = admission({ target, requestHost });
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);

    const meta = this.deps.store.put({
      documentId: target.id,
      sourceId: target.sourceId,
      contentType,
      width: upload.width,
      height: upload.height,
      capturedAt: upload.capturedAt,
      bytes: upload.bytes,
    });
    // A delete that landed between the lookup and the put has already run its
    // preview cascade, so the row just written would outlive its document.
    if (!this.documentExists(target.id)) {
      await deletePreviewsSafely(this.deps.store, [target.id]);
      throw new HttpError(404, "PREVIEW_DOCUMENT_NOT_FOUND", "No such document");
    }
    log.debug(`Stored a ${meta.byteLength}-byte preview for ${target.id}`);
    return { stored: true, preview: previewRef(meta) };
  }

  /** The preview of a readable document, or null. */
  read(documentId: string): { meta: StoredPreviewMeta; bytes: Buffer } | null {
    const row = this.deps.db
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
      .get(documentId);
    if (!row || !isKnowledgeDocumentReadable(this.deps.db, documentId, row.source_id)) return null;
    try {
      return this.deps.store.read(documentId);
    } catch (error) {
      reportPreviewStoreFailure("read a preview", error);
      return null;
    }
  }

  /** The wire reference of a document's preview, or undefined (also when the store fails). */
  refFor(documentId: string): DocumentPreviewRef | undefined {
    try {
      const meta = this.deps.store.describe(documentId);
      return meta ? previewRef(meta) : undefined;
    } catch (error) {
      reportPreviewStoreFailure("describe a preview", error);
      return undefined;
    }
  }

  /** Wire references for the documents of `documentIds` that have a preview; none when the store fails. */
  refsFor(documentIds: readonly string[]): Map<string, DocumentPreviewRef> {
    const out = new Map<string, DocumentPreviewRef>();
    if (documentIds.length === 0) return out;
    try {
      for (const [id, meta] of this.deps.store.describeMany(documentIds)) {
        out.set(id, previewRef(meta));
      }
    } catch (error) {
      reportPreviewStoreFailure("describe previews", error);
      out.clear();
    }
    return out;
  }

  private isSuppressed(upload: PreviewUpload, streamId: string): boolean {
    return (
      this.deps.db
        .prepare<[string, string, string, string], { one: number }>(
          `SELECT 1 AS one FROM removed_documents
            WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id = ?`,
        )
        .get(upload.providerId, upload.sourceId, streamId, upload.externalId) !== undefined
    );
  }

  private findTarget(upload: PreviewUpload, streamId: string): PreviewTarget | null {
    const row = this.deps.db
      .prepare<
        [string, string, string, string],
        {
          id: string;
          provider_id: string;
          source_id: string;
          external_id: string;
          stream_id: string;
          source_url: string | null;
        }
      >(
        `SELECT id, provider_id, source_id, external_id, stream_id, source_url FROM documents
          WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ?`,
      )
      .get(upload.providerId, upload.sourceId, upload.externalId, streamId);
    if (!row) return null;
    return {
      id: row.id,
      providerId: row.provider_id,
      sourceId: row.source_id,
      externalId: row.external_id,
      streamId: row.stream_id,
      sourceUrl: row.source_url,
    };
  }

  private documentExists(documentId: string): boolean {
    return (
      this.deps.db
        .prepare<[string], { one: number }>("SELECT 1 AS one FROM documents WHERE id = ?")
        .get(documentId) !== undefined
    );
  }
}

/** Validate the image and its declared shape; returns its content type. */
function checkImage(upload: PreviewUpload): PreviewContentType {
  if (!(PREVIEW_CONTENT_TYPES as readonly string[]).includes(upload.contentType)) {
    throw new HttpError(
      415,
      "UNSUPPORTED_PREVIEW_TYPE",
      "A preview must be image/webp or image/jpeg",
    );
  }
  if (upload.bytes.byteLength === 0) {
    throw new HttpError(400, "BAD_REQUEST", "The preview image is empty");
  }
  if (upload.bytes.byteLength > MAX_PREVIEW_BYTES) {
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      `A preview image is at most ${MAX_PREVIEW_BYTES / 1024} KB`,
    );
  }
  for (const side of [upload.width, upload.height]) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_PREVIEW_DIMENSION) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        `Preview width and height must be whole pixels from 1 to ${MAX_PREVIEW_DIMENSION}`,
      );
    }
  }
  const contentType = upload.contentType as PreviewContentType;
  if (!bytesMatchType(upload.bytes, contentType)) {
    throw new HttpError(415, "UNSUPPORTED_PREVIEW_TYPE", `The image is not ${contentType}`);
  }
  return contentType;
}

function bytesMatchType(bytes: Uint8Array, contentType: PreviewContentType): boolean {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}
