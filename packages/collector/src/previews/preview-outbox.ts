// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a source's document previews wait to be rendered and uploaded.
 *
 * A source offers a preview while its sync builds a page, but the gateway can
 * only keep a preview for a document it already holds. So an offer is staged
 * against its source until the runner reports that the page was written
 * ({@link PreviewOutbox.release}); a page that is refused, superseded or
 * abandoned drops its offers instead ({@link PreviewOutbox.drop}), and each
 * resolves `deferred` for the source to make again later.
 *
 * Released offers drain in the background, never inside a sync: at most
 * {@link DEFAULT_PREVIEW_CONCURRENCY} render-and-upload jobs run at once
 * across every source on this collector, because rendering spawns image tools
 * and every upload is a few hundred kilobytes. Rendering waits for a slot
 * too, so an offer whose upload never happens costs no rendering, and only
 * the images being sent are held in memory.
 *
 * A transient answer (busy, unreachable, not ready) is retried a few times
 * with backoff, honouring the gateway's Retry-After, and then left `deferred`.
 * An answer that this gateway keeps no previews for the source pauses that
 * source's previews until the collector reconnects
 * ({@link PreviewOutbox.resumeAll}), since every further offer would get the
 * same answer.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import type {
  DocumentPreviewOffer,
  DocumentPreviewOutcome,
  DocumentPreviewUploadResult,
  GatewayClient,
  SourcePreviewSink,
} from "@omnesis/source-sdk";

const log = createLogger("collector:previews");

/** Render-and-upload jobs in flight at once, across every source. */
export const DEFAULT_PREVIEW_CONCURRENCY = 2;
/** Further tries of an upload the gateway answered as transient. */
export const DEFAULT_PREVIEW_UPLOAD_RETRIES = 3;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const MAX_RETRY_DELAY_MS = 60_000;

export type PreviewUploader = Pick<GatewayClient, "putDocumentPreview">;

export interface PreviewOutboxOptions {
  uploader: PreviewUploader;
  concurrency?: number;
  retries?: number;
  /** The wait before retry `n` (0-based), before the gateway's Retry-After is applied. */
  retryDelayMs?: (retry: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The part of the outbox the sync runner drives. */
export interface PreviewPageGate {
  release(sourceId: string): void;
  drop(sourceId: string): void;
}

interface Job {
  sourceId: string;
  providerId: string;
  offer: DocumentPreviewOffer;
  settle: (outcome: DocumentPreviewOutcome) => void;
}

export class PreviewOutbox implements PreviewPageGate {
  private readonly staged = new Map<string, Job[]>();
  private readonly queue: Job[] = [];
  private readonly paused = new Set<string>();
  private active = 0;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly retryDelayMs: (retry: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PreviewOutboxOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_PREVIEW_CONCURRENCY);
    this.retries = Math.max(0, options.retries ?? DEFAULT_PREVIEW_UPLOAD_RETRIES);
    this.retryDelayMs =
      options.retryDelayMs ??
      ((retry) => RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]!);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
  }

  /** The sink one source is lent: its offers wait on that source's pages. */
  sinkFor(source: { sourceId: string; providerId: string }): SourcePreviewSink {
    return {
      offer: (offer) =>
        new Promise<DocumentPreviewOutcome>((settle) => {
          if (this.paused.has(source.sourceId)) {
            settle("deferred");
            return;
          }
          const jobs = this.staged.get(source.sourceId) ?? [];
          jobs.push({ ...source, offer, settle });
          this.staged.set(source.sourceId, jobs);
        }),
    };
  }

  /** The page carrying the source's staged offers was written: send them. */
  release(sourceId: string): void {
    const jobs = this.staged.get(sourceId);
    if (!jobs) return;
    this.staged.delete(sourceId);
    this.queue.push(...jobs);
    this.pump();
  }

  /** The source's page was not written: its staged offers are deferred. */
  drop(sourceId: string): void {
    const jobs = this.staged.get(sourceId);
    if (!jobs) return;
    this.staged.delete(sourceId);
    for (const job of jobs) job.settle("deferred");
  }

  /** The collector reconnected: a gateway that kept no previews may keep them now. */
  resumeAll(): void {
    if (this.paused.size === 0) return;
    log.info(`Resuming previews for ${this.paused.size} source(s) after reconnecting`);
    this.paused.clear();
  }

  /** Offers staged, queued or in flight. */
  get pending(): number {
    let staged = 0;
    for (const jobs of this.staged.values()) staged += jobs.length;
    return staged + this.queue.length + this.active;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.run(job)
        .catch((err: unknown) => {
          log.warn(`Preview for ${job.sourceId} failed: ${toErrorMessage(err)}`);
          return "deferred" as const;
        })
        .then((outcome) => {
          this.active--;
          job.settle(outcome);
          this.pump();
        });
    }
  }

  private async run(job: Job): Promise<DocumentPreviewOutcome> {
    if (this.paused.has(job.sourceId)) return "deferred";
    const put = this.options.uploader.putDocumentPreview?.bind(this.options.uploader);
    if (!put) {
      this.pause(job.sourceId, "the gateway client cannot upload previews");
      return "deferred";
    }
    let image;
    try {
      image = await job.offer.render();
    } catch (err) {
      log.debug(`Could not render a preview for ${job.sourceId}: ${toErrorMessage(err)}`);
      return "deferred";
    }
    if (!image) return "refused";

    for (let attempt = 0; ; attempt++) {
      if (this.paused.has(job.sourceId)) return "deferred";
      const result: DocumentPreviewUploadResult = await put({
        providerId: job.providerId,
        sourceId: job.sourceId,
        externalId: job.offer.externalId,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
        capturedAt: image.capturedAt,
        bytes: image.bytes,
      });
      switch (result.outcome) {
        case "stored":
        case "not-found":
          return result.outcome;
        case "refused":
          log.debug(
            `The gateway refused a preview for ${job.sourceId} (${result.status}${result.code ? ` ${result.code}` : ""})`,
          );
          return "refused";
        case "unsupported":
          this.pause(job.sourceId, result.code ?? "no preview route");
          return "deferred";
        case "transient": {
          if (attempt >= this.retries) {
            log.debug(
              `Leaving a preview for ${job.sourceId} for later after ${attempt + 1} tries: ${result.reason}`,
            );
            return "deferred";
          }
          const wait = Math.min(
            Math.max(this.retryDelayMs(attempt), result.retryAfterMs ?? 0),
            MAX_RETRY_DELAY_MS,
          );
          await this.sleep(wait);
        }
      }
    }
  }

  private pause(sourceId: string, reason: string): void {
    if (this.paused.has(sourceId)) return;
    this.paused.add(sourceId);
    log.info(`Previews for ${sourceId} paused until the collector reconnects: ${reason}`);
    this.drop(sourceId);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i]!;
      if (job.sourceId !== sourceId) continue;
      this.queue.splice(i, 1);
      job.settle("deferred");
    }
  }
}
