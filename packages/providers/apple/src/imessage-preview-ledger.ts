// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What became of each iMessage attachment's thumbnail.
 *
 * The source offers a thumbnail when it writes an attachment's document, and
 * a day is written again whenever anything in it changes — a new message, an
 * edit, a tapback. Without a record, every such rewrite would render and
 * upload every photo of the day again. This store remembers, per attachment,
 * the file it last offered (by size and modification time) and how that
 * ended, so an unchanged file is offered once:
 *
 * - `stored`: the gateway has it; not offered again while the file is
 *   unchanged.
 * - `refused`: the gateway would not keep it, or no thumbnail could be made;
 *   not offered again until the file changes.
 * - `deferred`: nothing was decided yet — the offer is in flight, its page
 *   was not written, the gateway was busy, or the per-run cap was reached.
 *   Offered again once its next attempt is due, by `due()`.
 *
 * An offer is written down as `deferred` with its next attempt already
 * scheduled before it is made, so one lost to a crash or a restart is retried
 * on schedule rather than forgotten. A gateway that does not know the
 * document drops the row; a resync clears them all.
 *
 * It holds no image bytes: only the attachment's GUID, its document's id,
 * the day it belongs to, the file's size and modification time, and the
 * schedule.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DocumentPreviewOutcome } from "@omnesis/source-sdk";

/** Seconds before a deferred thumbnail is offered again, by attempt; the last step repeats. */
const RETRY_BACKOFF_SEC = [60, 300, 1800, 7200, 21_600, 43_200];

export interface PreviewLedgerEntry {
  /** The attachment's GUID, or `rowid:<n>` for a row without one. */
  key: string;
  externalId: string;
  dayKey: string;
  fileSignature: string;
}

interface Row {
  attachment_key: string;
  external_id: string;
  day_key: string;
  file_signature: string;
  state: "stored" | "refused" | "deferred";
  attempts: number;
  next_attempt_ms: number | null;
}

export class IMessagePreviewLedger {
  private readonly db: Database.Database;

  /** Opens (and creates) the ledger at `path`; `:memory:` keeps it for the process only. */
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS preview_offers (
          attachment_key TEXT PRIMARY KEY,
          external_id TEXT NOT NULL,
          day_key TEXT NOT NULL,
          file_signature TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('stored', 'refused', 'deferred')),
          attempts INTEGER NOT NULL,
          next_attempt_ms REAL
        );
        CREATE INDEX IF NOT EXISTS preview_offers_due
          ON preview_offers(state, next_attempt_ms);
      `);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /**
   * Whether an attachment whose file now reads `fileSignature` is to be
   * offered: never offered, its file changed since, or deferred and due.
   */
  shouldOffer(key: string, fileSignature: string, nowMs: number): boolean {
    const row = this.row(key);
    if (!row || row.file_signature !== fileSignature) return true;
    return row.state === "deferred" && (row.next_attempt_ms ?? 0) <= nowMs;
  }

  /**
   * Record that the attachment is being offered now, as deferred until its
   * next attempt, so an offer whose answer never comes back is retried.
   */
  markOffered(entry: PreviewLedgerEntry, nowMs: number): void {
    const previous = this.row(entry.key);
    const attempts =
      previous && previous.file_signature === entry.fileSignature ? previous.attempts + 1 : 1;
    const delaySec = RETRY_BACKOFF_SEC[Math.min(attempts - 1, RETRY_BACKOFF_SEC.length - 1)]!;
    this.write(entry, "deferred", attempts, nowMs + delaySec * 1000);
  }

  /** Record an attachment left for a later run, due at once, without counting an attempt. */
  markWaiting(entry: PreviewLedgerEntry, nowMs: number): void {
    const previous = this.row(entry.key);
    const attempts =
      previous && previous.file_signature === entry.fileSignature ? previous.attempts : 0;
    this.write(entry, "deferred", attempts, nowMs);
  }

  /**
   * Record how an offer ended. An answer about a file that has changed since
   * it was offered is ignored: the newer file has an offer of its own.
   */
  record(key: string, fileSignature: string, outcome: DocumentPreviewOutcome): void {
    const row = this.row(key);
    if (!row || row.file_signature !== fileSignature) return;
    if (outcome === "not-found") {
      this.db.prepare("DELETE FROM preview_offers WHERE attachment_key = ?").run(key);
      return;
    }
    // A deferred offer keeps the schedule `markOffered` gave it.
    if (outcome === "deferred") return;
    this.db
      .prepare(
        "UPDATE preview_offers SET state = ?, next_attempt_ms = NULL WHERE attachment_key = ?",
      )
      .run(outcome, key);
  }

  /** Deferred attachments whose next attempt is due, the longest-waiting first. */
  due(nowMs: number, limit: number): PreviewLedgerEntry[] {
    if (limit <= 0) return [];
    return this.db
      .prepare<[number, number], Row>(
        `SELECT * FROM preview_offers
          WHERE state = 'deferred' AND next_attempt_ms <= ?
          ORDER BY next_attempt_ms ASC LIMIT ?`,
      )
      .all(nowMs, limit)
      .map((row) => ({
        key: row.attachment_key,
        externalId: row.external_id,
        dayKey: row.day_key,
        fileSignature: row.file_signature,
      }));
  }

  /** Drop one attachment's record. */
  forget(key: string): void {
    this.db.prepare("DELETE FROM preview_offers WHERE attachment_key = ?").run(key);
  }

  /** Forget everything, for a sync from no cursor. */
  clear(): void {
    this.db.exec("DELETE FROM preview_offers");
  }

  /** The state of one attachment, for tests and diagnostics. */
  stateOf(key: string): Row["state"] | undefined {
    return this.row(key)?.state;
  }

  close(): void {
    this.db.close();
  }

  private row(key: string): Row | undefined {
    return this.db
      .prepare<[string], Row>("SELECT * FROM preview_offers WHERE attachment_key = ?")
      .get(key);
  }

  private write(
    entry: PreviewLedgerEntry,
    state: Row["state"],
    attempts: number,
    nextAttemptMs: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO preview_offers
           (attachment_key, external_id, day_key, file_signature, state, attempts, next_attempt_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_key) DO UPDATE SET
           external_id = excluded.external_id,
           day_key = excluded.day_key,
           file_signature = excluded.file_signature,
           state = excluded.state,
           attempts = excluded.attempts,
           next_attempt_ms = excluded.next_attempt_ms`,
      )
      .run(
        entry.key,
        entry.externalId,
        entry.dayKey,
        entry.fileSignature,
        state,
        attempts,
        nextAttemptMs,
      );
  }
}
