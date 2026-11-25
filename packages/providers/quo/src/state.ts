// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What quo-messages persists between runs.
 *
 * Quo lists messages newest first and filters them by an exclusive
 * `createdAt` range, so the bookmark is a pair of instants rather than Quo's
 * own page cursor, which its documentation says not to keep. Each instant
 * carries the ids already emitted at exactly that millisecond: a read resumes
 * one millisecond wide of the instant, so messages sharing it are neither
 * skipped nor emitted twice.
 */

import { z } from "zod";
import type { SourceStateSpec } from "@omnesis/source-sdk";

const instant = z.string().refine((v) => Number.isFinite(Date.parse(v)), "not a timestamp");

const boundarySchema = z.object({
  /** An instant, as an ISO 8601 UTC string with milliseconds. */
  at: instant,
  /** Every message id already emitted whose `createdAt` falls in that millisecond. */
  ids: z.array(z.string().min(1)),
});
export type Boundary = z.infer<typeof boundarySchema>;

const cursorSchema = z.object({
  v: z.literal(1),
  /**
   * Everything created after the history floor and up to this instant has
   * been emitted, together with the listed ids at the instant itself.
   * Absent until the first walk completes.
   */
  watermark: boundarySchema.optional(),
  /**
   * A newest-first read in progress over everything newer than the watermark
   * (or, on the first sync, newer than `floor`).
   */
  walk: z
    .object({
      /** The first walk's inclusive lower bound, fixed when it starts. */
      floor: instant.optional(),
      /** The newest message this walk emitted; the next watermark. */
      top: boundarySchema.optional(),
      /** The oldest message this walk emitted; the next request reads below it. */
      below: boundarySchema.optional(),
    })
    .optional(),
});
export type QuoCursor = z.infer<typeof cursorSchema>;

export const quoMessagesStateSpec: SourceStateSpec<QuoCursor> = {
  version: 1,
  decode(value: unknown): QuoCursor | null {
    const parsed = cursorSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  /**
   * Quo keeps the history the API lists, so a discarded bookmark costs one
   * bounded re-read whose upserts land on the same message ids.
   */
  onUnreadable: "rebootstrap",
  // Two instants and the ids sharing each one's millisecond.
  maxBytes: 1_000_000,
};
