// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * The shapes Kondo's MCP tools hand back, validated where they enter the
 * package. Every row is parsed on its own so one malformed chat or message is
 * skipped rather than failing the page it arrived on.
 *
 * Kondo documents none of this as a stable API, so the schemas accept what the
 * tools are known to send and tolerate absent optional fields; anything a
 * document needs is required.
 */

import { z } from "zod";

/** A LinkedIn member id Kondo may send as a string or a bare number. */
const idString = z
  .union([z.string().trim().min(1), z.number().int()])
  .transform((value) => String(value));

/** Epoch milliseconds, as a number or a numeric/ISO string. */
const epochMs = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const ms =
    typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: "custom", message: "not a timestamp" });
    return z.NEVER;
  }
  return ms;
});

export const inboxRowSchema = z.object({
  profileUrn: idString,
  threadKey: z.string().trim().min(1),
  labelKeys: z.array(z.string()).nullish(),
  threadParticipantUrns: z.array(idString).nullish(),
  threadActivityAt: epochMs,
  archived: z.boolean().nullish(),
});
export type KondoInboxRow = z.infer<typeof inboxRowSchema>;

const participantSchema = z.object({
  fullName: z.string().nullish(),
  profileUrn: idString.nullish(),
  profileUrl: z.string().nullish(),
});
export type KondoParticipant = z.infer<typeof participantSchema>;

const messageSchema = z.object({
  sender: z.string().nullish(),
  self: z.boolean().nullish(),
  time: z.string().refine((value) => Number.isFinite(Date.parse(value)), "not a timestamp"),
  text: z.string().nullish(),
});
export type KondoMessage = z.infer<typeof messageSchema>;

/**
 * A chat as `read_chat` returns it. Messages are kept raw here and parsed one
 * by one in {@link parseChat}, so a single unreadable message costs that
 * message and not the conversation.
 */
const rawChatSchema = z.object({
  profileUrn: idString,
  threadKey: z.string().trim().min(1),
  participants: z.array(z.unknown()).nullish(),
  messages: z.array(z.unknown()).nullish(),
  labelKeys: z.array(z.string()).nullish(),
  chatUrl: z.string().nullish(),
});

export interface KondoChat {
  profileUrn: string;
  threadKey: string;
  participants: KondoParticipant[];
  messages: KondoMessage[];
  labelKeys: string[];
  chatUrl?: string;
  /** Messages present but unreadable, skipped. */
  skippedMessages: number;
}

/** Parse one chat; `null` when the chat itself is unusable. */
export function parseChat(value: unknown): KondoChat | null {
  const raw = rawChatSchema.safeParse(value);
  if (!raw.success) return null;
  const participants: KondoParticipant[] = [];
  for (const p of raw.data.participants ?? []) {
    const parsed = participantSchema.safeParse(p);
    if (parsed.success) participants.push(parsed.data);
  }
  const messages: KondoMessage[] = [];
  let skippedMessages = 0;
  for (const m of raw.data.messages ?? []) {
    const parsed = messageSchema.safeParse(m);
    if (parsed.success) messages.push(parsed.data);
    else skippedMessages++;
  }
  return {
    profileUrn: raw.data.profileUrn,
    threadKey: raw.data.threadKey,
    participants,
    messages,
    labelKeys: raw.data.labelKeys ?? [],
    chatUrl: raw.data.chatUrl ?? undefined,
    skippedMessages,
  };
}

export const inboxDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  isLabel: z.boolean().nullish(),
});

export const statusSchema = z.object({
  connected: z.boolean(),
  lastSeenAt: z.string().nullish(),
  linkedin: z.string().nullish(),
  salesNavigatorSeat: z.boolean().nullish(),
});
export type KondoStatus = z.infer<typeof statusSchema>;

/** The inboxes a cycle walks. `all` never lists archived chats; `archive` holds them. */
export const WALKED_INBOXES = ["all", "archive"] as const;
export type WalkedInbox = (typeof WALKED_INBOXES)[number];

/** A chat a listing found newer than the cycle's floor, queued to be read. */
export interface ChatRef {
  profileUrn: string;
  threadKey: string;
  activityAt: number;
  archived: boolean;
}

/**
 * The pacing and paging the source applies, in one place. Kondo serialises
 * LinkedIn work behind the user's own browser tab, so these are deliberately
 * modest; tests override them.
 */
export interface KondoTuning {
  /** Rows asked of one `list_inbox` call. */
  listPageSize: number;
  /** Widest page asked for when one activity instant fills a whole page. */
  maxListPageSize: number;
  /** Chats read in one `read_chat` call. */
  readBatchSize: number;
  /** Chats read in one `sync()` call before the cursor is handed back. */
  chatsPerCall: number;
  /** Pause between two tool calls. */
  callGapMs: number;
  /** Longest one MCP request may take. */
  requestTimeoutMs: number;
}

export const DEFAULT_TUNING: KondoTuning = {
  listPageSize: 25,
  maxListPageSize: 100,
  readBatchSize: 5,
  chatsPerCall: 10,
  callGapMs: 750,
  requestTimeoutMs: 120_000,
};

/** First-sync history window, in days, when the operator sets none. */
export const DEFAULT_HISTORY_DAYS = 365;

export const DAY_MS = 86_400_000;

/** UTC calendar day (`YYYY-MM-DD`) of an instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function chatDayExternalId(threadKey: string, day: string): string {
  return `${threadKey}:${day}`;
}
