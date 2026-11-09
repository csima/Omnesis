// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { cleanPersonName, computeContentHash } from "@omnesis/core";
import { conversationKind, permalink, tsMs } from "./types.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { Conversation, Identity, Message, SlackUser } from "./types.js";

export const MAX_CONTENT_CHARS = 200_000;

export function slackLid(workspace: string, user: string): string {
  return `slack:${workspace}-${user}`;
}
export function normalizeDay(
  conversation: Conversation,
  day: string,
  messages: Message[],
  users: SlackUser[],
  identity: Identity,
  ids: { providerId: ProviderId; sourceId: SourceId; session?: boolean },
): DocumentInput | null {
  if (!messages.length) return null;
  const byId = new Map(users.map((u) => [u.id, u]));
  const name = (id: string): string =>
    cleanPersonName(byId.get(id)?.profile?.display_name) ??
    cleanPersonName(byId.get(id)?.profile?.real_name) ??
    cleanPersonName(byId.get(id)?.name) ??
    "Slack participant";
  const people: PersonMention[] = [];
  const added = new Set<string>();
  const add = (id: string, role: "participant" | "mentioned"): void => {
    if (added.has(id) || byId.get(id)?.is_bot) return;
    added.add(id);
    people.push({
      name: name(id),
      role,
      lids: [slackLid(identity.team_id, id)],
      ...(byId.get(id)?.profile?.email
        ? { emails: [byId.get(id)!.profile!.email!.trim().toLowerCase()] }
        : {}),
      ...(id === identity.user_id ? { isSelf: true } : {}),
    });
  };
  for (const m of messages) if (m.user) add(m.user, "participant");
  for (const m of messages)
    for (const match of m.text.matchAll(/<@([A-Z0-9]+)>/g)) add(match[1], "mentioned");
  const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
  // Replies follow their root, even when they were posted on a later UTC day.
  const roots = sorted.filter((m) => !m.thread_ts || m.thread_ts === m.ts);
  const lines: string[] = [];
  const render = (m: Message): string =>
    `**${new Date(tsMs(m.ts)).toISOString()}** ${m.user ? name(m.user) : "Slack"}: ${m.text.replace(/<@([A-Z0-9]+)>/g, (_, id: string) => "@" + name(id))}${(m.files ?? []).map((f) => ` [File: ${f.name ?? "file"}${f.permalink ? " — " + f.permalink : ""}]`).join("")}${m.edited ? " _(edited)_" : ""}`;
  for (const root of roots) {
    lines.push(render(root));
    for (const reply of sorted.filter((m) => m.thread_ts === root.ts && m.ts !== root.ts))
      lines.push("  ↳ " + render(reply));
  }
  const title = `${identity.team} · ${conversation.name ?? conversation.user ?? conversation.id} — ${day}`;
  const fullContent = `# ${title}\n\n${lines.join("\n\n")}`;
  const notice = "\n\n_Conversation preview truncated; full messages remain in analytics._";
  const content =
    fullContent.length > MAX_CONTENT_CHARS
      ? fullContent.slice(0, MAX_CONTENT_CHARS - notice.length) + notice
      : fullContent;
  return {
    providerId: ids.providerId,
    sourceId: ids.sourceId,
    externalId: `${conversation.id}:${day}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      sourceUrl: permalink(identity, conversation.id, roots[0]?.ts ?? sorted[0].ts),
      people,
      extra: {
        workspaceName: identity.team,
        connectionMode: ids.session ? "session" : "official",
        conversationName: conversation.name ?? conversation.id,
        conversationKind: conversationKind(conversation),
        messageCount: messages.length,
        isGroup: !conversation.is_im,
        participants: people.filter((p) => p.role === "participant").map((p) => p.name),
        date: day,
      },
    },
    sourceCreatedAt: new Date(tsMs(sorted[0].ts)).toISOString(),
    sourceUpdatedAt: new Date(
      messages.reduce((latest, m) => Math.max(latest, tsMs(m.edited?.ts ?? m.ts)), 0),
    ).toISOString(),
  };
}
