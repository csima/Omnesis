// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/** Fictional Slack server behind the HTTP transport seam, including real URL/body parsing. */
import type { SourceAnalyticsAccess, TableWrite } from "@omnesis/source-sdk";
import type { Conversation, Credential, Message } from "./types.js";
export const IDENTITY = {
  team_id: "TEXAMPLE",
  user_id: "USELF00",
  team: "Example Workshop",
  url: "https://example-workshop.slack.com/",
};
export const CREDENTIAL: Credential = { token: "fictional-token", identity: IDENTITY };
export const CHANNEL: Conversation = { id: "CEXAMPLE", name: "workshop", is_member: true };
export class FakeSlack {
  conversations: Conversation[] = [CHANNEL];
  messages: Message[] = [];
  calls: Array<{
    method: string;
    params: URLSearchParams;
    redirect: RequestRedirect | undefined;
    url: string;
  }> = [];
  forbidden = new Set<string>();
  failing = new Set<string>();
  authError = false;
  restrictedUser = false;
  rateLimit = false;
  rateLimitWhen?: (method: string, params: URLSearchParams) => boolean;
  outage = false;
  malformed = false;
  markers: Record<string, unknown>[] = [];
  fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(String(input), init));
  private respond(url: string, init: RequestInit | undefined): Response {
    const method = url.split("/").at(-1)!;
    const params = new URLSearchParams(String(init?.body));
    this.calls.push({ method, params, redirect: init?.redirect, url });
    if (this.rateLimitWhen?.(method, params)) {
      this.rateLimitWhen = undefined;
      return new Response("", { status: 429, headers: { "Retry-After": "3" } });
    }
    if (this.rateLimit) {
      this.rateLimit = false;
      return new Response("", { status: 429, headers: { "Retry-After": "3" } });
    }
    if (this.outage) return new Response("", { status: 503 });
    const data: Record<string, unknown> = { ok: true };
    const channel = params.get("channel") ?? "";
    if (this.forbidden.has(channel) && method.startsWith("conversations."))
      return Response.json({ ok: false, error: "not_in_channel" });
    if (this.failing.has(channel) && /^conversations\.(history|replies)$/.test(method))
      return Response.json({ ok: false, error: "internal_error" });
    const page = (rows: unknown[]): unknown[] => {
      const offset = Number(params.get("cursor") || 0);
      data.response_metadata = { next_cursor: offset + 2 < rows.length ? String(offset + 2) : "" };
      return rows.slice(offset, offset + 2);
    };
    if (method === "auth.test")
      Object.assign(data, this.authError ? { ok: false, error: "invalid_auth" } : IDENTITY);
    if (method === "users.list")
      data.members = page([
        {
          id: "USELF00",
          name: "self",
          profile: { display_name: "Alex Example", email: "alex@example.com" },
        },
        {
          id: "UOTHER0",
          name: "river",
          profile: { display_name: "River Example", email: "river@example.com" },
        },
      ]);
    if (method === "usergroups.list") {
      if (this.restrictedUser) return Response.json({ ok: false, error: "user_is_restricted" });
      data.usergroups = [{ id: "SEXAMPLE", users: ["USELF00"] }];
    }
    if (method === "users.conversations") data.channels = page(this.conversations);
    if (method === "conversations.info")
      data.channel = {
        ...this.conversations.find((c) => c.id === channel),
        last_read: "0000000000.000000",
      };
    if (method === "client.counts") data.channels = this.markers;
    if (method === "conversations.history" || method === "conversations.replies") {
      const oldest = Number(params.get("oldest")),
        latest = Number(params.get("latest"));
      const rows = this.messages.filter(
        (m) =>
          Number(m.ts) >= oldest &&
          Number(m.ts) <= latest &&
          (method === "conversations.replies"
            ? (m.thread_ts ?? m.ts) === params.get("ts")
            : !m.thread_ts || m.thread_ts === m.ts),
      );
      if (method === "conversations.history") rows.sort((a, b) => Number(b.ts) - Number(a.ts));
      data.messages = this.malformed ? [{ text: "invalid" }] : page(rows);
    }
    return Response.json(data);
  }
}
export class MemoryAnalytics implements SourceAnalyticsAccess {
  tables = new Map<string, Record<string, unknown>[]>();
  query(sql: string) {
    const table = sql.match(/FROM (\w+)/)?.[1] ?? "";
    const clauses = [
      ...sql.matchAll(/(source_account_id|conversation_id|day)(>?=)'((?:[^']|'')*)'/g),
    ].map((m) => ({ key: m[1], atLeast: m[2] === ">=", value: m[3].replaceAll("''", "'") }));
    const rows = (this.tables.get(table) ?? []).filter((r) =>
      clauses.every(({ key, atLeast, value }) =>
        atLeast ? String(r[key]) >= value : r[key] === value,
      ),
    );
    // SQL promises no order without ORDER BY; reversing insertion order makes a missing one visible.
    if (/ORDER BY ts$/.test(sql)) rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    else rows.reverse();
    return Promise.resolve({ columns: [], rows: structuredClone(rows) });
  }
  commit(writes: TableWrite | readonly TableWrite[] | undefined): void {
    for (const w of writes ? (Array.isArray(writes) ? writes : [writes as TableWrite]) : []) {
      let rows = this.tables.get(w.tableName) ?? [];
      for (const k of w.deletedKeys ?? [])
        rows = rows.filter((r) => !Object.entries(k).every(([key, v]) => r[key] === v));
      for (const row of w.records ?? []) {
        const keys = w.tableName.endsWith("_messages")
          ? ["source_account_id", "conversation_id", "day", "ts"]
          : w.tableName.endsWith("_days")
            ? ["source_account_id", "conversation_id", "day"]
            : w.tableName.endsWith("_usergroups")
              ? ["source_account_id", "group_id"]
              : ["source_account_id", "conversation_id"];
        rows = rows.filter((r) => !keys.every((k) => r[k] === row[k]));
        rows.push(structuredClone(row));
      }
      this.tables.set(w.tableName, rows);
    }
  }
}
