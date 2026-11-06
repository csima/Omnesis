// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { createLogger, computeContentHash } from "@omnesis/core";
import { syncPage } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { SlackClient, AUTH_REMEDIATION } from "./client.js";
import { normalizeDay } from "./normalizer.js";
import { readPositions } from "./read-positions.js";
import { schemasFor } from "./schemas.js";
import {
  accountKey,
  conversationSchema,
  DAY,
  dayOf,
  messageSchema,
  permalink,
  slackTs,
  tsMs,
  userSchema,
} from "./types.js";
import type {
  SourceHost,
  SyncOptions,
  StructuredSyncResult,
  TableWrite,
} from "@omnesis/source-sdk";
import type { SourceId, ProviderId } from "@omnesis/types";
import type { SlackCursor } from "./state.js";
import type { Credential, Identity, Message, SlackUser, Conversation } from "./types.js";

const log = createLogger("source:slack");
const sql = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const midnight = (ms: number): number => Math.floor(ms / DAY) * DAY;
export interface SlackSourceOptions {
  accountId: string;
  sourceId: SourceId;
  providerId: ProviderId;
  session: boolean;
  historyDays: number;
  host: Pick<SourceHost, "now" | "analytics">;
  dataCutoff?: string;
  acquire(signal?: AbortSignal): Promise<Credential>;
  clientOptions?: ConstructorParameters<typeof SlackClient>[1];
}
export class SlackSource {
  get analyticsSchemas() {
    return schemasFor(this.options.session);
  }
  private runtime?: { client: SlackClient; identity: Identity; users: SlackUser[] };
  constructor(private readonly options: SlackSourceOptions) {}
  dispose(): void {
    this.runtime = undefined;
  }
  async sync(cursor: SlackCursor | null, opts?: SyncOptions) {
    const r = await this.syncStructured(cursor, opts);
    return syncPage(r.documents ?? [], r.cursor, {
      hasMore: r.hasMore,
      deletedExternalIds: r.deletedExternalIds,
      progress: r.progress,
    });
  }

  async syncStructured(
    prior: SlackCursor | null,
    opts?: SyncOptions,
  ): Promise<StructuredSyncResult<SlackCursor>> {
    try {
      const result = await this.run(prior, opts?.signal);
      if (this.options.session && result.analytics) {
        const writes = Array.isArray(result.analytics)
          ? result.analytics
          : [result.analytics as TableWrite];
        result.analytics = writes.map((w) => ({
          ...w,
          tableName: w.tableName.replace("slack_", "slack_session_"),
        }));
      }
      if (!result.hasMore) this.dispose();
      return result;
    } catch (err) {
      this.dispose();
      if (
        err instanceof SyncError &&
        err.kind === "permission" &&
        err.scope === "partition" &&
        prior?.pending
      ) {
        const cursor = structuredClone(prior);
        const pending = cursor.pending!;
        const skipped = pending.queue.shift();
        delete pending.day;
        delete pending.incrementalDone;
        if (!pending.queue.length) delete cursor.pending;
        log.warn(`Conversation ${skipped?.id ?? "unknown"} unavailable; preserving its history`);
        return {
          cursor,
          hasMore: !!cursor.pending,
          documents: [],
          issues: [
            {
              scope: "partition",
              kind: "permission",
              count: 1,
              subject: skipped?.id,
              message: "Conversation unreadable; its prior history was preserved",
            },
          ],
        };
      }
      if (err instanceof SyncError) throw err;
      opts?.signal?.throwIfAborted();
      throw new SyncError("transient", "Slack sync could not complete; checkpoint preserved");
    }
  }
  private async query(query: string): Promise<Record<string, unknown>[]> {
    if (!this.options.host.analytics)
      throw new SyncError("unknown", "Slack requires a source-scoped analytics host");
    const result = await this.options.host.analytics.query(
      this.options.session
        ? query.replace(/slack_(messages|days|read_positions|usergroups)/g, "slack_session_$1")
        : query,
      { limit: 100_000 },
    );
    if (result.rows.length >= 100_000)
      throw new SyncError(
        "transient",
        "Slack day exceeds the safe reconciliation row limit; checkpoint preserved",
      );
    return result.rows;
  }

