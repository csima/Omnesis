// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * What the Kondo source persists between runs: the newest chat activity a
 * finished cycle covered, and — while a cycle is running — where its listing
 * stands and which chats it has still to read.
 *
 * `rebootstrap` is the answer to a value this build cannot read. Kondo keeps
 * the inbox, and a re-walk re-renders the same chat-days under the same ids,
 * so a discarded cursor costs requests, not data.
 */

import { z } from "zod";
import { WALKED_INBOXES } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";

const chatRefSchema = z.object({
  profileUrn: z.string().min(1),
  threadKey: z.string().min(1),
  activityAt: z.number(),
  archived: z.boolean(),
});

const passSchema = z.object({
  /** Chats with activity at or below this were covered by an earlier cycle (or are out of window). */
  floor: z.number(),
  /** Newest activity this cycle has listed; the watermark once it finishes. */
  target: z.number(),
  /** The inbox being listed; absent once every inbox is listed. */
  inbox: z.enum(WALKED_INBOXES).optional(),
  /** `before` for the next page of that inbox. */
  before: z.number().optional(),
  /** Chats at exactly the page boundary already queued, so the overlap is not read twice. */
  boundary: z.array(z.string()).optional(),
  /** A widened page size, while one activity instant fills a whole page. */
  limit: z.number().int().positive().optional(),
  /** Chats listed and still to read. */
  pending: z.array(chatRefSchema),
  /** Label names, fetched once the cycle has something to render. */
  labels: z.record(z.string(), z.string()).optional(),
});

const cursorSchema = z.object({
  v: z.literal(1),
  watermark: z.number().optional(),
  pass: passSchema.optional(),
});

export type KondoCursor = z.infer<typeof cursorSchema>;
export type KondoPass = z.infer<typeof passSchema>;

export function decodeKondoCursor(value: unknown): KondoCursor | null {
  const parsed = cursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const kondoStateSpec: SourceStateSpec<KondoCursor> = {
  version: 1,
  decode: decodeKondoCursor,
  onUnreadable: "rebootstrap",
  maxBytes: 1_000_000,
};
