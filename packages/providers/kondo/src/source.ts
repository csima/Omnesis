// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * The sync loop.
 *
 * A cycle lists both inboxes Kondo keeps — `all`, which never shows archived
 * chats, and `archive` — newest activity first, paging back with `before`
 * until it reaches the activity the previous cycle finished at (the
 * watermark), or the start of the history window on a first sync. Every chat
 * listed above that floor is read with `read_chat` in small batches, and its
 * days from the floor's day onward are rendered whole, so a day that gained a
 * message is re-emitted complete. The watermark moves only when the cycle has
 * read every chat it listed.
 *
 * One upstream step per `sync()` call — a status check, a listing page, or a
 * few chat reads — with the cursor handed back in between, so a cycle that
 * stops (the Kondo tab closed, the network went) resumes where it was.
 *
 * Deliberately not done, and why:
 *  - No snapshot and no deletions. Kondo's tools say nothing about deleted
 *    messages, and its history is a cache that can be incomplete; reporting
 *    an absence from it would delete documents that still exist on LinkedIn.
 *  - A message Kondo adds to its cache later, dated before the chat's last
 *    activity, lands only on a resync: a day is re-read only when its chat
 *    shows new activity.
 *  - Label and archive changes that leave a chat's activity untouched are
 *    picked up the next time the chat has activity.
 */

import { createLogger } from "@omnesis/core";
import { applyDataCutoff, syncPage } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { tabDisconnectedError } from "./client.js";
import { normalizeChat } from "./normalizer.js";
import { DAY_MS, DEFAULT_HISTORY_DAYS, DEFAULT_TUNING, utcDay, WALKED_INBOXES } from "./types.js";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { KondoClient } from "./client.js";
import type { KondoCursor, KondoPass } from "./state.js";
import type { ChatRef, KondoTuning } from "./types.js";

const log = createLogger("source:kondo");

export interface KondoSourceOptions {
  client: KondoClient;
  providerId: ProviderId;
  sourceId: SourceId;
  /** The LinkedIn member this inbox belongs to; rows of any other owner are ignored. */
  ownerUrn?: string;
  historyDays?: number;
  dataCutoff?: string;
  now?: () => number;
  tuning?: Partial<KondoTuning>;
}

export class KondoSource {
  private readonly opts: KondoSourceOptions;
  private readonly tuning: KondoTuning;
  private readonly cutoffMs: number | undefined;

  constructor(opts: KondoSourceOptions) {
    this.opts = opts;
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    const cutoff = opts.dataCutoff ? Date.parse(opts.dataCutoff) : NaN;
    this.cutoffMs = Number.isFinite(cutoff) ? cutoff : undefined;
  }