  private async run(
    prior: SlackCursor | null,
    signal?: AbortSignal,
  ): Promise<StructuredSyncResult<SlackCursor>> {
    const o = this.options;
    signal?.throwIfAborted();
    const now = o.host.now().getTime();
    const cur: SlackCursor = prior
      ? structuredClone(prior)
      : { v: 1, startedAt: now, channels: {} };
    // Refresh once each cycle (and after a collector restart or a failed page). Nothing durable holds it.
    if (!this.runtime || !cur.pending) {
      const credential = await o.acquire(signal);
      const client = new SlackClient(credential, o.clientOptions);
      const auth = await client.call("auth.test", {}, signal);
      if (
        auth.team_id !== credential.identity.team_id ||
        auth.user_id !== credential.identity.user_id ||
        accountKey(credential.identity) !== o.accountId
      )
        throw new SyncError("auth", "Slack account identity changed", {
          remediation: AUTH_REMEDIATION,
        });
      let users: SlackUser[];
      try {
        users = (await client.list("users.list", "members", {}, signal)).map((v) =>
          userSchema.parse(v),
        );
      } catch (err) {
        if (err instanceof SyncError) throw err;
        throw new SyncError("transient", "Slack people listing was incomplete");
      }
      this.runtime = { client, identity: credential.identity, users };
    }
    const { client, identity, users } = this.runtime;
    const owner = o.accountId;
    const ownerWhere = `source_account_id=${sql(owner)}`;
    if (!cur.pending) {
      const conversations = (
        await client.list(
          "conversations.list",
          "channels",
          { types: "public_channel,private_channel,im,mpim", exclude_archived: "true" },
          signal,
        )
      )
        .map((v) => conversationSchema.parse(v))
        .filter((c) => !c.is_archived && (c.is_im || c.is_mpim || c.is_member === true));
      const active = new Set(
        Object.entries(cur.channels)
          .filter(([, s]) => s.newest && tsMs(s.newest) >= now - 30 * DAY)
          .map(([id]) => id),
      );
      const markers = await readPositions(
        client,
        o.session,
        conversations,
        identity,
        owner,
        now,
        active,
        signal,
      );
      const groups = await client.call("usergroups.list", { include_users: "true" }, signal);
      if (!Array.isArray(groups.usergroups))
        throw new SyncError("transient", "Slack group membership listing was incomplete");
      const memberships: Record<string, unknown>[] = [];
      for (const raw of groups.usergroups) {
        if (!raw || typeof raw !== "object")
          throw new SyncError("transient", "Slack group membership listing was malformed");
        const g = raw as Record<string, unknown>;
        if (
          typeof g.id !== "string" ||
          !Array.isArray(g.users) ||
          !g.users.every((u) => typeof u === "string")
        )
          throw new SyncError("transient", "Slack group membership listing was incomplete");
        if (g.users.includes(identity.user_id))
          memberships.push({ source_account_id: owner, group_id: g.id });
      }
      cur.pending = {
        cut: now,
        deep: !cur.lastDeepAt || now - cur.lastDeepAt >= DAY,
        queue: conversations,
      };
      const analytics: TableWrite[] = [
        { tableName: "slack_read_positions", records: markers },
        { tableName: "slack_usergroups", deletedKeys: [{ source_account_id: owner }] },
        { tableName: "slack_usergroups", records: memberships },
      ];
      log.info(`Cycle started for ${o.accountId}: ${conversations.length} conversations`);
      if (!conversations.length) {
        if (cur.pending.deep) cur.lastDeepAt = now;
        delete cur.pending;
      }
      return {
        analytics,
        cursor: cur,
        hasMore: !!cur.pending,
        documents: [],
        progress: {
          phase: prior ? "incremental" : "bootstrap",
          processed: 0,
          total: conversations.length,
        },
      };
    }
    const p = cur.pending;
    const c = p.queue[0];
    if (!c) {
      delete cur.pending;
      return { cursor: cur, hasMore: false, documents: [] };
    }
    const initialFloor = Math.max(
      cur.startedAt - o.historyDays * DAY,
      o.dataCutoff ? Date.parse(o.dataCutoff) : 0,
    );
    const previous = cur.channels[c.id];
    // First import is bounded once. It never becomes a retention deadline.
    const reconciliationStart = midnight(p.cut - (p.deep ? 30 : 14) * DAY);
    const start = previous?.complete
      ? midnight(Math.min(Date.parse(previous.through!), reconciliationStart))
      : midnight(initialFloor);
    let dayStart = p.day ? Date.parse(p.day) : start;
    dayStart = Math.max(dayStart, midnight(initialFloor));
    const day = new Date(dayStart).toISOString().slice(0, 10);
    const end = Math.min(dayStart + DAY, p.cut);
    const scope = `${ownerWhere} AND conversation_id=${sql(c.id)} AND day=${sql(day)}`;
    // Fetch a full day so a trailing-window boundary never replaces a partial daily rollup.
    if (previous?.newest && !p.incrementalDone) {
      // Incremental fetch is independent from the bounded reconciliation read.
      // The complete day reads below merge it into stable UTC rollups; failures
      // cannot promote either watermark ahead of the documents they describe.
      await client.list(
        "conversations.history",
        "messages",
        { channel: c.id, oldest: previous.newest, latest: slackTs(p.cut), inclusive: "false" },
        signal,
      );
      p.incrementalDone = true;
    }
    const oldest = slackTs(Math.max(dayStart, initialFloor));
    const latest = slackTs(end);
    const existing = await this.query(`SELECT raw FROM slack_messages WHERE ${scope}`);
    if (existing.length >= 100_000)
      throw new SyncError("transient", "Slack day exceeded the safe read bound");
    const stored = existing.map((r) =>
      messageSchema.parse(typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw),
    );
    const threadOnly = previous?.complete && !p.deep && dayStart + DAY <= midnight(p.cut - 7 * DAY);
    const raw = threadOnly
      ? stored
      : await client.list(
          "conversations.history",
          "messages",
          { channel: c.id, oldest, latest, inclusive: "true" },
          signal,
        );
    const roots = parseMessages(raw).filter(
      (m) =>
        tsMs(m.ts) < end &&
        tsMs(m.ts) >= Math.max(dayStart, initialFloor) &&
        (!m.thread_ts || m.thread_ts === m.ts),
    );
    const messages: Message[] = [];
    for (const root of roots) {
      messages.push(root);
      const oldRoot = stored.find((m) => m.ts === root.ts);
      if (
        (root.reply_count ?? 0) > 0 ||
        stored.some((m) => m.thread_ts === root.ts && m.ts !== root.ts)
      ) {
        if (
          tsMs(root.ts) >= p.cut - 14 * DAY ||
          root.latest_reply !== oldRoot?.latest_reply ||
          !previous?.complete ||
          p.deep
        ) {
          const replies = parseMessages(
            await client.list(
              "conversations.replies",
              "messages",
              {
                channel: c.id,
                ts: root.ts,
                oldest: slackTs(initialFloor),
                latest: slackTs(p.cut),
                inclusive: "true",
              },
              signal,
            ),
          );
          messages.push(
            ...replies
              .filter((m) => m.ts !== root.ts && tsMs(m.ts) >= initialFloor && tsMs(m.ts) <= p.cut)
              .map((m) => ({ ...m, thread_ts: root.ts })),
          );
        } else messages.push(...stored.filter((m) => m.thread_ts === root.ts && m.ts !== root.ts));
      }
    }
    // Roots aged 7–14 days also need reply checks between daily deep reads.
    // They are scheduled below as complete day reads, avoiding partial rollups.
    const document = normalizeDay(c, day, messages, users, identity, o);
    const hashes = await this.query(`SELECT hash FROM slack_days WHERE ${scope}`);
    // Include complete message rows: edits beyond a bounded preview still update analytics.
    const hash = document
      ? computeContentHash(JSON.stringify(messages) + document.contentHash)
      : "";
    const changed = hashes[0]?.hash !== hash;
    const analytics: TableWrite[] = [];
    if (changed) {
      analytics.push(
        {
          tableName: "slack_messages",
          deletedKeys: [{ source_account_id: owner, conversation_id: c.id, day }],
        },
        {
          tableName: "slack_messages",
          records: messages.map((m) => ({
            source_account_id: owner,
            conversation_id: c.id,
            day,
            ts: m.ts,
            thread_ts: m.thread_ts ?? m.ts,
            user_id: m.user ?? null,
            text: m.text,
            raw: JSON.stringify(m),
            posted_at: new Date(tsMs(m.ts)).toISOString(),
            source_url: permalink(identity, c.id, m.ts),
            self_id: identity.user_id,
          })),
        },
        {
          tableName: "slack_days",
          records: [{ source_account_id: owner, conversation_id: c.id, day, hash }],
        },
      );
    }
    const newest = roots.reduce((max, m) => (m.ts > max ? m.ts : max), previous?.newest ?? "");
    cur.channels[c.id] = {
      ...previous,
      ...(newest ? { newest } : {}),
      through: new Date(end).toISOString(),
    };
    if (dayStart + DAY < p.cut) p.day = new Date(dayStart + DAY).toISOString();
    else {
      cur.channels[c.id].complete = true;
      p.queue.shift();
      delete p.day;
      delete p.incrementalDone;
    }
    if (!p.queue.length) {
      if (p.deep) cur.lastDeepAt = p.cut;
      delete cur.pending;
    }
    return {
      documents: changed && document ? [document] : [],
      deletedExternalIds: changed && !document && hashes.length ? [`${c.id}:${day}`] : [],
      analytics,
      cursor: cur,
      hasMore: !!cur.pending,
      progress: {
        phase: previous ? "incremental" : "bootstrap",
        processed: Object.keys(cur.channels).length,
        detail: `${c.id} · ${day}`,
      },
    };
  }
}
function parseMessages(raw: unknown[]): Message[] {
  const out: Message[] = [];
  for (const v of raw) {
    const r = messageSchema.safeParse(v);
    // Malformed reads are not evidence of deletion; retry the complete day.
    if (!r.success)
      throw new SyncError("transient", "Slack message page was malformed; reconciliation withheld");
    if (
      r.data.subtype === "message_deleted" ||
      r.data.subtype === "channel_join" ||
      r.data.subtype === "channel_leave"
    )
      continue;
    out.push(r.data);
  }
  return out;
}
