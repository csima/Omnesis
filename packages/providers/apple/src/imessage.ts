// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  buildAttachmentDocument,
  buildMediaAttachmentDocument,
  formatAttachmentMarkers,
  deriveAttachmentStableId,
  assignAttachmentSeqs,
  computeContentHash,
  transcriptionSyncIssues,
  TRANSCRIBER_UNAVAILABLE,
  AudioUnreadableError,
} from "@omnesis/core";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import { unavailableStorePage } from "./store-unavailable.js";
import { parseAttributedBody } from "./imessage-attributed-body.js";
import { IMessageTranscriptCache } from "./imessage-transcript-cache.js";
import { ContactNameDirectory, HandleNameIndex } from "./contact-names.js";
import {
  imessageDateToDate,
  isoToImessageNs,
  formatDateKey,
  getTapbackLabel,
  isTapback,
  isTapbackRemoval,
  normalizeDayChat,
  imessagePersonIdentifiers,
  buildIMessageSourceUrl,
  describeMediaAttachment,
  mediaAttachmentNoun,
} from "./imessage-normalizer.js";
import { validateAppleIMessageSyncCursor } from "./imessage-types.js";
import {
  imessageAttachmentFilename,
  resolveIMessageAttachment,
  type IMessageAttachmentRow,
} from "./imessage-attachment-type.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import { IMessagePreviewLedger, type PreviewLedgerEntry } from "./imessage-preview-ledger.js";
import { renderIMessageThumbnail } from "./imessage-thumbnails.js";
import type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  AudioTranscribeFn,
  ExtractionResult,
} from "@omnesis/core";
import type {
  RenderedDocumentPreview,
  SourcePreviewSink,
  SyncCursor,
  SyncProgress,
  SyncResult,
} from "@omnesis/source-sdk";
import type { DocumentInput, SyncIssue } from "@omnesis/types";
import type { AppleProvider } from "./provider.js";
import type {
  AppleIMessageSyncCursor,
  RawIMessage,
  RawIMessageAttachment,
  ParsedIMessage,
  IMessageChatInfo,
} from "./imessage-types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("source:apple-imessage");

const PAGE_SIZE = 500;
/**
 * Day-chats re-rendered per run for voice clips due another transcription
 * attempt. One backoff step brings every clip that failed together due at
 * once; the rest follow on later runs so one run never renders them all.
 */
const MAX_DUE_TRANSCRIPTION_DAYS_PER_RUN = 25;
/**
 * Day-chats re-rendered per run because only the contact names of their
 * handles changed. Granting Contacts access, or the first sync after names
 * were introduced, renames every named conversation at once; the newest days
 * go first and the rest follow on later runs, so one run never renders them
 * all. Days whose messages changed are not counted against this.
 */
const MAX_RENAMED_DAYS_PER_RUN = 200;
/**
 * Thumbnails offered per sync pass, newest first. A first sync of a long
 * history finds thousands; the rest wait in the preview ledger, due at once,
 * and later passes take the next share.
 */
const MAX_PREVIEW_OFFERS_PER_PASS = 100;
/**
 * Separates a day signature's message part from its contact-names part. A day
 * with no named handle has no names part, so its signature is what it was
 * before names existed.
 */
const DAY_SIGNATURE_NAMES_SEPARATOR = "+";

// Messages' "Keep Messages" setting (30 Days / 1 Year / Forever, under
// Settings > Messages) prunes chat.db locally and silently once it is set to
// anything but Forever. That preference lives outside chat.db, in a plist
// this source does not read, so it can never tell whether history predating
// this install was already gone before the first sync — or whether more of
// it will vanish between syncs. The honest claim is "unknown", permanently:
// nothing observed at sync time can turn it into "complete".
const IMESSAGE_COVERAGE_DETAIL =
  "Messages can delete old conversations on its own (Settings → Messages → Keep Messages), and Omnesis removes what Messages removes, so older messages may not be here.";

/** Sync progress for a page, carrying the permanent coverage caveat above. */
function imessageProgress(
  phase: SyncProgress["phase"],
  processed: number,
  total?: number,
): SyncProgress {
  return { phase, processed, total, coverage: "unknown", detail: IMESSAGE_COVERAGE_DETAIL };
}

interface IMessageSchemaColumns {
  cacheHasAttachments: boolean;
  associatedMessageEmoji: boolean;
  replyToGuid: boolean;
  threadOriginatorGuid: boolean;
  groupTitle: boolean;
}

interface IMessageDaySnapshot {
  externalIds: string[];
  daySignatures: Record<string, string>;
  signature: string;
}

interface IMessageSnapshotReconciliation {
  documents: DocumentInput[];
  presentExternalIds?: string[];
  snapshotSignature?: string;
  daySignatures?: Record<string, string>;
}

/**
 * What reading one attachment came to: its text; a settled answer that there
 * is none to read, which a photo, video or PDF is described in place of; or a
 * failed read, which emits nothing so an earlier child survives.
 */
type AttachmentReadOutcome =
  | { kind: "text"; result: ExtractionResult }
  | { kind: "nothing-to-read"; reason: AttachmentInfo["reason"] }
  | { kind: "read-failed"; reason: AttachmentInfo["reason"] };

interface IMessageAttachmentEntry {
  raw: RawIMessageAttachment;
  filename: string;
  mimeType: string;
}

/** A photo, video or PDF document this pass wrote, whose thumbnail may be offered. */
interface PreviewCandidate {
  key: string;
  externalId: string;
  dayKey: string;
  /** The attachment's path as chat.db stores it. */
  storedPath: string | null;
  mimeType: string;
  sentAtMs: number;
}

export interface AppleIMessageSourceOptions {
  isTranscriptionVocabularyEnabled?: () => boolean;
  sourceId: string;
  providerId: string;
  dataCutoff?: string;
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  /**
   * Injected speech-to-text fn (forwards to the gateway). Wired only when the
   * `stt` feature is on. When present, audio attachments are transcribed and
   * rendered inline in the conversation; when absent, audio keeps the plain
   * `[Audio: filename]` placeholder and no audio bytes are read.
   */
  transcribeAudio?: AudioTranscribeFn;
  /**
   * Collector config dir — the transcript sidecar (`transcripts.db`) is rooted
   * here so re-syncs reuse transcripts instead of re-transcribing. Undefined
   * falls back to an in-memory cache (de-dupes within a run only).
   */
  configDir?: string;
  /**
   * The collector's phone region, the last hint for normalizing a contact's
   * national-format number when matching handles to contact names.
   */
  phoneRegion?: string;
  /**
   * Where thumbnails of photos, videos and PDFs are offered (`host.previews`).
   * Without it no thumbnail is made.
   */
  previews?: SourcePreviewSink;
  /**
   * The preview ledger's file (`<stateDir>/imessage-previews.db`); in memory
   * when undefined.
   */
  previewLedgerPath?: string;
  /** Makes one thumbnail; `renderIMessageThumbnail` unless a test supplies one. */
  renderPreview?: (filePath: string, mimeType: string) => Promise<RenderedDocumentPreview | null>;
}

/**
 * Expand ~ in file paths to the user's home directory.
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }
  return path;
}

function resolveAttachmentPath(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("file://")) {
    try {
      return fileURLToPath(path);
    } catch {
      return path;
    }
  }
  const expanded = expandPath(path);
  if (isAbsolute(expanded)) return expanded;
  if (expanded.startsWith("Library/Messages/Attachments/")) {
    return join(homedir(), expanded);
  }
  return expanded;
}

function attachmentFileSignature(path: string | null): string {
  const resolved = resolveAttachmentPath(path);
  if (!resolved) return "no-path";
  try {
    const stat = statSync(resolved);
    return `file:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Apple iMessage source.
 * Reads from ~/Library/Messages/chat.db and produces per-day-per-chat documents.
 *
 * Incremental pulls are ROWID-based, but iMessage rows are mutable and deletes
 * are physical. The source therefore also builds a full day-key snapshot at
 * the end of each cycle: the gateway prunes missing IDs, and days whose
 * content signature changed without a new ROWID are re-emitted.
 */
