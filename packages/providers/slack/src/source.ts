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
import type { SourceId, ProviderId, SyncErrorKind } from "@omnesis/types";
import type { SlackCursor } from "./state.js";
import type { Credential, Identity, Message, SlackUser } from "./types.js";

const log = createLogger("source:slack");
const sql = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const midnight = (ms: number): number => Math.floor(ms / DAY) * DAY;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isRoot = (m: Message): boolean => !m.thread_ts || m.thread_ts === m.ts;
const byTs = (a: Message, b: Message): number => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const storedMessage = (row: Record<string, unknown>): Message =>
  messageSchema.parse(typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw);
/** A conversation failing the same way this many attempts in a row is skipped for the cycle. */
const STRIKES = 3;
const QUERY_ROW_LIMIT = 10_000;
const STRIKE_KINDS: ReadonlySet<SyncErrorKind> = new Set(["transient", "network", "unknown"]);
type Pending = NonNullable<SlackCursor["pending"]>;
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
  private runtime?: { client: SlackClient; identity: Identity; users?: SlackUser[] };
  private strike?: { key: string; count: number };
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
      this.strike = undefined;
      this.runtime?.client.settle();
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
      // A rate limit keeps the client, so the retry replays this page's completed reads.
      if (!(err instanceof SyncError && err.kind === "rate-limit")) this.dispose();
      opts?.signal?.throwIfAborted();
      const failure =
        err instanceof SyncError
          ? err
          : new SyncError("transient", "Slack sync could not complete; checkpoint preserved");
      const head = prior?.pending?.queue[0];
      if (!prior?.pending || !head) throw failure;
      if (failure.kind === "permission" && failure.scope === "partition")
        return skipHead(
          prior,
          "permission",
          "Conversation unreadable; its prior history was preserved",
        );
      if (!STRIKE_KINDS.has(failure.kind)) throw failure;
      const key = JSON.stringify([
        head.id,
        prior.pending.day ?? null,
        failure.kind,
        failure.message,
      ]);
      const count = this.strike?.key === key ? this.strike.count + 1 : 1;
      if (count < STRIKES) {
        this.strike = { key, count };
        throw failure;
      }
      this.strike = undefined;
      return skipHead(
        prior,
        failure.kind,
        `Conversation failed ${STRIKES} times in a row; skipped this cycle and its prior history was preserved`,
      );
    }
  }
  private async query(query: string): Promise<Record<string, unknown>[] | null> {
    if (!this.options.host.analytics)
      throw new SyncError("unknown", "Slack requires a source-scoped analytics host");
    const result = await this.options.host.analytics.query(
      this.options.session
        ? query.replace(/slack_(messages|days|read_positions|usergroups)/g, "slack_session_$1")
        : query,
      { limit: QUERY_ROW_LIMIT },
    );
    return result.rows.length >= QUERY_ROW_LIMIT ? null : result.rows;
  }
  private async rows(query: string): Promise<Record<string, unknown>[]> {
    const rows = await this.query(query);
    if (!rows)
      throw new SyncError(
        "transient",
        "Slack day exceeds the safe reconciliation row limit; checkpoint preserved",
      );
    return rows;
  }

  /** One history read proves a conversation unchanged across the per-cycle reconciliation window. */
  private async quiet(
    client: SlackClient,
    conversation: string,
    newest: string,
    from: number,
    cut: number,
    floor: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const inWindow = (m: Message): boolean =>
      isRoot(m) && tsMs(m.ts) >= Math.max(from, floor) && tsMs(m.ts) < cut;
    // History arrives newest first, so a new root ends the read on its first page.
    const fresh = parseMessages(
      await client.list(
        "conversations.history",
        "messages",
        { channel: conversation, oldest: slackTs(from), latest: slackTs(cut), inclusive: "true" },
        signal,
        (page) =>
          page.some((v) => {
            const m = messageSchema.safeParse(v);
            return m.success && inWindow(m.data) && m.data.ts > newest;
          }),
      ),
    )
      .filter(inWindow)
      .sort(byTs);
    const window = await this.query(
      `SELECT raw FROM slack_messages WHERE source_account_id=${sql(this.options.accountId)} AND conversation_id=${sql(conversation)} AND day>=${sql(utcDay(from))} ORDER BY ts`,
    );
    if (!window) return false;
    const kept = window.map(storedMessage).filter(inWindow).sort(byTs);
    return JSON.stringify(fresh) === JSON.stringify(kept);
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
    // Acquired once each cycle (and after a collector restart or a failed page). Nothing durable holds it.
    if (!this.runtime) {
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
      this.runtime = { client, identity: credential.identity };
    }
    const runtime = this.runtime;
    const { client, identity } = runtime;
    if (!cur.pending || !runtime.users) runtime.users = await listUsers(client, signal);
    const users = runtime.users;
    const owner = o.accountId;
    const ownerWhere = `source_account_id=${sql(owner)}`;
    if (!cur.pending) {
      const conversations = (
        await client.list(
          "users.conversations",
          "channels",
          { types: "public_channel,private_channel,im,mpim", exclude_archived: "true" },
          signal,
        )
      )
        .map((v) => conversationSchema.parse(v))
        .filter((c) => !c.is_archived);
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
        ...(markers.length ? [{ tableName: "slack_read_positions", records: markers }] : []),
        { tableName: "slack_usergroups", deletedKeys: [{ source_account_id: owner }] },
        ...(memberships.length ? [{ tableName: "slack_usergroups", records: memberships }] : []),
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
    const previous = cur.channels[c.id];
    const cutoffMs = o.dataCutoff ? Date.parse(o.dataCutoff) : NaN;
    const cutoff = Number.isFinite(cutoffMs) ? midnight(cutoffMs) : 0;
    // A first import is bounded once, from the cycle that first sees the conversation, in whole UTC days.
    // It never becomes a retention deadline; the data cutoff applies at day granularity throughout.
    const floor = previous?.complete
      ? cutoff
      : Math.max(cutoff, midnight(p.cut - o.historyDays * DAY));
    const through = previous?.through ? Date.parse(previous.through) : 0;
    const reconciliationStart = midnight(p.cut - (p.deep ? 30 : 14) * DAY);
    if (
      !p.day &&
      previous?.complete &&
      !p.deep &&
      through >= reconciliationStart &&
      (await this.quiet(
        client,
        c.id,
        previous.newest ?? "",
        reconciliationStart,
        p.cut,
        floor,
        signal,
      ))
    ) {
      cur.channels[c.id] = {
        ...previous,
        through: new Date(Math.max(through, p.cut)).toISOString(),
      };
      finish(cur, p);
      return {
        documents: [],
        cursor: cur,
        hasMore: !!cur.pending,
        progress: {
          phase: "incremental",
          processed: Object.keys(cur.channels).length,
          detail: c.id,
        },
      };
    }
    const start = previous?.complete ? midnight(Math.min(through, reconciliationStart)) : floor;
    const dayStart = Math.max(p.day ? Date.parse(p.day) : start, floor);
    const day = utcDay(dayStart);
    const end = Math.min(dayStart + DAY, p.cut);
    const scope = `${ownerWhere} AND conversation_id=${sql(c.id)} AND day=${sql(day)}`;
    const stored = (
      await this.rows(`SELECT raw FROM slack_messages WHERE ${scope} ORDER BY ts`)
    ).map(storedMessage);
    // Stored rows stand in for a day only when an earlier cycle fetched that whole day.
    const threadOnly =
      previous?.complete &&
      !p.deep &&
      dayStart + DAY <= midnight(p.cut - 7 * DAY) &&
      dayStart + DAY <= through;
    // Fetch a full day so a trailing-window boundary never replaces a partial daily rollup.
    const raw = threadOnly
      ? stored
      : await client.list(
          "conversations.history",
          "messages",
          { channel: c.id, oldest: slackTs(dayStart), latest: slackTs(end), inclusive: "true" },
          signal,
        );
    const roots = parseMessages(raw)
      .filter((m) => tsMs(m.ts) < end && tsMs(m.ts) >= dayStart && isRoot(m))
      .sort(byTs);
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
                oldest: slackTs(floor),
                latest: slackTs(p.cut),
                inclusive: "true",
              },
              signal,
            ),
          );
          messages.push(
            ...replies
              .filter((m) => m.ts !== root.ts && tsMs(m.ts) >= floor && tsMs(m.ts) <= p.cut)
              .map((m) => ({ ...m, thread_ts: root.ts })),
          );
        } else messages.push(...stored.filter((m) => m.thread_ts === root.ts && m.ts !== root.ts));
      }
    }
    // Roots aged 7–14 days also need reply checks between daily deep reads.
    // They are scheduled below as complete day reads, avoiding partial rollups.
    const document = normalizeDay(c, day, messages, users, identity, {
      providerId: o.providerId,
      sourceId: o.sourceId,
      session: o.session,
    });
    const hashes = await this.rows(`SELECT hash FROM slack_days WHERE ${scope}`);
    // Include complete message rows: edits beyond a bounded preview still update analytics.
    const hash = document
      ? computeContentHash(JSON.stringify(messages) + document.contentHash)
      : "";
    const changed = hashes[0]?.hash !== hash;
    const analytics: TableWrite[] = [];
    if (changed) {
      analytics.push({
        tableName: "slack_messages",
        deletedKeys: [{ source_account_id: owner, conversation_id: c.id, day }],
      });
      if (messages.length)
        analytics.push({
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
            source_url: permalink(identity, c.id, m.ts, m.thread_ts),
            self_id: identity.user_id,
          })),
        });
      analytics.push({
        tableName: "slack_days",
        records: [{ source_account_id: owner, conversation_id: c.id, day, hash }],
      });
    }
    const newest = roots.reduce((max, m) => (m.ts > max ? m.ts : max), previous?.newest ?? "");
    cur.channels[c.id] = {
      ...previous,
      ...(newest ? { newest } : {}),
      through: new Date(Math.max(through, end)).toISOString(),
    };
    if (dayStart + DAY < p.cut) p.day = new Date(dayStart + DAY).toISOString();
    else {
      cur.channels[c.id].complete = true;
      finish(cur, p);
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
async function listUsers(client: SlackClient, signal?: AbortSignal): Promise<SlackUser[]> {
  try {
    return (await client.list("users.list", "members", {}, signal)).map((v) => userSchema.parse(v));
  } catch (err) {
    if (err instanceof SyncError) throw err;
    throw new SyncError("transient", "Slack people listing was incomplete");
  }
}
function finish(cur: SlackCursor, p: Pending): void {
  p.queue.shift();
  delete p.day;
  if (p.queue.length) return;
  if (p.deep) cur.lastDeepAt = p.cut;
  delete cur.pending;
}
function skipHead(
  prior: SlackCursor,
  kind: SyncErrorKind,
  message: string,
): StructuredSyncResult<SlackCursor> {
  const cursor = structuredClone(prior);
  const pending = cursor.pending!;
  const skipped = pending.queue.shift();
  delete pending.day;
  if (!pending.queue.length) delete cursor.pending;
  log.warn(`Conversation ${skipped?.id ?? "unknown"} skipped this cycle; preserving its history`);
  return {
    cursor,
    hasMore: !!cursor.pending,
    documents: [],
    issues: [{ scope: "partition", kind, count: 1, subject: skipped?.id, message }],
  };
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
