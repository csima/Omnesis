// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { tsSchema, conversationKind } from "./types.js";
import type { SlackClient } from "./client.js";
import type { Conversation, Identity } from "./types.js";
export async function readPositions(
  client: SlackClient,
  session: boolean,
  conversations: Conversation[],
  identity: Identity,
  owner: string,
  now: number,
  active: Set<string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const add = (conversation: Conversation, value: Record<string, unknown>): void => {
    if (!tsSchema.safeParse(value.last_read).success) return;
    const threads: Record<string, string> = {};
    // client.counts may omit thread markers. Never infer them from unread counts.
    if (Array.isArray(value.threads))
      for (const v of value.threads) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;
        if (tsSchema.safeParse(t.thread_ts).success && tsSchema.safeParse(t.last_read).success)
          threads[String(t.thread_ts)] = String(t.last_read);
      }
    rows.push({
      source_account_id: owner,
      workspace_id: identity.team_id,
      conversation_id: conversation.id,
      kind: conversationKind(conversation),
      last_read: value.last_read,
      thread_reads: JSON.stringify(threads),
      observed_at: new Date(now).toISOString(),
    });
  };
  if (session) {
    const data = await client.call(
      "client.counts",
      { thread_counts_by_channel: "true", org_wide_aware: "true", include_file_channels: "true" },
      signal,
    );
    const byId = new Map(conversations.map((c) => [c.id, c]));
    for (const key of ["channels", "groups", "ims", "mpims"])
      if (Array.isArray(data[key]))
        for (const v of data[key]) {
          if (!v || typeof v !== "object") continue;
          const row = v as Record<string, unknown>;
          const c = byId.get(String(row.id));
          if (c) add(c, row);
        }
  } else {
    for (const c of conversations) {
      if (!c.is_im && !c.is_mpim && !active.has(c.id)) continue;
      try {
        const data = await client.call("conversations.info", { channel: c.id }, signal);
        if (data.channel && typeof data.channel === "object")
          add(c, data.channel as Record<string, unknown>);
      } catch (err) {
        // Only permission failures are partial coverage. Outages/auth/rate limits retry the page.
        if (!(err instanceof Error) || !("kind" in err) || err.kind !== "permission") throw err;
      }
    }
  }
  return rows;
}