export class AppleIMessageSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  readonly watchPaths: string[];

  /** Optional ISO 8601 cutoff — messages sent before this date are excluded. */
  readonly dataCutoff?: string;

  private isTranscriptionVocabularyEnabled?: () => boolean;
  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;
  private transcribeAudio?: AudioTranscribeFn;
  private configDir?: string;
  /** Lazily opened on first audio transcription, so a no-audio sync opens no DB. */
  private transcriptCache?: IMessageTranscriptCache;
  private schemaColumns?: IMessageSchemaColumns;
  private schemaColumnsDb?: Db;
  /** The Mac's Contacts as handle → name, rebuilt only when they change. */
  private readonly contactNames: ContactNameDirectory;
  /** This sync pass's contact names, read once at its start. */
  private names: HandleNameIndex = HandleNameIndex.empty;
  private readonly previews?: SourcePreviewSink;
  private readonly previewLedgerPath?: string;
  private readonly renderPreview: (
    filePath: string,
    mimeType: string,
  ) => Promise<RenderedDocumentPreview | null>;
  /** Opened on the first offer, so a source without previews opens nothing. */
  private previewLedger?: IMessagePreviewLedger;
  private previewLedgerFailed = false;
  /** The media documents this sync pass wrote, collected as its days are built. */
  private previewCandidates: PreviewCandidate[] = [];

  constructor(
    private provider: AppleProvider,
    opts: AppleIMessageSourceOptions,
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    const dbPath = provider.imessageDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;
    this.attachmentConfig = opts.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts.extractAttachment;
    this.transcribeAudio = opts.transcribeAudio;
    this.isTranscriptionVocabularyEnabled = opts.isTranscriptionVocabularyEnabled;
    this.configDir = opts.configDir;
    this.contactNames = new ContactNameDirectory(
      () => provider.getContactsStores(),
      opts.phoneRegion,
    );
    this.previews = opts.previews;
    this.previewLedgerPath = opts.previewLedgerPath;
    this.renderPreview =
      opts.renderPreview ?? ((filePath, mimeType) => renderIMessageThumbnail(filePath, mimeType));
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const db = this.provider.getIMessageDb();
    if (!db) {
      throwOnOpenFailure(this.provider.getIMessageOpenFailure());
      return unavailableStorePage(cursor ?? { lastRowId: 0 });
    }
    this.names = this.contactNames.current();

    let state: AppleIMessageSyncCursor | null = validateAppleIMessageSyncCursor(cursor);
    const maxMessageRowId = getMaxMessageRowId(db);
    if (state && state.lastRowId > maxMessageRowId) {
      log.warn(
        `iMessage ROWID watermark ${state.lastRowId} exceeds database max ${maxMessageRowId} — re-bootstrapping`,
      );
      state = null;
    }
    const lastRowId = state?.lastRowId ?? 0;
    const isBootstrap = lastRowId === 0;
    // A sync from no cursor is a bootstrap or a resync: clips found unreadable
    // before are sent again, in case the gateway's decoder now reads them.
    if (state === null && this.transcribeAudio && this.hasTranscriptSidecar()) {
      this.getTranscriptCache().forgetUnreadable();
    }
    // A resync may follow a wiped source, so every thumbnail is offered again.
    this.previewCandidates = [];
    if (state === null && this.previews) this.getPreviewLedger()?.clear();

    // Convert dataCutoff to iMessage nanosecond timestamp for filtering
    const cutoffNs = this.dataCutoff ? isoToImessageNs(this.dataCutoff) : null;

    // At bootstrap with a cutoff, jump only to the row immediately before the
    // earliest post-cutoff message. This is safe even when ROWID and message
    // date are not monotonic (backup restores can append old messages with
    // high ROWIDs). If no post-cutoff messages exist, jump to the current tail.
    let effectiveLastRowId = lastRowId;
    if (lastRowId === 0 && cutoffNs !== null) {
      const row = db
        .prepare(
          `SELECT MIN(CASE WHEN date >= ? THEN ROWID END) as minRecentRowId,
                  COALESCE(MAX(ROWID), 0) as maxRowId
             FROM message`,
        )
        .get(cutoffNs) as { minRecentRowId: number | null; maxRowId: number };
      effectiveLastRowId =
        row.minRecentRowId === null ? row.maxRowId : Math.max(0, row.minRecentRowId - 1);
      if (effectiveLastRowId > 0) {
        log.debug(`Cutoff bump: safely skipping ROWIDs 1..${effectiveLastRowId}`);
      }
    }

    // Fetch new messages since last sync (no date filter — the bump above
    // handles the bulk skip; the post-fetch affectedDays filter catches
    // any anomalous high-ROWID-old-date rows from a backup restore).
    const rows = this.fetchMessageRows(db, "WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?", [
      effectiveLastRowId,
      PAGE_SIZE + 1,
    ]);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    if (pageRows.length === 0) {
      const { documents, presentExternalIds, snapshotSignature, daySignatures } =
        await this.reconcileSnapshot(db, cutoffNs, state, new Set<string>());
      this.offerPreviews(db, true);
      return {
        documents,
        deletedExternalIds: [],
        presentExternalIds,
        issues: this.transcriptionIssues(),
        // Persist the cutoff bump so subsequent syncs don't re-scan the
        // pre-cutoff range — once we've jumped past it, we never want
        // to look back.
        cursor: {
          lastRowId: effectiveLastRowId,
          lastSnapshotSignature: snapshotSignature,
          lastDaySignatures: daySignatures,
        } satisfies AppleIMessageSyncCursor,
        hasMore: false,
        progress: imessageProgress(isBootstrap ? "bootstrap" : "incremental", 0),
      };
    }

    const maxRowId = pageRows[pageRows.length - 1].rowId;

    // Fetch attachments from the join table for every page row. The
    // `cache_has_attachments` flag is a cache hint and can lag reality.
    const attachmentMap = this.fetchAttachmentsForMessages(
      db,
      pageRows.map((r) => r.rowId),
    );

    // Parse raw rows into ParsedIMessage
    const parsed: ParsedIMessage[] = [];
    for (const row of pageRows) {
      // Skip messages without a chat (orphaned)
      if (!row.chatIdentifier) continue;

      // Extract text
      let text = row.text ?? "";
      if (!text && row.attributedBody) {
        text = parseAttributedBody(row.attributedBody) ?? "";
      }

      const date = imessageDateToDate(row.date);
      const sender = row.isFromMe ? "You" : (row.contactId ?? "Unknown");

      // Build attachment info
      const attachments = (attachmentMap.get(row.rowId) ?? []).map((a) => ({
        guid: a.guid ?? undefined,
        filename: imessageAttachmentFilename(a),
        mimeType: a.mimeType,
        filePath: a.filename,
        totalBytes: a.totalBytes,
      }));

      // Check if this is a tapback
      let tapback: ParsedIMessage["tapback"];
      if (
        (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) &&
        row.associatedMessageGuid
      ) {
        // Extract the target message guid from associated_message_guid
        // Format is "p:0/GUID" or "bp:GUID" — extract the GUID part
        const targetGuid = row.associatedMessageGuid.replace(/^(p:\d+\/|bp:)/, "");
        const label = getTapbackLabel(row.associatedMessageType, row.associatedMessageEmoji);
        if (label) {
          tapback = {
            type: label,
            targetGuid,
            emoji: row.associatedMessageEmoji ?? undefined,
            action: isTapbackRemoval(row.associatedMessageType) ? "remove" : "add",
          };
        }
      }

      parsed.push({
        rowId: row.rowId,
        guid: row.guid,
        text,
        date,
        isFromMe: !!row.isFromMe,
        isSystemMessage: !!row.isSystemMessage,
        sender,
        service: row.service ?? "iMessage",
        attachments,
        tapback,
        replyToGuid: row.replyToGuid ?? undefined,
        threadOriginatorGuid: row.threadOriginatorGuid ?? undefined,
        contactId: row.contactId ?? undefined,
        senderName: row.isFromMe ? undefined : this.names.nameFor(row.contactId),
      });
    }

    // Group by affected parent day-doc. Ordinary messages affect their own
    // day; tapback add/remove rows affect the day of their target message,
    // which may be different from the reaction row's timestamp.
    const affectedDays = new Map<
      string,
      { chatIdentifier: string; date: string; chatInfo: IMessageChatInfo }
    >();
    // Group rosters are reused across every day of the same chat in a page;
    // memoise per chat so the roster lookup runs once per chat, not per day.
    const rosterCache = new Map<string, string[]>();

    for (const row of pageRows) {
      if (!row.chatIdentifier) continue;
      const affected = this.resolveAffectedDayForRow(db, row, cutoffNs, rosterCache);
      if (!affected) continue;
      if (!affectedDays.has(affected.key)) {
        affectedDays.set(affected.key, {
          chatIdentifier: affected.chatIdentifier,
          date: affected.date,
          chatInfo: affected.chatInfo,
        });
      }
    }

    // For each affected day+chat, get all renderable messages for that day
    // plus every tapback row targeting those messages, then rebuild the full
    // parent document and attachment child docs.
    const documents: DocumentInput[] = [];
    const emittedDayKeys = new Set<string>();
    for (const [key, { chatIdentifier, date, chatInfo }] of affectedDays) {
      documents.push(
        ...(await this.buildDayDocuments(db, chatIdentifier, date, chatInfo, cutoffNs)),
      );
      emittedDayKeys.add(key);
    }

    // Queue size for this cycle: messages with ROWID > cursor at cycle
    // start. Pinned in cursor across pages so the progress bar's `total`
    // stays stable. Bootstrap counts everything (queue = all messages);
    // incremental counts just the rows added since last cursor.
    let totalMessages: number | undefined = state?.cycleQueueTotal;
    if (totalMessages === undefined) {
      try {
        if (cutoffNs !== null) {
          const countRow = db
            .prepare("SELECT COUNT(*) as count FROM message WHERE ROWID > ? AND date >= ?")
            .get(lastRowId, cutoffNs) as { count: number };
          totalMessages = countRow.count;
        } else {
          const countRow = db
            .prepare("SELECT COUNT(*) as count FROM message WHERE ROWID > ?")
            .get(lastRowId) as { count: number };
          totalMessages = countRow.count;
        }
      } catch {
        // ignore
      }
    }

    // Snapshot reconciliation: when the cursor has caught up to the tail,
    // enumerate the complete current source ID set (parent day docs AND
    // attachment child docs). The same scan computes per-day content
    // signatures; if a day changed without a new ROWID (edit, unsend,
    // tapback removal, local attachment file arrival, a contact renamed in
    // the Mac's Contacts), re-emit just that day.
    let presentExternalIds: string[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    let daySignatures = state?.lastDaySignatures;
    if (!hasMore) {
      const reconciled = await this.reconcileSnapshot(db, cutoffNs, state, emittedDayKeys);
      documents.push(...reconciled.documents);
      ({ presentExternalIds, snapshotSignature, daySignatures } = reconciled);
    }

    log.info(
      `Sync produced ${documents.length} docs from ${pageRows.length} messages (${isBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore}, snapshot: ${presentExternalIds?.length ?? "unchanged"})`,
    );
    this.offerPreviews(db, !hasMore);

    return {
      documents,
      deletedExternalIds: [], // iMessage hard-deletes rows; snapshot path catches them gateway-side
      presentExternalIds,
      issues: hasMore ? undefined : this.transcriptionIssues(),
      cursor: {
        lastRowId: maxRowId,
        cycleQueueTotal: hasMore ? totalMessages : undefined,
        lastSnapshotSignature: snapshotSignature,
        lastDaySignatures: daySignatures,
      } satisfies AppleIMessageSyncCursor,
      hasMore,
      progress: imessageProgress(
        isBootstrap ? "bootstrap" : "incremental",
        parsed.length,
        totalMessages !== undefined && totalMessages > 0 ? totalMessages : undefined,
      ),
    };
  }

  /**
   * Fetch the participant roster (handle id strings — phones/emails) for a
   * chat, keyed by `chat.chat_identifier`, memoised per sync run via
   * `cache`. Lists every member of a group chat as a participant, including
   * those who sent nothing that day. Self is naturally excluded — `handle`
   * rows are the other parties; the local account is `message.is_from_me`,
   * never a handle row. Ordered for a deterministic participant list.
   */
  private fetchChatRoster(db: Db, chatIdentifier: string, cache: Map<string, string[]>): string[] {
    const cached = cache.get(chatIdentifier);
    if (cached) return cached;
    const rows = db
      .prepare(
        `SELECT DISTINCT h.id as handle
           FROM chat c
           JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
           JOIN handle h ON h.ROWID = chj.handle_id
          WHERE c.chat_identifier = ? AND h.id IS NOT NULL
          ORDER BY h.id ASC`,
      )
      .all(chatIdentifier) as { handle: string }[];
    const handles = rows.map((r) => r.handle).filter((h) => h.length > 0);
    cache.set(chatIdentifier, handles);
    return handles;
  }

  private getSchemaColumns(db: Db): IMessageSchemaColumns {
    if (this.schemaColumns && this.schemaColumnsDb === db) return this.schemaColumns;
    const rows = db.prepare("PRAGMA table_info(message)").all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    this.schemaColumns = {
      cacheHasAttachments: names.has("cache_has_attachments"),
      associatedMessageEmoji: names.has("associated_message_emoji"),
      replyToGuid: names.has("reply_to_guid"),
      threadOriginatorGuid: names.has("thread_originator_guid"),
      groupTitle: names.has("group_title"),
    };
    this.schemaColumnsDb = db;
    return this.schemaColumns;
  }

  private fetchMessageRows(
    db: Db,
    whereClause: string,
    params: ReadonlyArray<number | string>,
  ): RawIMessage[] {
    const columns = this.getSchemaColumns(db);
    const sql = `SELECT
        m.ROWID as rowId,
        m.guid,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me as isFromMe,
        m.is_system_message as isSystemMessage,
        m.handle_id as handleId,
        m.service,
        ${
          columns.cacheHasAttachments
            ? "m.cache_has_attachments"
            : "EXISTS (SELECT 1 FROM message_attachment_join maj2 WHERE maj2.message_id = m.ROWID)"
        } as cacheHasAttachments,
        m.associated_message_guid as associatedMessageGuid,
        m.associated_message_type as associatedMessageType,
        ${
          columns.associatedMessageEmoji ? "m.associated_message_emoji" : "NULL"
        } as associatedMessageEmoji,
        ${columns.replyToGuid ? "m.reply_to_guid" : "NULL"} as replyToGuid,
        ${
          columns.threadOriginatorGuid ? "m.thread_originator_guid" : "NULL"
        } as threadOriginatorGuid,
        ${columns.groupTitle ? "m.group_title" : "NULL"} as groupTitle,
        c.chat_identifier as chatIdentifier,
        c.display_name as chatDisplayName,
        c.style as chatStyle,
        COALESCE(hc.handleCount, 0) as chatHandleCount,
        h.id as contactId
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      LEFT JOIN (
        SELECT chat_id, COUNT(DISTINCT handle_id) AS handleCount
        FROM chat_handle_join
        GROUP BY chat_id
      ) hc ON hc.chat_id = c.ROWID
      ${whereClause}`;
    return db.prepare(sql).all(...params) as RawIMessage[];
  }

  /**
   * Fetch attachment rows for a batch of message ROWIDs and group them by
   * `messageRowId`. Returns an empty map when `rowIds` is empty (avoids
   * binding an empty IN list).
   */
  private fetchAttachmentsForMessages(
    db: Db,
    rowIds: ReadonlyArray<number>,
  ): Map<number, RawIMessageAttachment[]> {
    const result = new Map<number, RawIMessageAttachment[]>();
    if (rowIds.length === 0) return result;
    for (let offset = 0; offset < rowIds.length; offset += PAGE_SIZE) {
      const batch = rowIds.slice(offset, offset + PAGE_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const attRows = db
        .prepare(
          `SELECT
             a.ROWID as attachmentRowId,
             a.guid as guid,
             maj.message_id as messageRowId,
             a.filename,
             a.mime_type as mimeType,
             a.uti as uti,
             a.transfer_name as transferName,
             a.total_bytes as totalBytes
           FROM message_attachment_join maj
           JOIN attachment a ON maj.attachment_id = a.ROWID
           WHERE maj.message_id IN (${placeholders})
           ORDER BY maj.message_id ASC, a.ROWID ASC`,
        )
        .all(...batch) as IMessageAttachmentRow[];
      for (const row of attRows) {
        const att = resolveIMessageAttachment(row);
        if (!result.has(att.messageRowId)) result.set(att.messageRowId, []);
        result.get(att.messageRowId)!.push(att);
      }
    }
    return result;
  }

  private resolveAffectedDayForRow(
    db: Db,
    row: RawIMessage,
    cutoffNs: number | null,
    rosterCache: Map<string, string[]>,
  ): { key: string; chatIdentifier: string; date: string; chatInfo: IMessageChatInfo } | null {
    let docRow = row;
    if (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      if (!targetGuid) return null;
      const targetRows = this.fetchMessageRows(
        db,
        "WHERE m.guid = ? AND c.chat_identifier IS NOT NULL LIMIT 1",
        [targetGuid],
      );
      const target = targetRows[0];
      if (!target || !isRenderableMessageRow(target)) return null;
      docRow = target;
    }

    if (cutoffNs !== null && docRow.date < cutoffNs) return null;

    const date = formatDateKey(imessageDateToDate(docRow.date));
    const key = `${docRow.chatIdentifier}:${date}`;
    return {
      key,
      chatIdentifier: docRow.chatIdentifier,
      date,
      chatInfo: this.chatInfoFromRow(db, docRow, rosterCache),
    };
  }

  private chatInfoFromRow(
    db: Db,
    row: RawIMessage,
    rosterCache: Map<string, string[]>,
  ): IMessageChatInfo {
    // Derive isGroup from `COUNT(DISTINCT handle_id)` rather than chat.style —
    // Apple's style constants flipped meaning across macOS versions.
    const isGroup = row.chatHandleCount > 1;
    const participantHandles = isGroup
      ? this.fetchChatRoster(db, row.chatIdentifier, rosterCache)
      : undefined;
    return {
      chatIdentifier: row.chatIdentifier,
      displayName: row.chatDisplayName,
      isGroup,
      service: row.service ?? "iMessage",
      participantHandles,
      handleNames: this.handleNames(participantHandles ?? [row.chatIdentifier]),
    };
  }

  /** The contact names of these handles, for the ones a single card names. */
  private handleNames(handles: readonly string[]): Record<string, string> | undefined {
    let names: Record<string, string> | undefined;
    for (const handle of handles) {
      const name = this.names.nameFor(handle);
      if (name) (names ??= {})[handle] = name;
    }
    return names;
  }

  /**
   * The contact-names part of a day signature: every handle the day renders
   * or mentions that a contact names, with that name. `undefined` when none
   * is named, so a Mac without Contacts keeps the signatures it had.
   */
  private namesSignature(handles: ReadonlySet<string> | undefined): string | undefined {
    if (!handles) return undefined;
    const named: string[] = [];
    for (const handle of handles) {
      const name = this.names.nameFor(handle);
      if (name) named.push(`${handle}\u0000${name}`);
    }
    return named.length > 0 ? computeContentHash(named.sort().join("\n")) : undefined;
  }

  private async buildDayDocuments(
    db: Db,
    chatIdentifier: string,
    date: string,
    chatInfo: IMessageChatInfo | null,
    cutoffNs: number | null,
  ): Promise<DocumentInput[]> {
    const rosterCache = new Map<string, string[]>();
    const { rows, attMap } = this.fetchRenderableRowsForDay(db, chatIdentifier, date, cutoffNs);
    if (rows.length === 0) return [];

    const info = chatInfo ?? this.chatInfoFromRow(db, rows[0], rosterCache);
    const tapbackRows = this.fetchTapbacksForTargets(
      db,
      chatIdentifier,
      rows.map((r) => r.guid),
    );
    const dayParsed = [...rows, ...tapbackRows]
      .map((row) => this.parseMessageRow(row, attMap))
      .filter((msg): msg is ParsedIMessage => msg !== null);

    if (dayParsed.length === 0) return [];

    // Transcribe voice clips inline before rendering, so the spoken text lands
    // in the conversation document and is searchable.
    await this.transcribeDayAudio(dayParsed, info, `${chatIdentifier}:${date}`);

    const doc = normalizeDayChat(
      date,
      dayParsed,
      info,
      this.providerId,
      this.id,
      this.isTranscriptionVocabularyEnabled?.() === true,
    );
    const attachmentDocs = await this.extractAttachments(doc, dayParsed, attMap, info);
    return [doc, ...attachmentDocs];
  }

  private fetchRenderableRowsForDay(
    db: Db,
    chatIdentifier: string,
    date: string,
    cutoffNs: number | null,
  ): { rows: RawIMessage[]; attMap: Map<number, RawIMessageAttachment[]> } {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayStartNs = isoToImessageNs(dayStart.toISOString());
    const dayEndNs = isoToImessageNs(dayEnd.toISOString());
    const lowerBound = cutoffNs === null ? dayStartNs : Math.max(dayStartNs, cutoffNs);

    const rows = this.fetchMessageRows(
      db,
      "WHERE c.chat_identifier = ? AND m.date >= ? AND m.date < ? ORDER BY m.ROWID ASC",
      [chatIdentifier, lowerBound, dayEndNs],
    ).filter(isRenderableMessageRow);
    return {
      rows,
      attMap: this.fetchAttachmentsForMessages(
        db,
        rows.map((r) => r.rowId),
      ),
    };
  }

  private fetchTapbacksForTargets(
    db: Db,
    chatIdentifier: string,
    targetGuids: ReadonlyArray<string>,
  ): RawIMessage[] {
    if (targetGuids.length === 0) return [];
    const targetSet = new Set(targetGuids);
    return this.fetchMessageRows(
      db,
      `WHERE c.chat_identifier = ?
         AND (
           (m.associated_message_type >= 2000 AND m.associated_message_type <= 2006)
           OR (m.associated_message_type >= 3000 AND m.associated_message_type <= 3006)
         )
       ORDER BY m.date ASC, m.ROWID ASC`,
      [chatIdentifier],
    ).filter((row) => {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      return targetGuid !== null && targetSet.has(targetGuid);
    });
  }

  private parseMessageRow(
    row: RawIMessage,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): ParsedIMessage | null {
    if (!row.chatIdentifier) return null;

    let text = row.text ?? "";
    if (!text && row.attributedBody) {
      text = parseAttributedBody(row.attributedBody) ?? "";
    }

    const attachments = (attMap.get(row.rowId) ?? []).map((a) => ({
      guid: a.guid ?? undefined,
      filename: imessageAttachmentFilename(a),
      mimeType: a.mimeType,
      filePath: a.filename,
      totalBytes: a.totalBytes,
    }));

    let tapback: ParsedIMessage["tapback"];
    if (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      const label = getTapbackLabel(row.associatedMessageType, row.associatedMessageEmoji);
      if (targetGuid && label) {
        tapback = {
          type: label,
          targetGuid,
          emoji: row.associatedMessageEmoji ?? undefined,
          action: isTapbackRemoval(row.associatedMessageType) ? "remove" : "add",
        };
      }
    }

    return {
      rowId: row.rowId,
      guid: row.guid,
      text,
      date: imessageDateToDate(row.date),
      isFromMe: !!row.isFromMe,
      isSystemMessage: !!row.isSystemMessage,
      sender: row.isFromMe ? "You" : (row.contactId ?? "Unknown"),
      service: row.service ?? "iMessage",
      attachments,
      tapback,
      replyToGuid: row.replyToGuid ?? undefined,
      threadOriginatorGuid: row.threadOriginatorGuid ?? undefined,
      contactId: row.contactId ?? undefined,
      senderName: row.isFromMe ? undefined : this.names.nameFor(row.contactId),
    };
  }

  private buildIMessageSnapshot(db: Db, cutoffNs: number | null): IMessageDaySnapshot {
    const rows = this.fetchMessageRows(
      db,
      "WHERE c.chat_identifier IS NOT NULL ORDER BY c.chat_identifier ASC, m.date ASC, m.ROWID ASC",
      [],
    );
    const renderableRows = rows.filter(
      (row) => isRenderableMessageRow(row) && (cutoffNs === null || row.date >= cutoffNs),
    );
    const rowsByGuid = new Map(renderableRows.map((row) => [row.guid, row]));
    const dayParts = new Map<string, string[]>();
    const dayRows = new Map<string, RawIMessage[]>();
    /** Every handle a day's document names: its chat's, and its senders'. */
    const dayHandles = new Map<string, Set<string>>();
    const rosterCache = new Map<string, string[]>();

    for (const row of renderableRows) {
      const key = dayKeyForRow(row);
      const parts = dayParts.get(key) ?? [];
      parts.push(messageSignaturePart(row));
      const roster =
        row.chatHandleCount > 1
          ? this.fetchChatRoster(db, row.chatIdentifier, rosterCache)
          : undefined;
      if (roster) {
        parts.push(`roster:${roster.join("\u0000")}`);
      }
      dayParts.set(key, parts);

      let handles = dayHandles.get(key);
      if (!handles) {
        handles = new Set(roster ?? [row.chatIdentifier]);
        dayHandles.set(key, handles);
      }
      if (!row.isFromMe && row.contactId) handles.add(row.contactId);

      const groupedRows = dayRows.get(key) ?? [];
      groupedRows.push(row);
      dayRows.set(key, groupedRows);
    }

    for (const row of rows) {
      if (!isTapback(row.associatedMessageType) && !isTapbackRemoval(row.associatedMessageType)) {
        continue;
      }
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      if (!targetGuid) continue;
      const target = rowsByGuid.get(targetGuid);
      if (!target) continue;
      const key = dayKeyForRow(target);
      const parts = dayParts.get(key) ?? [];
      parts.push(tapbackSignaturePart(row));
      dayParts.set(key, parts);
      if (!row.isFromMe && row.contactId) dayHandles.get(key)?.add(row.contactId);
    }

    const attMap = this.fetchAttachmentsForMessages(
      db,
      renderableRows.map((row) => row.rowId),
    );
    for (const [key, groupedRows] of dayRows) {
      const parts = dayParts.get(key) ?? [];
      for (const row of groupedRows) {
        for (const att of attMap.get(row.rowId) ?? []) {
          parts.push(attachmentSignaturePart(att));
        }
      }
      dayParts.set(key, parts);
    }

    const daySignatures: Record<string, string> = {};
    const externalIds: string[] = [];
    for (const [key, parts] of Array.from(dayParts.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const contentSignature = computeContentHash(parts.sort().join("\n"));
      const names = this.namesSignature(dayHandles.get(key));
      daySignatures[key] = names
        ? `${contentSignature}${DAY_SIGNATURE_NAMES_SEPARATOR}${names}`
        : contentSignature;
      externalIds.push(key);
      if (this.attachmentConfig.enabled) {
        externalIds.push(
          ...this.enumerateAttachmentExternalIdsForDay(key, dayRows.get(key) ?? [], attMap),
        );
      }
    }
    externalIds.sort();
    const signature = computeContentHash(
      Object.entries(daySignatures)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, sig]) => `${key}\u0000${sig}`)
        .join("\n") + `\nids\n${externalIds.join("\n")}`,
    );

    return { externalIds, daySignatures, signature };
  }

  /**
   * Snapshot reconciliation, run once the cursor has caught up to the tail:
   * enumerate the complete current source ID set (parent day docs AND
   * attachment child docs), re-emit the days whose signature changed without
   * a new ROWID, and retry the voice clips that are due.
   *
   * Days renamed beyond this run's share keep their previous signature, and
   * the snapshot signature is left unset, so the next run compares again and
   * takes the next share.
   */
  private async reconcileSnapshot(
    db: Db,
    cutoffNs: number | null,
    state: AppleIMessageSyncCursor | null,
    emittedDayKeys: Set<string>,
  ): Promise<IMessageSnapshotReconciliation> {
    const documents: DocumentInput[] = [];
    const newSnapshot = this.buildIMessageSnapshot(db, cutoffNs);
    let presentExternalIds: string[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    let daySignatures = state?.lastDaySignatures;
    if (newSnapshot.signature !== state?.lastSnapshotSignature) {
      presentExternalIds = newSnapshot.externalIds;
      const rebuilt = await this.rebuildChangedDays(
        db,
        cutoffNs,
        state?.lastDaySignatures,
        newSnapshot.daySignatures,
        emittedDayKeys,
        state !== null && state.lastDaySignatures === undefined,
      );
      documents.push(...rebuilt.documents);
      daySignatures = newSnapshot.daySignatures;
      snapshotSignature = newSnapshot.signature;
      if (rebuilt.deferred.length > 0) {
        daySignatures = { ...newSnapshot.daySignatures };
        for (const key of rebuilt.deferred) {
          const previous = state?.lastDaySignatures?.[key];
          if (previous !== undefined) daySignatures[key] = previous;
        }
        snapshotSignature = undefined;
        log.info(
          `Contact names changed on ${rebuilt.deferred.length} more day-chats than one run re-renders; they follow on the next syncs`,
        );
      }
    }
    documents.push(
      ...(await this.rebuildDueTranscriptionDays(
        db,
        cutoffNs,
        newSnapshot.daySignatures,
        emittedDayKeys,
      )),
    );
    return { documents, presentExternalIds, snapshotSignature, daySignatures };
  }

  /**
   * Re-emit the days whose signature changed. A day whose messages are
   * unchanged and only its contact names differ is renamed: at most
   * `MAX_RENAMED_DAYS_PER_RUN` of those are rebuilt, newest first, and the
   * rest come back as `deferred`.
   */
  private async rebuildChangedDays(
    db: Db,
    cutoffNs: number | null,
    previous: Record<string, string> | undefined,
    current: Record<string, string>,
    alreadyEmitted: Set<string>,
    rebuildAllWhenPreviousMissing = false,
  ): Promise<{ documents: DocumentInput[]; deferred: string[] }> {
    if (!previous && !rebuildAllWhenPreviousMissing) return { documents: [], deferred: [] };
    const changed: string[] = [];
    const renamed: string[] = [];
    for (const [key, signature] of Object.entries(current)) {
      if (alreadyEmitted.has(key)) continue;
      const before = previous?.[key];
      if (before === signature) continue;
      if (before !== undefined && daySignatureContent(before) === daySignatureContent(signature)) {
        renamed.push(key);
      } else {
        changed.push(key);
      }
    }
    renamed.sort((a, b) => b.slice(-10).localeCompare(a.slice(-10)) || a.localeCompare(b));
    const deferred = renamed.slice(MAX_RENAMED_DAYS_PER_RUN);

    const documents: DocumentInput[] = [];
    for (const key of [...changed, ...renamed.slice(0, MAX_RENAMED_DAYS_PER_RUN)]) {
      const parsed = parseDayExternalId(key);
      if (!parsed) continue;
      documents.push(
        ...(await this.buildDayDocuments(db, parsed.chatIdentifier, parsed.date, null, cutoffNs)),
      );
      alreadyEmitted.add(key);
    }
    return { documents, deferred };
  }

  /**
   * Re-render the day-chats holding a voice clip whose next transcription
   * attempt is due, so a clip is retried on its schedule rather than when its
   * day happens to change. A day the snapshot no longer lists has nothing
   * left to retry.
   */
  private async rebuildDueTranscriptionDays(
    db: Db,
    cutoffNs: number | null,
    current: Record<string, string>,
    alreadyEmitted: Set<string>,
  ): Promise<DocumentInput[]> {
    if (!this.transcribeAudio || !this.hasTranscriptSidecar()) return [];
    const cache = this.getTranscriptCache();
    const documents: DocumentInput[] = [];
    for (const key of cache.dueDayKeys(Date.now(), MAX_DUE_TRANSCRIPTION_DAYS_PER_RUN)) {
      if (alreadyEmitted.has(key)) continue;
      const parsed = key in current ? parseDayExternalId(key) : null;
      const dayDocuments = parsed
        ? await this.buildDayDocuments(db, parsed.chatIdentifier, parsed.date, null, cutoffNs)
        : [];
      // A day that renders nothing has no clip left to retry.
      if (dayDocuments.length === 0) {
        cache.forgetDay(key);
        continue;
      }
      documents.push(...dayDocuments);
      alreadyEmitted.add(key);
    }
    return documents;
  }

  /** The voice-clip backlog as the sync issues a completed run reports. */
  private transcriptionIssues(): SyncIssue[] {
    if (!this.transcribeAudio || !this.hasTranscriptSidecar()) return [];
    const backlog = this.getTranscriptCache().backlog();
    return transcriptionSyncIssues({ ...backlog, unavailable: 0 }, "voice clips");
  }

  /**
   * Whether a transcript sidecar exists to consult: opened by this instance,
   * or left on disk by an earlier run. A source that has never met a voice
   * clip has neither, and so has nothing pending and no sidecar to create.
   */
  private hasTranscriptSidecar(): boolean {
    if (this.transcriptCache) return true;
    return (
      this.configDir !== undefined &&
      existsSync(join(this.configDir, "apple-imessage", "transcripts.db"))
    );
  }

  private enumerateAttachmentExternalIdsForDay(
    parentExternalId: string,
    rows: ReadonlyArray<RawIMessage>,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): string[] {
    const entries = this.collectEligibleAttachmentEntries(rows, attMap);
    return assignAttachmentSeqs(
      entries,
      (entry) => ({
        filename: entry.filename,
        sizeBytes: entry.raw.totalBytes,
        mimeType: entry.mimeType,
      }),
      (entry) => `${entry.raw.guid ?? ""}:${entry.raw.attachmentRowId}`,
    ).map(({ item, seq }) => {
      const stableId = deriveAttachmentStableId(
        item.filename,
        item.raw.totalBytes,
        item.mimeType,
        seq,
      );
      return `${parentExternalId}/att/${stableId}`;
    });
  }

  private collectEligibleAttachmentEntries(
    rows: ReadonlyArray<RawIMessage>,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): IMessageAttachmentEntry[] {
    const entries: IMessageAttachmentEntry[] = [];
    for (const row of rows) {
      const parsed = this.parseMessageRow(row, attMap);
      if (!parsed || parsed.tapback) continue;
      for (const raw of attMap.get(row.rowId) ?? []) {
        const entry = this.attachmentChildEntry(raw);
        if (entry) entries.push(entry);
      }
    }
    return entries;
  }

  /**
   * The attachment as a child document, or null when it does not become one:
   * a file whose text can be extracted, and every photo, video and PDF
   * whether or not it has text (see `extractAttachments`). The one test both
   * the documents and the snapshot's id list use, so `seq` — numbered within
   * this set — agrees between them, and a media child is never pruned for
   * being missing from the snapshot.
   *
   * Widening the set to media keeps every earlier child's `seq`: a tie group
   * shares its filename, size and MIME type, and so its eligibility.
   */
  private attachmentChildEntry(raw: RawIMessageAttachment): IMessageAttachmentEntry | null {
    const mimeType = raw.mimeType;
    if (!mimeType) return null;
    const media = mediaAttachmentNoun(mimeType) !== undefined;
    if (!media && !shouldExtractAttachment(mimeType, raw.totalBytes, this.attachmentConfig).extract)
      return null;
    return { raw, filename: imessageAttachmentFilename(raw), mimeType };
  }

  /**
   * Transcribe the audio attachments in a day-chat, setting `transcript` and
   * `durationSec` in place on each `IMessageAttachmentInfo` so the normalizer
   * renders the spoken text inline, and `transcription` on each clip left
   * without one so the placeholder says why. A no-op when no transcriber is
   * wired (STT off) — audio then keeps its `[Audio: filename]` placeholder.
   *
   * The transcript sidecar (`transcripts.db` under configDir) is consulted
   * first so a re-sync of the same day reuses prior transcripts rather than
   * re-running Whisper. A clip the transcriber could not handle — no
   * transcriber assigned, the backend down, a read that failed — is recorded
   * there as pending with a backoff, is left alone until it is due, and has
   * its day re-rendered then; the page it is on completes either way. A clip
   * whose bytes decode to no audio is recorded there as unreadable and is not
   * sent again while the file is unchanged.
   */
  private async transcribeDayAudio(
    dayParsed: ParsedIMessage[],
    chat: IMessageChatInfo,
    dayKey: string,
  ): Promise<void> {
    if (!this.transcribeAudio) return;
    const handles = [
      ...new Set([
        ...(chat.participantHandles ?? []),
        ...dayParsed.filter((message) => !message.isFromMe).map((message) => message.sender),
        ...(!chat.isGroup ? [chat.chatIdentifier] : []),
      ]),
    ].slice(0, 31);
    const participants = [
      { isSelf: true },
      ...handles.map((handle) => ({ identifiers: imessagePersonIdentifiers(handle) })),
    ];
    const now = Date.now();
    /** Clips this pass left pending; the rest of the day's pending rows are stale. */
    const stillPending: string[] = [];
    /** Clips this pass found unreadable; the rest of the day's unreadable rows are stale. */
    const stillUnreadable: string[] = [];
    let sawAudio = false;

    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      for (const att of msg.attachments) {
        const mimeType = att.mimeType;
        if (!mimeType || !mimeType.startsWith("audio/")) continue;
        if (att.transcript !== undefined) {
          if (att.transcript === "") att.transcription = "no-speech";
          continue; // already set this run
        }
        if (!att.filePath) continue;
        sawAudio = true;

        const filePath = resolveAttachmentPath(att.filePath);
        if (!filePath || !existsSync(filePath)) {
          if (filePath)
            log.debug(`Audio attachment file not found, skipping transcription: ${filePath}`);
          att.transcription = "audio-missing";
          continue;
        }

        let mtimeMs: number | undefined;
        try {
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          // The read below will surface the real failure if the file vanished.
        }

        // Key by Apple attachment GUID when possible, falling back to the
        // historical file-path key so older transcript sidecars still hit.
        const cache = this.getTranscriptCache();
        const cacheKey = att.guid ?? att.filePath;
        const legacyKey = att.guid && att.filePath ? att.filePath : undefined;
        const cached =
          cache.get(cacheKey, att.totalBytes, mtimeMs) ??
          (legacyKey ? cache.get(legacyKey, att.totalBytes, mtimeMs) : undefined);
        if (cached) {
          att.transcript = cached.transcript;
          att.durationSec = cached.durationSec;
          if (cached.transcript === "") att.transcription = "no-speech";
          if (legacyKey) cache.set(cacheKey, att.totalBytes, mtimeMs, cached);
          continue;
        }

        // The same bytes decode the same way: not sent again until the file
        // changes or the source is resynced.
        if (cache.isUnreadable(cacheKey, att.totalBytes, mtimeMs)) {
          att.transcription = "audio-unreadable";
          stillUnreadable.push(cacheKey);
          continue;
        }

        const pending = cache.pending(cacheKey);
        if (pending && pending.nextAttemptMs > now) {
          att.transcription =
            pending.lastError === TRANSCRIBER_UNAVAILABLE ? "transcriber-unavailable" : "awaiting";
          stillPending.push(cacheKey);
          continue;
        }

        att.transcription = "awaiting";
        try {
          const data = new Uint8Array(await readFile(filePath));
          const result = await this.transcribeAudio(data, mimeType, {
            context: {
              purpose: "source-audio",
              speaker: msg.isFromMe
                ? { isSelf: true }
                : { identifiers: imessagePersonIdentifiers(msg.sender) },
              conversation: { sourceId: this.id, threadId: chat.chatIdentifier },
              participants,
              recordedAt: msg.date.toISOString(),
            },
          });
          // `null` = no transcriber can run. The clip is retried on the
          // backoff; it transcribes once a model is assigned.
          if (result === null) {
            cache.recordFailure(cacheKey, dayKey, TRANSCRIBER_UNAVAILABLE, now);
            att.transcription = "transcriber-unavailable";
            stillPending.push(cacheKey);
            continue;
          }
          const transcript = result.text.trim();
          att.transcript = transcript;
          att.durationSec = result.durationSec;
          // `""` (no speech detected) is a valid cached value and isn't retried.
          if (transcript === "") att.transcription = "no-speech";
          cache.set(cacheKey, att.totalBytes, mtimeMs, {
            transcript,
            durationSec: result.durationSec,
          });
        } catch (err) {
          if (err instanceof AudioUnreadableError) {
            log.debug(`Audio ${att.filename} could not be decoded; not sending it again`);
            cache.recordUnreadable(cacheKey, dayKey, att.totalBytes, mtimeMs);
            att.transcription = "audio-unreadable";
            stillUnreadable.push(cacheKey);
            continue;
          }
          // A transcription-backend blip (gateway unreachable / 5xx) or a
          // file that could not be read: the page goes on with the
          // placeholder, and the clip is retried on its own schedule.
          const message = err instanceof Error ? err.message : String(err);
          log.debug(`Failed to transcribe audio ${att.filename}: ${message}`);
          cache.recordFailure(cacheKey, dayKey, message, now);
          stillPending.push(cacheKey);
        }
      }
    }

    // Only the clips this pass saw and left pending keep the day due: a clip
    // that left the chat, or was transcribed through its other key, must not
    // hold it, nor stay reported as unreadable. A day with audio opened the
    // sidecar; a due day without any audio left is cleared through the
    // sidecar the sweep already opened.
    const sidecar = sawAudio ? this.getTranscriptCache() : this.transcriptCache;
    sidecar?.retainForDay(dayKey, stillPending, stillUnreadable);
  }

  /** Lazily open the transcript sidecar on first use. */
  private getTranscriptCache(): IMessageTranscriptCache {
    if (!this.transcriptCache) {
      this.transcriptCache = new IMessageTranscriptCache(this.configDir);
    }
    return this.transcriptCache;
  }

  /** Close the transcript sidecar. Called by the source instance's dispose. */
  dispose(): void {
    this.transcriptCache?.close();
    this.transcriptCache = undefined;
    this.previewLedger?.close();
    this.previewLedger = undefined;
  }

  /** Remember a media document this pass wrote, for `offerPreviews`. */
  private notePreviewCandidate(
    externalId: string,
    parentDoc: DocumentInput,
    att: RawIMessageAttachment,
    mimeType: string,
    msg: ParsedIMessage,
  ): void {
    if (!this.previews) return;
    this.previewCandidates.push({
      key: previewKey(att),
      externalId,
      dayKey: parentDoc.externalId,
      storedPath: att.filename,
      mimeType,
      sentAtMs: msg.date.getTime(),
    });
  }

  /**
   * Offer the thumbnails of the media documents this pass wrote, newest
   * first, skipping a file the ledger has already settled and one that is not
   * on disk (offloaded to iCloud): its arrival changes the day's signature,
   * which writes the day again and offers it then. At most
   * `MAX_PREVIEW_OFFERS_PER_PASS` are offered; the rest are left in the
   * ledger, due at once. Once the walk has reached the tail, the deferred
   * thumbnails that are due take what is left of the share.
   *
   * The offers are made, not awaited: each waits for this pass's page to be
   * written, so its answer arrives after the pass returns and is written to
   * the ledger then.
   */
  private offerPreviews(db: Db, includeDue: boolean): void {
    const candidates = this.previewCandidates;
    this.previewCandidates = [];
    const sink = this.previews;
    if (!sink) return;
    const ledger = this.getPreviewLedger();
    if (!ledger) return;
    const nowMs = Date.now();
    candidates.sort((a, b) => b.sentAtMs - a.sentAtMs);
    const seen = new Set<string>();
    let offered = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      const filePath = resolveAttachmentPath(candidate.storedPath);
      const fileSignature = attachmentFileSignature(candidate.storedPath);
      if (!filePath || !fileSignature.startsWith("file:")) continue;
      if (!ledger.shouldOffer(candidate.key, fileSignature, nowMs)) continue;
      const entry: PreviewLedgerEntry = {
        key: candidate.key,
        externalId: candidate.externalId,
        dayKey: candidate.dayKey,
        fileSignature,
      };
      if (offered >= MAX_PREVIEW_OFFERS_PER_PASS) {
        ledger.markWaiting(entry, nowMs);
        continue;
      }
      this.offerPreview(sink, ledger, entry, filePath, candidate.mimeType, nowMs);
      offered++;
    }
    if (includeDue) {
      this.offerDuePreviews(db, sink, ledger, MAX_PREVIEW_OFFERS_PER_PASS - offered, nowMs);
    }
  }

  /**
   * Offer again the deferred thumbnails whose next attempt is due, reading
   * each attachment's file afresh from chat.db. One whose attachment is gone,
   * or whose file is not on disk, is forgotten: a file that arrives later
   * rewrites its day, which offers it then.
   */
  private offerDuePreviews(
    db: Db,
    sink: SourcePreviewSink,
    ledger: IMessagePreviewLedger,
    limit: number,
    nowMs: number,
  ): void {
    for (const entry of ledger.due(nowMs, limit)) {
      const att = lookupAttachment(db, entry.key);
      const filePath = att ? resolveAttachmentPath(att.filename) : null;
      const fileSignature = att ? attachmentFileSignature(att.filename) : "missing";
      if (
        !att ||
        mediaAttachmentNoun(att.mimeType) === undefined ||
        !filePath ||
        !fileSignature.startsWith("file:")
      ) {
        ledger.forget(entry.key);
        continue;
      }
      this.offerPreview(sink, ledger, { ...entry, fileSignature }, filePath, att.mimeType, nowMs);
    }
  }

  private offerPreview(
    sink: SourcePreviewSink,
    ledger: IMessagePreviewLedger,
    entry: PreviewLedgerEntry,
    filePath: string,
    mimeType: string,
    nowMs: number,
  ): void {
    ledger.markOffered(entry, nowMs);
    sink
      .offer({ externalId: entry.externalId, render: () => this.renderPreview(filePath, mimeType) })
      .then(
        (outcome) => {
          // A ledger closed or replaced since has nothing to record this in.
          if (this.previewLedger === ledger) ledger.record(entry.key, entry.fileSignature, outcome);
        },
        (err: unknown) => {
          log.debug(`Thumbnail offer failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
  }

  private getPreviewLedger(): IMessagePreviewLedger | undefined {
    if (this.previewLedger || this.previewLedgerFailed) return this.previewLedger;
    try {
      this.previewLedger = new IMessagePreviewLedger(this.previewLedgerPath ?? ":memory:");
    } catch (err) {
      this.previewLedgerFailed = true;
      log.warn(
        `Could not open the thumbnail ledger; no thumbnails this run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.previewLedger;
  }

  /**
   * Turn a day-chat's attachments into child documents, and add their
   * markers and metadata to the parent. Returns the children.
   *
   * A file with extracted text becomes a child holding that text. A photo,
   * video or PDF with no text to read — read and found empty, a type nothing
   * reads, too large to read, no OCR configured — becomes a child holding a
   * line that says what it is (`describeMediaAttachment`). Both share an
   * externalId, so a file that later yields text replaces its description in
   * place.
   *
   * A read that failed — the file not on disk (offloaded to iCloud), the
   * extractor or OCR backend erroring — emits no child at all. Its id stays
   * in the snapshot (`attachmentChildEntry`), so whatever child an earlier
   * read left, text or description, is kept rather than overwritten or
   * pruned, and the day is rendered again once the file changes.
   *
   * Each child links to the message that carried it, which opens Messages at
   * that message; the parent's markers stay plain text, because a link in
   * content would become a link edge of its own.
   */
  private async extractAttachments(
    parentDoc: DocumentInput,
    dayParsed: ParsedIMessage[],
    dayAttMap: Map<number, RawIMessageAttachment[]>,
    chat: IMessageChatInfo,
  ): Promise<DocumentInput[]> {
    if (!this.attachmentConfig.enabled) {
      return [];
    }

    const attachmentInfos: AttachmentInfo[] = [];
    const attachmentDocs: DocumentInput[] = [];
    const eligibleEntries: IMessageAttachmentEntry[] = [];
    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      for (const raw of dayAttMap.get(msg.rowId) ?? []) {
        const entry = this.attachmentChildEntry(raw);
        if (entry) eligibleEntries.push(entry);
      }
    }
    const seqByAttachmentRowId = new Map<number, number>();
    for (const { item, seq } of assignAttachmentSeqs(
      eligibleEntries,
      (entry) => ({
        filename: entry.filename,
        sizeBytes: entry.raw.totalBytes,
        mimeType: entry.mimeType,
      }),
      (entry) => `${entry.raw.guid ?? ""}:${entry.raw.attachmentRowId}`,
    )) {
      seqByAttachmentRowId.set(item.raw.attachmentRowId, seq);
    }

    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      const rawAtts = dayAttMap.get(msg.rowId) ?? [];

      for (const att of rawAtts) {
        const filename = imessageAttachmentFilename(att);
        const mimeType = att.mimeType;

        if (!mimeType) {
          attachmentInfos.push({
            filename,
            mimeType: "unknown",
            size: att.totalBytes,
            extracted: false,
            reason: "type-excluded",
          });
          continue;
        }

        const check = shouldExtractAttachment(mimeType, att.totalBytes, this.attachmentConfig);
        const media = mediaAttachmentNoun(mimeType) !== undefined;
        if (!check.extract && !media) {
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: check.reason,
          });
          continue;
        }

        const seq = seqByAttachmentRowId.get(att.attachmentRowId) ?? 0;
        const attachmentId = deriveAttachmentStableId(filename, att.totalBytes, mimeType, seq);
        const childMeta = {
          mimeType,
          sizeBytes: att.totalBytes,
          seq,
          // The parent is a whole day of chat, so its timestamps bound the
          // day rather than dating this file, and its link opens the day's
          // first message. Stamp and link the message that carried it, or
          // every attachment sent that day sorts and opens as if it arrived
          // with the first message.
          occurredAt: msg.date.toISOString(),
          sourceUrl: buildIMessageSourceUrl(msg.guid),
        };

        const outcome: AttachmentReadOutcome = !check.extract
          ? { kind: "nothing-to-read", reason: check.reason }
          : this.extractAttachment
            ? await this.readAttachment(att, filename, mimeType, this.extractAttachment)
            : { kind: "nothing-to-read", reason: "extraction-failed" };
        if (outcome.kind === "text") {
          const child = buildAttachmentDocument(parentDoc, filename, outcome.result, childMeta);
          attachmentDocs.push(child);
          if (media) this.notePreviewCandidate(child.externalId, parentDoc, att, mimeType, msg);
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: true,
            attachmentId,
          });
          continue;
        }

        attachmentInfos.push({
          filename,
          mimeType,
          size: att.totalBytes,
          extracted: false,
          reason: outcome.reason,
          attachmentId,
        });
        if (media && outcome.kind === "nothing-to-read") {
          const child = buildMediaAttachmentDocument(parentDoc, filename, {
            ...childMeta,
            description: describeMediaAttachment(msg, mimeType, chat),
          });
          attachmentDocs.push(child);
          this.notePreviewCandidate(child.externalId, parentDoc, att, mimeType, msg);
        }
      }
    }

    if (attachmentInfos.length > 0) {
      parentDoc.content += formatAttachmentMarkers(attachmentInfos);
      parentDoc.metadata.extra = { ...parentDoc.metadata.extra, attachments: attachmentInfos };
    }

    return attachmentDocs;
  }

  /**
   * Read one attachment from disk and extract its text. A file not on disk is
   * `download-failed`, which the day signature turns into a re-render once
   * the file arrives; an extractor that returns nothing or throws is a failed
   * read too. Only a read that ran and found no text, or that no configured
   * backend could make (`noExtractor`), settles that there is nothing to read.
   * The recorded reason for the latter stays `extraction-failed`, as it was
   * before the extractor could tell the two apart.
   */
  private async readAttachment(
    att: RawIMessageAttachment,
    filename: string,
    mimeType: string,
    extract: AttachmentExtractFn,
  ): Promise<AttachmentReadOutcome> {
    const filePath = att.filename ? resolveAttachmentPath(att.filename) : null;
    if (!filePath) return { kind: "read-failed", reason: "download-failed" };
    if (!existsSync(filePath)) {
      log.debug(`Attachment file not found: ${filePath}`);
      return { kind: "read-failed", reason: "download-failed" };
    }

    try {
      const data = new Uint8Array(await readFile(filePath));
      const result = await extract(data, mimeType, {
        maxTextLength: this.attachmentConfig.maxTextLength,
        reportUnconfigured: true,
      });
      if (!result) return { kind: "read-failed", reason: "extraction-failed" };
      if (result.noExtractor) return { kind: "nothing-to-read", reason: "extraction-failed" };
      if (result.noText) return { kind: "nothing-to-read", reason: "no-text" };
      return { kind: "text", result };
    } catch (err) {
      // Transient extraction-backend blip → fail the page so it retries,
      // rather than recording a permanent extraction failure and advancing
      // the cursor past a file that would extract cleanly later.
      if (isTransientSyncError(err)) throw err;
      log.debug(
        `Failed to extract attachment ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "read-failed", reason: "extraction-failed" };
    }
  }
}

/** An attachment's key in the preview ledger: its GUID, or its row for one without. */
function previewKey(att: RawIMessageAttachment): string {
  return att.guid ?? `rowid:${att.attachmentRowId}`;
}

/** The attachment a preview-ledger key names, as it is in chat.db now. */
function lookupAttachment(db: Db, key: string): RawIMessageAttachment | null {
  const byRow = key.startsWith("rowid:");
  const row = db
    .prepare(
      `SELECT a.ROWID as attachmentRowId, a.guid as guid, 0 as messageRowId, a.filename,
              a.mime_type as mimeType, a.uti as uti, a.transfer_name as transferName,
              a.total_bytes as totalBytes
         FROM attachment a
        WHERE ${byRow ? "a.ROWID = ?" : "a.guid = ?"}`,
    )
    .get(byRow ? Number(key.slice("rowid:".length)) : key) as IMessageAttachmentRow | undefined;
  return row ? resolveIMessageAttachment(row) : null;
}

function getMaxMessageRowId(db: Db): number {
  try {
    const row = db.prepare("SELECT COALESCE(MAX(ROWID), 0) as maxRowId FROM message").get() as {
      maxRowId: number;
    };
    return row.maxRowId;
  } catch {
    return 0;
  }
}

function normalizeAssociatedMessageGuid(guid: string | null): string | null {
  if (!guid) return null;
  return guid.replace(/^(p:\d+\/|bp:)/, "");
}

function isRenderableMessageRow(row: RawIMessage): boolean {
  return !isTapback(row.associatedMessageType) && !isTapbackRemoval(row.associatedMessageType);
}

function dayKeyForRow(row: RawIMessage): string {
  return `${row.chatIdentifier}:${formatDateKey(imessageDateToDate(row.date))}`;
}

function messageSignaturePart(row: RawIMessage): string {
  const attributed =
    row.attributedBody && row.attributedBody.byteLength > 0
      ? computeContentHash(Buffer.from(row.attributedBody).toString("base64"))
      : "";
  return [
    "msg",
    row.rowId,
    row.guid,
    row.date,
    row.isFromMe,
    row.isSystemMessage,
    row.handleId,
    row.service ?? "",
    row.text ?? "",
    attributed,
    row.replyToGuid ?? "",
    row.threadOriginatorGuid ?? "",
    row.groupTitle ?? "",
    row.chatDisplayName ?? "",
    row.chatHandleCount,
    row.contactId ?? "",
  ].join("\u0000");
}

function tapbackSignaturePart(row: RawIMessage): string {
  return [
    "tapback",
    row.rowId,
    row.guid,
    row.date,
    row.isFromMe,
    row.handleId,
    row.associatedMessageGuid ?? "",
    row.associatedMessageType,
    row.associatedMessageEmoji ?? "",
    row.contactId ?? "",
  ].join("\u0000");
}

function attachmentSignaturePart(att: RawIMessageAttachment): string {
  return [
    "att",
    att.messageRowId,
    att.attachmentRowId,
    att.guid ?? "",
    att.filename ?? "",
    att.mimeType ?? "",
    att.transferName ?? "",
    att.totalBytes,
    attachmentFileSignature(att.filename),
  ].join("\u0000");
}

/** The message part of a day signature, without its contact-names part. */
function daySignatureContent(signature: string): string {
  const separator = signature.indexOf(DAY_SIGNATURE_NAMES_SEPARATOR);
  return separator === -1 ? signature : signature.slice(0, separator);
}

function parseDayExternalId(externalId: string): { chatIdentifier: string; date: string } | null {
  const date = externalId.slice(-10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const sep = externalId.slice(-11, -10);
  if (sep !== ":") return null;
  return { chatIdentifier: externalId.slice(0, -11), date };
}
