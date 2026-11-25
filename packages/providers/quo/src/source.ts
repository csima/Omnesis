// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { syncPage } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { QUO_PAGE_LIMIT } from "./client.js";
import { QuoContactNames } from "./contact-names.js";
import { canonicalPhone, normalizeMessage } from "./normalizer.js";
import type { SourceHost, SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { QuoClient } from "./client.js";
import type { QuoLine } from "./normalizer.js";
import type { QuoMessage } from "./schemas.js";
import type { Boundary, QuoCursor } from "./state.js";

const DAY_MS = 86_400_000;
/** Documents one sync call aims to return before handing the page to the gateway. */
const TARGET_DOCUMENTS_PER_CALL = 200;
/** Requests one sync call may spend, so a call always returns. */
const MAX_REQUESTS_PER_CALL = 20;
/** How long the organization's number list is reused before it is read again. */
const LINES_TTL_MS = 10 * 60_000;

export interface QuoMessagesSourceOptions {
  client: QuoClient;
  providerId: ProviderId;
  sourceId: SourceId;
  organizationId: string;
  host: SourceHost;
  /** How far back the first sync reads. */
  historyDays: number;
  /** ISO 8601; nothing older is read, whatever `historyDays` says. */
  dataCutoff?: string;
  targetDocumentsPerCall?: number;
  pageLimit?: number;
}

/**
 * The organization's text messages, every number and both directions, one
 * document per message.
 *
 * Quo lists messages newest first, filtered by an exclusive `createdAt`
 * range. A sync is therefore a *walk*: a newest-first read of everything
 * newer than the watermark (or, the first time, newer than the history
 * floor). A walk that does not fit one call persists the oldest instant it
 * reached and resumes strictly below it on the next call; Quo's own page
 * cursor is only followed within one call, as its documentation asks. When a
 * walk reaches the bottom of its range, the newest message it saw becomes the
 * watermark and the next walk reads only what came after it.
 *
 * Both instants carry the ids emitted at exactly that millisecond, and every
 * request reaches one millisecond past the instant, so messages created in the
 * same millisecond are neither lost at a page edge nor emitted twice.
 *
 * Quo exposes no deletion signal for messages and a full re-listing would cost
 * the whole history every cycle, so this source sends no tombstones and no
 * snapshot: a message deleted in Quo stays indexed.
 */
export class QuoMessagesSource {
  private readonly opts: QuoMessagesSourceOptions;
  private readonly names: QuoContactNames;
  private lines: { at: number; byId: Map<string, QuoLine> } | undefined;

  constructor(opts: QuoMessagesSourceOptions) {
    this.opts = opts;
    this.names = new QuoContactNames(
      opts.client,
      () => opts.host.now().getTime(),
      opts.host.log,
      opts.host.ingestion?.phoneRegion,
    );
  }

  async sync(cursor: QuoCursor | null, opts?: SyncOptions): Promise<SyncResult<QuoCursor>> {
    try {
      return await this.runSync(cursor, opts?.signal);
    } catch (err) {
      if (err instanceof SyncError || opts?.signal?.aborted) throw err;
      throw new SyncError("unknown", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  private async runSync(
    cursor: QuoCursor | null,
    signal: AbortSignal | undefined,
  ): Promise<SyncResult<QuoCursor>> {
    const log = this.opts.host.log;
    const watermark = cursor?.watermark;
    const walk = cursor?.walk ?? (watermark ? {} : { floor: this.floor() });
    const floorMs = walk.floor ? Date.parse(walk.floor) : undefined;
    const lowerMs = watermark ? Date.parse(watermark.at) : floorMs;
    const lowerIds = new Set(watermark?.ids ?? []);
    const belowIds = new Set(walk.below?.ids ?? []);
    const belowMs = walk.below ? Date.parse(walk.below.at) : undefined;

    const lines = await this.loadLines(signal);
    const target = this.opts.targetDocumentsPerCall ?? TARGET_DOCUMENTS_PER_CALL;
    const fresh: QuoMessage[] = [];
    const freshIds = new Set<string>();
    let top = walk.top;
    let below = walk.below;
    let after: string | undefined;
    const seenPageCursors = new Set<string>();
    let exhausted = false;
    let malformed = 0;

    for (let requests = 0; requests < MAX_REQUESTS_PER_CALL; requests++) {
      const page = await this.opts.client.listMessages(
        {
          createdAfter: lowerMs !== undefined ? iso(lowerMs - 1) : undefined,
          createdBefore: belowMs !== undefined ? iso(belowMs + 1) : undefined,
          after,
          limit: this.opts.pageLimit ?? QUO_PAGE_LIMIT,
        },
        signal,
      );
      malformed += page.malformed;
      for (const message of page.messages) {
        const ms = Date.parse(message.createdAt);
        // Covered by the watermark, or emitted earlier in this walk.
        if (
          lowerMs !== undefined &&
          (ms < lowerMs || (ms === lowerMs && watermark && lowerIds.has(message.id)))
        )
          continue;
        if (belowMs !== undefined && (ms > belowMs || (ms === belowMs && belowIds.has(message.id))))
          continue;
        if (freshIds.has(message.id)) continue;
        freshIds.add(message.id);
        fresh.push(message);
        top = extend(top, ms, message.id, (a, b) => a > b);
        below = extend(below, ms, message.id, (a, b) => a < b);
      }
      if (!page.nextCursor) {
        exhausted = true;
        break;
      }
      if (seenPageCursors.has(page.nextCursor)) {
        throw new SyncError(
          "unknown",
          "Quo returned the same message page twice; stopping this sync.",
        );
      }
      seenPageCursors.add(page.nextCursor);
      after = page.nextCursor;
      if (fresh.length >= target) break;
    }

    if (!exhausted && fresh.length === 0) {
      // Every request of the call was spent on messages already emitted: more
      // messages share one millisecond than a call can read past.
      throw new SyncError(
        "unknown",
        `Quo listed only already-indexed or unreadable messages (${malformed} unreadable) for ${MAX_REQUESTS_PER_CALL} requests; the sync cannot move past them.`,
      );
    }
    if (malformed > 0) {
      log.warn(`Skipped ${malformed} Quo message record(s) that did not match the expected shape`);
    }

    const phoneRegion = this.opts.host.ingestion?.phoneRegion;
    const ownNumbers = new Set(
      [...lines.values()].map((l) => canonicalPhone(l.number, phoneRegion) ?? l.number),
    );
    const counterparts = fresh
      .flatMap((m) => [m.from, ...m.to])
      .map((raw) => canonicalPhone(raw, phoneRegion))
      .filter((p): p is string => Boolean(p) && !ownNumbers.has(p!));
    const names = await this.names.namesFor(counterparts, signal);

    const documents: DocumentInput[] = [];
    for (const message of fresh) {
      documents.push(
        normalizeMessage(message, {
          providerId: this.opts.providerId,
          sourceId: this.opts.sourceId,
          organizationId: this.opts.organizationId,
          lines,
          phoneRegion,
          names,
        }),
      );
    }

    if (!exhausted) {
      return syncPage(
        documents,
        { v: 2, watermark, walk: { ...walk, top, below } },
        { hasMore: true },
      );
    }
    const next = advance(watermark, top) ?? (walk.floor ? { at: walk.floor, ids: [] } : undefined);
    if (documents.length > 0) {
      log.info(`Quo sync caught up: ${documents.length} new message(s); watermark ${next?.at}`);
    }
    return syncPage(documents, { v: 2, watermark: next }, { hasMore: false });
  }

  /** The first walk's inclusive lower bound: the history window, or the data cutoff if later. */
  private floor(): string {
    const now = this.opts.host.now().getTime();
    const window = now - this.opts.historyDays * DAY_MS;
    const cutoff = this.opts.dataCutoff ? Date.parse(this.opts.dataCutoff) : Number.NaN;
    return iso(Number.isFinite(cutoff) ? Math.max(window, cutoff) : window);
  }

  private async loadLines(signal: AbortSignal | undefined): Promise<Map<string, QuoLine>> {
    const now = this.opts.host.now().getTime();
    if (this.lines && now - this.lines.at < LINES_TTL_MS) return this.lines.byId;
    const numbers = await this.opts.client.listPhoneNumbers(signal);
    const byId = new Map<string, QuoLine>();
    for (const n of numbers) {
      byId.set(n.id, { id: n.id, number: n.phoneNumber, ...(n.name ? { name: n.name } : {}) });
    }
    this.lines = { at: now, byId };
    return byId;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Move a boundary to `ms` if it is further in `beyond`'s direction, or add the id at a tie. */
function extend(
  boundary: Boundary | undefined,
  ms: number,
  id: string,
  beyond: (a: number, b: number) => boolean,
): Boundary {
  if (!boundary) return { at: iso(ms), ids: [id] };
  const at = Date.parse(boundary.at);
  if (beyond(ms, at)) return { at: iso(ms), ids: [id] };
  if (ms === at && !boundary.ids.includes(id))
    return { at: boundary.at, ids: [...boundary.ids, id] };
  return boundary;
}

/** The newer of the watermark and a completed walk's top, merging ids at a shared instant. */
function advance(watermark: Boundary | undefined, top: Boundary | undefined): Boundary | undefined {
  if (!top) return watermark;
  if (!watermark) return top;
  const a = Date.parse(watermark.at);
  const b = Date.parse(top.at);
  if (b > a) return top;
  if (b < a) return watermark;
  return { at: watermark.at, ids: [...new Set([...watermark.ids, ...top.ids])] };
}