  async sync(cursor: KondoCursor | null, opts?: SyncOptions): Promise<SyncResult<KondoCursor>> {
    try {
      return await this.step(cursor, opts?.signal);
    } catch (err) {
      if (err instanceof SyncError || opts?.signal?.aborted) throw err;
      throw new SyncError("unknown", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  private async step(
    prior: KondoCursor | null,
    signal: AbortSignal | undefined,
  ): Promise<SyncResult<KondoCursor>> {
    const cur: KondoCursor = structuredClone(prior ?? { v: 1 });

    if (!cur.pass) {
      const status = await this.opts.client.readStatus(signal);
      if (!status.connected) throw tabDisconnectedError(status.lastSeenAt);
      const floor = this.floorFor(cur.watermark);
      cur.pass = { floor, target: cur.watermark ?? floor, inbox: WALKED_INBOXES[0], pending: [] };
      log.info(`Cycle start: listing chats with activity after ${new Date(floor).toISOString()}`);
      return syncPage([], cur, { hasMore: true });
    }

    const pass = cur.pass;
    if (pass.pending.length > 0) {
      const docs = await this.readPending(pass, signal);
      return syncPage(applyDataCutoff(docs, this.cutoffDate(), log, "chat-days"), cur, {
        hasMore: true,
      });
    }

    if (pass.inbox) {
      await this.listPage(pass, signal);
      return syncPage([], cur, { hasMore: true });
    }

    const covered = pass.target;
    delete cur.pass;
    cur.watermark = Math.max(cur.watermark ?? covered, covered);
    log.info(`Cycle complete: chats covered through ${new Date(cur.watermark).toISOString()}`);
    return syncPage([], cur, { hasMore: false });
  }

  /** Where a new cycle starts: the last watermark, else the history window, never before the cutoff. */
  private floorFor(watermark: number | undefined): number {
    const now = (this.opts.now ?? Date.now)();
    const window = now - (this.opts.historyDays ?? DEFAULT_HISTORY_DAYS) * DAY_MS;
    const floor = watermark ?? window;
    return this.cutoffMs !== undefined ? Math.max(floor, this.cutoffMs - 1) : floor;
  }

  private cutoffDate(): Date | undefined {
    return this.cutoffMs !== undefined ? new Date(this.cutoffMs) : undefined;
  }

  /** One page of the inbox being listed; queues every chat above the floor. */
  private async listPage(pass: KondoPass, signal: AbortSignal | undefined): Promise<void> {
    const inbox = pass.inbox!;
    const limit = pass.limit ?? this.tuning.listPageSize;
    const page = await this.opts.client.listInbox(
      { inbox, limit, before: pass.before, after: pass.floor },
      signal,
    );
    if (page.skipped > 0) log.warn(`Skipped ${page.skipped} unreadable ${inbox} inbox rows`);

    const boundary = new Set(pass.boundary ?? []);
    const queued = new Set(pass.pending.map((r) => r.threadKey));
    let oldest: number | undefined;
    for (const row of page.rows) {
      oldest = oldest === undefined ? row.threadActivityAt : Math.min(oldest, row.threadActivityAt);
      if (this.opts.ownerUrn && row.profileUrn !== this.opts.ownerUrn) continue;
      if (row.threadActivityAt <= pass.floor) continue;
      if (boundary.has(row.threadKey) || queued.has(row.threadKey)) continue;
      queued.add(row.threadKey);
      pass.target = Math.max(pass.target, row.threadActivityAt);
      pass.pending.push({
        profileUrn: row.profileUrn,
        threadKey: row.threadKey,
        activityAt: row.threadActivityAt,
        archived: inbox === "archive" || row.archived === true,
      });
    }

    const exhausted =
      oldest === undefined ||
      oldest <= pass.floor ||
      (!page.more && page.rows.length + page.skipped < limit);
    if (exhausted) {
      this.nextInbox(pass);
      return;
    }

    // Page back to the oldest instant seen, inclusive, so chats sharing it
    // beyond this page are not lost; the ones already queued are remembered.
    // A page made entirely of one instant cannot move on that way, so it is
    // asked again wider before anything sharing that instant is given up on.
    const next = oldest! + 1;
    if (pass.before !== undefined && next >= pass.before) {
      if (limit < this.tuning.maxListPageSize) {
        pass.limit = Math.min(limit * 2, this.tuning.maxListPageSize);
        return;
      }
      log.warn(
        `More than ${limit} ${inbox} chats share one activity instant; paging past it may skip some`,
      );
      pass.before = Math.min(oldest!, pass.before - 1);
      pass.boundary = [];
      delete pass.limit;
      return;
    }
    pass.before = next;
    pass.boundary = page.rows.filter((r) => r.threadActivityAt === oldest).map((r) => r.threadKey);
    delete pass.limit;
  }

  private nextInbox(pass: KondoPass): void {
    const at = WALKED_INBOXES.indexOf(pass.inbox!);
    pass.inbox = WALKED_INBOXES[at + 1];
    delete pass.before;
    delete pass.boundary;
    delete pass.limit;
  }

  /** Read the next few queued chats and render their days from the floor's day on. */
  private async readPending(
    pass: KondoPass,
    signal: AbortSignal | undefined,
  ): Promise<DocumentInput[]> {
    const client = this.opts.client;
    pass.labels ??= await client.listLabels(signal).catch((err: unknown) => {
      if (err instanceof SyncError && err.remediation) throw err;
      log.warn(`Kondo labels unavailable, chats are indexed without them: ${describe(err)}`);
      return {};
    });

    const batch = pass.pending.slice(0, this.tuning.chatsPerCall);
    const fromDay = utcDay(pass.floor);
    const docs: DocumentInput[] = [];
    for (let i = 0; i < batch.length; i += this.tuning.readBatchSize) {
      const refs = batch.slice(i, i + this.tuning.readBatchSize);
      const { chats, skipped } = await client.readChats(refs, signal);
      if (skipped > 0) log.warn(`Skipped ${skipped} unreadable chats`);
      const byKey = new Map(chats.map((c) => [c.threadKey, c]));
      for (const ref of refs) {
        const chat = byKey.get(ref.threadKey);
        if (!chat) {
          log.warn(`Kondo returned nothing for chat ${ref.threadKey}; skipped this cycle`);
          continue;
        }
        if (chat.skippedMessages > 0) {
          log.warn(`Chat ${ref.threadKey}: skipped ${chat.skippedMessages} unreadable messages`);
        }
        docs.push(...this.render(chat, ref, fromDay, pass.labels));
      }
    }
    pass.pending.splice(0, batch.length);
    if (docs.length > 0) log.info(`Read ${batch.length} chats → ${docs.length} chat-day documents`);
    return docs;
  }

  private render(
    chat: Parameters<typeof normalizeChat>[0],
    ref: ChatRef,
    fromDay: string,
    labels: Record<string, string>,
  ): DocumentInput[] {
    try {
      return normalizeChat(
        chat,
        {
          providerId: this.opts.providerId,
          sourceId: this.opts.sourceId,
          ownerUrn: this.opts.ownerUrn,
          labels,
          archived: ref.archived,
        },
        fromDay,
      );
    } catch (err) {
      log.warn(`Chat ${ref.threadKey} could not be rendered and was skipped: ${describe(err)}`);
      return [];
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
