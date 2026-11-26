// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { parseEmailHeader } from "@omnesis/core";

const MESSAGE_ID = /<[^<>\s]+>/g;

function messageIds(header: string): string[] {
  return header.match(MESSAGE_ID) ?? [];
}

/**
 * Raw RFC 5322 identifiers a write-only connector needs to answer inside a
 * Gmail thread, flat on `metadata.extra` beside `threadId`: `messageId`,
 * `inReplyTo` and `references`, each absent when the message lacks it.
 */
export function gmailReplyFields(headers: {
  messageId: string;
  inReplyTo: string;
  references: string;
}): Record<string, string | string[]> {
  const messageId = messageIds(headers.messageId)[0];
  const inReplyTo = messageIds(headers.inReplyTo)[0];
  const references = messageIds(headers.references);
  return {
    ...(messageId ? { messageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
  };
}

/** `sent` when Gmail filed the message under SENT or the From address is the account's own. */
export function gmailDirection(
  labelIds: readonly string[],
  from: string,
  accountEmail: string | undefined,
): "sent" | "received" {
  if (labelIds.includes("SENT")) return "sent";
  const sender = from ? parseEmailHeader(from).email?.toLowerCase() : undefined;
  if (sender && accountEmail && sender === accountEmail.toLowerCase()) return "sent";
  return "received";
}

/** Mutable triage state read from Gmail's system labels. */
export function gmailTriage(labelIds: readonly string[]): {
  unread: boolean;
  archived: boolean;
  starred: boolean;
} {
  const has = (label: string) => labelIds.includes(label);
  return {
    unread: has("UNREAD"),
    archived: !has("INBOX") && !has("SENT") && !has("DRAFT"),
    starred: has("STARRED"),
  };
}
