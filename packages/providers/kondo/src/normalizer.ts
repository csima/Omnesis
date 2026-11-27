// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * One document per chat per UTC day, the shape iMessage, WhatsApp, Slack and
 * Discord use, so search, the people graph and message counting treat a
 * LinkedIn conversation like any other messaging source.
 *
 * Kondo's messages carry no ids. A message is identified by what it is —
 * thread, instant, direction and text — which is stable across reads and is
 * what removes a message Kondo's cache hands back twice.
 */

import { createHash } from "node:crypto";
import { cleanPersonName, computeContentHash, formatLid } from "@omnesis/core";
import { chatDayExternalId, utcDay } from "./types.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { KondoChat, KondoMessage, KondoParticipant } from "./types.js";

export interface NormalizeContext {
  providerId: ProviderId;
  sourceId: SourceId;
  /** The LinkedIn member this inbox belongs to, when known. */
  ownerUrn?: string;
  /** Label names by key, from `list_inboxes`. */
  labels: Readonly<Record<string, string>>;
  archived: boolean;
}

/** Longest day document rendered; a day past it ends with a count of what was left out. */
const MAX_CONTENT_CHARS = 200_000;

/** The platform half of the LinkedIn member lid, which `selfIdentity` names too. */
export const LINKEDIN_LID_PLATFORM = "linkedin";
const LINKEDIN_HANDLE_PLATFORM = "linkedin-in";

export function messageId(threadKey: string, message: KondoMessage): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        threadKey,
        new Date(message.time).toISOString(),
        message.self === true,
        message.text ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/** The public-profile handle of a `linkedin.com/in/<handle>` URL, lower-cased. */
export function linkedinHandle(profileUrl: string | null | undefined): string | undefined {
  if (!profileUrl) return undefined;
  try {
    const url = new URL(profileUrl);
    if (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com"))
      return undefined;
    const match = /^\/in\/([^/?#]+)\/?$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * LinkedIn shows a member it will not name — a closed account, an
 * out-of-network sender — under a placeholder, which is not a person's name.
 */
const PLACEHOLDER_NAMES = new Set(["linkedin member", "linkedin user", "unknown"]);

function personName(raw: string | null | undefined): string | undefined {
  const name = cleanPersonName(raw ?? undefined);
  return name && !PLACEHOLDER_NAMES.has(name.toLowerCase()) ? name : undefined;
}

function participantLids(p: KondoParticipant): string[] {
  const lids: string[] = [];
  if (p.profileUrn) lids.push(formatLid(LINKEDIN_LID_PLATFORM, p.profileUrn));
  const handle = linkedinHandle(p.profileUrl);
  if (handle) lids.push(formatLid(LINKEDIN_HANDLE_PLATFORM, handle));
  return lids;
}

/** A link into Kondo's own web app, and nothing else. */
function chatUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname !== "trykondo.com" && !url.hostname.endsWith(".trykondo.com"))
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

interface Roster {
  people: PersonMention[];
  /** Display names of the other people in the chat. */
  others: string[];
  /** LinkedIn member ids of the other people in the chat, where Kondo sent them. */
  otherProfileIds: string[];
  selfName?: string;
}

/**
 * Who is in the chat. The owner is a normal mention carrying the inbox's own
 * member id, which `selfIdentity` resolves to the self person; everyone else
 * is a participant identified by their member id and public-profile handle.
 */
function roster(chat: KondoChat, messages: KondoMessage[], ownerUrn: string | undefined): Roster {
  const selfSenders = new Set(
    messages.filter((m) => m.self === true && m.sender).map((m) => m.sender!.trim()),
  );
  const isSelf = (p: KondoParticipant): boolean =>
    (ownerUrn !== undefined && p.profileUrn === ownerUrn) ||
    (!!p.fullName && selfSenders.has(p.fullName.trim()));

  const people: PersonMention[] = [];
  const others: string[] = [];
  const otherProfileIds: string[] = [];
  const seen = new Set<string>();
  let selfName: string | undefined;
  const selfLids = new Set<string>();
  if (ownerUrn) selfLids.add(formatLid(LINKEDIN_LID_PLATFORM, ownerUrn));

  for (const p of chat.participants) {
    if (isSelf(p)) {
      selfName ??= cleanPersonName(p.fullName ?? undefined);
      for (const lid of participantLids(p)) selfLids.add(lid);
      continue;
    }
    const name = personName(p.fullName);
    const lids = participantLids(p);
    const key = lids[0] ?? (name ? `name:${name}` : undefined);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (name) others.push(name);
    if (p.profileUrn && !otherProfileIds.includes(p.profileUrn)) otherProfileIds.push(p.profileUrn);
    people.push({
      role: "participant",
      ...(name ? { name } : {}),
      ...(lids.length ? { lids } : {}),
      ...(lids.length ? {} : { allowPersonCreation: false }),
    });
  }

  const known = new Set(others);
  for (const m of messages) {
    if (m.self === true) continue;
    const name = personName(m.sender);
    if (!name || known.has(name) || selfSenders.has(name)) continue;
    known.add(name);
    others.push(name);
    people.push({ role: "participant", name, allowPersonCreation: false });
  }

  if (selfLids.size > 0 || selfName) {
    selfName ??= cleanPersonName([...selfSenders][0]);
    people.unshift({
      role: "participant",
      ...(selfName ? { name: selfName } : {}),
      ...(selfLids.size ? { lids: [...selfLids] } : { isSelf: true }),
    });
  } else if (messages.some((m) => m.self === true)) {
    people.unshift({ role: "participant", isSelf: true });
  }
  return { people, others, otherProfileIds, selfName };
}

/**
 * Render every UTC day of a chat from `fromDay` on (inclusive). Days that
 * render no message produce no document.
 */
export function normalizeChat(
  chat: KondoChat,
  ctx: NormalizeContext,
  fromDay?: string,
): DocumentInput[] {
  const unique = new Map<string, KondoMessage>();
  for (const m of chat.messages) unique.set(messageId(chat.threadKey, m), m);
  const messages = [...unique.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const byDay = new Map<string, KondoMessage[]>();
  for (const m of messages) {
    const day = utcDay(Date.parse(m.time));
    if (fromDay && day < fromDay) continue;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(m);
    else byDay.set(day, [m]);
  }
  if (byDay.size === 0) return [];

  const people = roster(chat, messages, ctx.ownerUrn);
  const chatName = people.others.length > 0 ? people.others.join(", ") : "LinkedIn conversation";
  const labels = chat.labelKeys.map((k) => ctx.labels[k]).filter((n): n is string => !!n);
  const sourceUrl = chatUrl(chat.chatUrl);
  const docs: DocumentInput[] = [];
  for (const [day, dayMessages] of byDay) {
    const doc = renderDay(chat, day, dayMessages, {
      ctx,
      people,
      chatName,
      labels,
      sourceUrl,
    });
    if (doc) docs.push(doc);
  }
  return docs;
}

function renderDay(
  chat: KondoChat,
  day: string,
  messages: KondoMessage[],
  shared: {
    ctx: NormalizeContext;
    people: Roster;
    chatName: string;
    labels: string[];
    sourceUrl?: string;
  },
): DocumentInput | null {
  const rendered = messages
    .map((m) => {
      const text = (m.text ?? "").trim();
      if (!text) return null;
      const who =
        m.self === true
          ? (cleanPersonName(m.sender ?? undefined) ?? shared.people.selfName ?? "You")
          : (cleanPersonName(m.sender ?? undefined) ?? "Unknown");
      return { message: m, line: `**${formatTime(m.time)}** ${who}: ${text}` };
    })
    .filter((r): r is { message: KondoMessage; line: string } => r !== null);
  if (rendered.length === 0) return null;

  const selfMessages = rendered.filter((r) => r.message.self === true);
  const lastRendered = rendered[rendered.length - 1].message;
  const lastSelf = selfMessages[selfMessages.length - 1]?.message;

  const title = `LinkedIn chat with ${shared.chatName} — ${day}`;
  const lines = [`# ${title}`, ""];
  let length = lines[0].length + 1;
  let shown = 0;
  for (const { line } of rendered) {
    if (length + line.length > MAX_CONTENT_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    shown++;
  }
  const omitted = rendered.length - shown;
  if (omitted > 0) lines.push("", `_… ${omitted} more messages not shown_`);
  const content = lines.join("\n");

  return {
    providerId: shared.ctx.providerId,
    sourceId: shared.ctx.sourceId,
    externalId: chatDayExternalId(chat.threadKey, day),
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      ...(shared.sourceUrl ? { sourceUrl: shared.sourceUrl } : {}),
      documentType: "conversation",
      tags: shared.labels,
      people: shared.people.people,
      extra: {
        threadKey: chat.threadKey,
        conversationId: chat.threadKey,
        chatName: shared.chatName,
        isGroup: shared.people.others.length > 1,
        messageCount: rendered.length,
        participants: shared.people.others,
        labels: shared.labels,
        archived: shared.ctx.archived,
        date: day,
        // The inbox is the LinkedIn member the chat was read as: the id a
        // connector names to act as the owner in this thread. Kondo's chat
        // always carries it; it is also the owner's own member id.
        inboxProfileId: chat.profileUrn,
        participantProfileIds: shared.people.otherProfileIds,
        direction: selfMessages.length === 0 ? "received" : "sent",
        selfMessageCount: selfMessages.length,
        lastMessageFromSelf: lastRendered.self === true,
        ...(lastSelf ? { lastSelfMessageAt: new Date(lastSelf.time).toISOString() } : {}),
      },
    },
    sourceCreatedAt: new Date(rendered[0].message.time).toISOString(),
    sourceUpdatedAt: new Date(rendered[rendered.length - 1].message.time).toISOString(),
  };
}
