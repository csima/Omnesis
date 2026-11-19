// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { SlackSource } from "./source.js";
import { CHANNEL, CREDENTIAL, FakeSlack, IDENTITY, MemoryAnalytics } from "./fake-slack.js";
import { DAY, slackTs } from "./types.js";
import type { SlackCursor } from "./state.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
const NOW = Date.parse("2026-05-20T12:00:00Z");
const midnight = (ms: number) => Math.floor(ms / DAY) * DAY;
const writes = (analytics: StructuredSyncResult<SlackCursor>["analytics"]) =>
  analytics ? (Array.isArray(analytics) ? analytics : [analytics]) : [];
function harness(session = false) {
  const server = new FakeSlack(),
    db = new MemoryAnalytics();
  let now = NOW,
    acquires = 0;
  const options = {
    accountId: "TEXAMPLE-USELF00",
    sourceId: SourceId(session ? "slack-session:TEXAMPLE-USELF00" : "slack:TEXAMPLE-USELF00"),
    providerId: ProviderId("slack:TEXAMPLE-USELF00"),
    session,
    historyDays: 180,
    host: { now: () => new Date(now), analytics: db },
    dataCutoff: undefined as string | undefined,
    acquire: () => {
      acquires++;
      return Promise.resolve(CREDENTIAL);
    },
    clientOptions: { fetchImpl: server.fetch, paceMs: 0 },
  };
  const source = new SlackSource(options);
  return {
    server,
    db,
    source,
    options,
    acquires: () => acquires,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function cycle(h: ReturnType<typeof harness>, prior: SlackCursor | null = null) {
  let cursor = prior;
  const pages: StructuredSyncResult<SlackCursor>[] = [];
  for (let i = 0; i < 500; i++) {
    const r = await h.source.syncStructured(cursor);
    for (const w of writes(r.analytics)) expect(w.records?.length ?? 1).toBeGreaterThan(0);
    h.db.commit(r.analytics);
    cursor = r.cursor;
    pages.push(r);
    if (!r.hasMore)
      return {
        cursor,
        pages,
        docs: pages.flatMap((p) => p.documents ?? []),
        deleted: pages.flatMap((p) => p.deletedExternalIds ?? []),
      };
  }
  throw new Error("cycle did not terminate");
}
const msg = (ms: number, text = "Example message") => ({ ts: slackTs(ms), user: "UOTHER0", text });
describe("Slack sync", () => {
  it("bootstraps 180 whole UTC days, resumes mid-import with a new instance and pins every boundary", async () => {
    const h = harness();
    const firstDay = midnight(NOW - 180 * DAY);
    h.server.messages = [
      msg(NOW - 181 * DAY),
      msg(firstDay + 3600_000, "Start of the first whole day"),
      msg(NOW - 179 * DAY),
      msg(NOW - DAY),
    ];
    const first = await h.source.syncStructured(null);
    h.db.commit(first.analytics);
    const page = await h.source.syncStructured(first.cursor);
    h.db.commit(page.analytics);
    h.source.dispose();
    const replacement = new SlackSource(h.options);
    h.source = replacement;
    const result = await cycle(h, page.cursor);
    const docs = [...(page.documents ?? []), ...result.docs];
    expect(docs).toHaveLength(3);
    expect(docs[0].content).toContain("Start of the first whole day");
    for (const doc of docs)
      for (const key of ["session", "historyDays", "acquire", "host", "accountId"])
        expect(doc).not.toHaveProperty(key);
    const history = h.server.calls.filter((c) => c.method === "conversations.history");
    for (const call of history) {
      for (const key of ["oldest", "latest"]) expect(call.params.get(key)).toMatch(/^\d+\.\d{6}$/);
      expect(
        Number(call.params.get("latest")) - Number(call.params.get("oldest")),
      ).toBeLessThanOrEqual(DAY / 1000);
    }
    expect(Math.min(...history.map((c) => Number(c.params.get("oldest")) * 1000))).toBe(firstDay);
  });
  it("applies the data cutoff in whole UTC days", async () => {
    const h = harness();
    h.source = new SlackSource({ ...h.options, dataCutoff: "2026-05-10T15:00:00Z" });
    h.server.messages = [
      msg(Date.parse("2026-05-09T23:00:00Z"), "Day before the cutoff"),
      msg(Date.parse("2026-05-10T09:00:00Z"), "Morning of the cutoff day"),
    ];
    const result = await cycle(h);
    expect(result.docs.map((d) => d.externalId)).toEqual(["CEXAMPLE:2026-05-10"]);
    expect(result.docs[0].content).toContain("Morning of the cutoff day");
  });
  it("bootstraps a conversation joined after setup from when it is first seen", async () => {
    const h = harness();
    h.server.conversations = [];
    const first = await cycle(h);
    h.advance(100 * DAY);
    const now = NOW + 100 * DAY;
    h.server.conversations = [CHANNEL];
    h.server.messages = [
      msg(now - 200 * DAY, "Before the joined window"),
      msg(now - 170 * DAY, "Inside the joined window"),
    ];
    const joined = await cycle(h, first.cursor);
    expect(joined.docs).toHaveLength(1);
    expect(joined.docs[0].content).toContain("Inside the joined window");
    expect(
      Math.min(
        ...h.server.calls
          .filter((c) => c.method === "conversations.history")
          .map((c) => Number(c.params.get("oldest")) * 1000),
      ),
    ).toBe(midnight(now - 180 * DAY));
  });
  it("fetches every day of a gap longer than the reconciliation window", async () => {
    const h = harness();
    h.server.messages = [msg(NOW - DAY, "Before the gap")];
    const first = await cycle(h);
    h.advance(40 * DAY);
    h.server.conversations = [];
    const absent = await cycle(h, first.cursor);
    h.advance(3600_000);
    const now = NOW + 40 * DAY + 3600_000;
    h.server.conversations = [CHANNEL];
    h.server.messages.push(
      msg(now - 35 * DAY, "Thirty-five days back"),
      msg(now - 20 * DAY, "Twenty days back"),
      msg(now - 3 * DAY, "Three days back"),
    );
    const back = await cycle(h, absent.cursor);
    for (const text of ["Thirty-five days back", "Twenty days back", "Three days back"])
      expect(back.docs.some((d) => d.content.includes(text))).toBe(true);
    expect(back.cursor.channels.CEXAMPLE.through).toBe(new Date(now).toISOString());
  });
  it("resumes a rate-limited listing and day read without repeating completed pages", async () => {
    const h = harness();
    h.server.conversations = [
      CHANNEL,
      { id: "CSECOND", name: "second", is_member: true },
      { id: "CTHIRD", name: "third", is_member: true },
    ];
    h.server.rateLimitWhen = (method, params) =>
      method === "users.conversations" && params.get("cursor") === "2";
    await expect(h.source.syncStructured(null)).rejects.toMatchObject({
      kind: "rate-limit",
      quota: { kind: "account" },
    });
    const start = await h.source.syncStructured(null);
    h.db.commit(start.analytics);
    expect(start.cursor.pending?.queue.map((c) => c.id)).toEqual(["CEXAMPLE", "CSECOND", "CTHIRD"]);
    const count = (method: string, cursor: string | null = null) =>
      h.server.calls.filter((c) => c.method === method && c.params.get("cursor") === cursor).length;
    expect(count("auth.test")).toBe(1);
    expect(count("users.list")).toBe(1);
    expect(count("users.conversations")).toBe(1);
    expect(count("users.conversations", "2")).toBe(2);
    expect(
      h.server.calls.find((c) => c.method === "users.conversations")?.params.get("limit"),
    ).toBe("200");
    const day = midnight(NOW - DAY);
    h.server.messages = [1, 2, 3].map((n) => msg(day + n * 60_000, `Busy message ${n}`));
    h.server.rateLimitWhen = (method, params) =>
      method === "conversations.history" && params.get("cursor") === "2";
    const busy = (cursor: string | null) =>
      h.server.calls.filter(
        (c) =>
          c.method === "conversations.history" &&
          c.params.get("oldest") === slackTs(day) &&
          c.params.get("cursor") === cursor,
      ).length;
    let cursor = start.cursor;
    for (let i = 0; i < 2000; i++) {
      const r = await h.source.syncStructured(cursor).catch((err: Error) => err);
      if (r instanceof Error) {
        expect(r).toMatchObject({ kind: "rate-limit" });
        continue;
      }
      h.db.commit(r.analytics);
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    expect(busy(null)).toBe(3);
    expect(busy("2")).toBe(4);
    expect(count("auth.test")).toBe(1);
    expect(count("users.list")).toBe(1);
    expect(h.acquires()).toBe(1);
    expect(h.db.tables.get("slack_messages")?.filter((r) => r.day === "2026-05-19")).toHaveLength(
      9,
    );
  });
  it("costs a quiet conversation one history read per normal cycle", async () => {
    const h = harness();
    const root = { ...msg(NOW - 3 * DAY), reply_count: 1, latest_reply: slackTs(NOW - 2 * DAY) };
    h.server.messages = [
      msg(NOW - DAY),
      root,
      { ...msg(NOW - 2 * DAY, "Thread reply"), thread_ts: root.ts },
    ];
    const first = await cycle(h);
    h.advance(15 * 60_000);
    const before = h.server.calls.length;
    const quiet = await cycle(h, first.cursor);
    const calls = h.server.calls.slice(before);
    expect(calls.filter((c) => c.method === "conversations.history")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "conversations.replies")).toHaveLength(0);
    expect(quiet.docs).toEqual([]);
    expect(quiet.deleted).toEqual([]);
    h.server.messages.push(msg(NOW + 20 * 60_000, "New after the quiet cycle"));
    h.advance(15 * 60_000);
    const through = Date.parse(quiet.cursor.channels.CEXAMPLE.through!);
    const probe = midnight(NOW + 30 * 60_000 - 14 * DAY);
    const beforeActive = h.server.calls.length;
    const active = await cycle(h, quiet.cursor);
    expect(active.docs.some((d) => d.content.includes("New after the quiet cycle"))).toBe(true);
    expect(
      h.server.calls
        .slice(beforeActive)
        .filter(
          (c) => c.method === "conversations.history" && c.params.get("oldest") === slackTs(probe),
        ),
    ).toHaveLength(1);
    for (const page of active.pages)
      expect(Date.parse(page.cursor.channels.CEXAMPLE.through!)).toBeGreaterThanOrEqual(through);
  });
  it("reads whole days instead of trusting a reconciliation window at the query row limit", async () => {
    const h = harness();
    h.server.messages = [msg(NOW - DAY)];
    const first = await cycle(h);
    const stored = h.db.tables.get("slack_messages") ?? [];
    for (let i = 0; i < 10_000; i++) {
      const ms = midnight(NOW - 10 * DAY) + (i % 10) * DAY + 1000 + i;
      stored.push({
        source_account_id: "TEXAMPLE-USELF00",
        conversation_id: "CEXAMPLE",
        day: new Date(ms).toISOString().slice(0, 10),
        ts: slackTs(ms),
        raw: JSON.stringify(msg(ms)),
      });
    }
    h.db.tables.set("slack_messages", stored);
    h.advance(15 * 60_000);
    const before = h.server.calls.length;
    await cycle(h, first.cursor);
    expect(
      h.server.calls.slice(before).filter((c) => c.method === "conversations.history").length,
    ).toBeGreaterThan(1);
  });
  it("fails a day holding the query row limit transiently instead of reading it truncated", async () => {
    const h = harness();
    const day = midnight(NOW - DAY);
    h.server.messages = [msg(day + 1000)];
    h.db.tables.set(
      "slack_messages",
      Array.from({ length: 10_000 }, (_, i) => ({
        source_account_id: "TEXAMPLE-USELF00",
        conversation_id: "CEXAMPLE",
        day: new Date(day).toISOString().slice(0, 10),
        ts: slackTs(day + 2000 + i),
        raw: JSON.stringify(msg(day + 2000 + i)),
      })),
    );
    const first = await h.source.syncStructured(null);
    h.db.commit(first.analytics);
    const next = {
      ...first.cursor,
      pending: { ...first.cursor.pending!, day: new Date(day).toISOString() },
    };
    await expect(h.source.syncStructured(next)).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("row limit"),
    });
  });
  it("names itself after the workspace once a cycle signs in", async () => {
    const h = harness(true);
    expect(h.source.workspaceName).toBeUndefined();
    await cycle(h);
    expect(h.source.workspaceName).toBe(IDENTITY.team);
  });
  it("keeps a stored day's hash stable when a later cycle reads it back", async () => {
    const h = harness();
    const root = {
      ...msg(NOW - 14 * DAY - 3600_000, "Older thread root"),
      reply_count: 2,
      latest_reply: slackTs(NOW - 14 * DAY - 1200_000),
    };
    h.server.messages = [
      root,
      { ...msg(NOW - 14 * DAY - 2400_000, "First stored reply"), thread_ts: root.ts },
      { ...msg(NOW - 14 * DAY - 1200_000, "Second stored reply"), thread_ts: root.ts },
      msg(NOW - 14 * DAY - 600_000, "Later root"),
    ];
    const first = await cycle(h);
    h.server.messages.push(msg(NOW - 1000, "Fresh message"));
    h.advance(60_000);
    const before = h.server.calls.length;
    const second = await cycle(h, first.cursor);
    expect(
      h.server.calls.slice(before).filter((c) => c.method === "conversations.replies"),
    ).toHaveLength(0);
    expect(second.docs.map((d) => d.externalId)).toEqual(["CEXAMPLE:2026-05-20"]);
  });
  it("skips a conversation failing the same way three times running and deletes nothing", async () => {
    const h = harness();
    h.server.conversations = [{ id: "CBROKEN", name: "broken", is_member: true }, CHANNEL];
    h.server.messages = [msg(NOW - DAY)];
    const first = await cycle(h);
    const brokenRows = () =>
      h.db.tables.get("slack_messages")?.filter((r) => r.conversation_id === "CBROKEN");
    expect(brokenRows()).toHaveLength(1);
    h.server.failing.add("CBROKEN");
    h.advance(DAY + 1000);
    h.server.messages.push(msg(NOW + DAY, "After the failure"));
    const start = await h.source.syncStructured(first.cursor);
    h.db.commit(start.analytics);
    for (let i = 0; i < 2; i++)
      await expect(h.source.syncStructured(start.cursor)).rejects.toMatchObject({
        kind: "transient",
      });
    const skipped = await h.source.syncStructured(start.cursor);
    expect(skipped.issues).toEqual([
      expect.objectContaining({ scope: "partition", kind: "transient", subject: "CBROKEN" }),
    ]);
    expect(skipped.analytics).toBeUndefined();
    expect(skipped.deletedExternalIds).toBeUndefined();
    const rest = await cycle(h, skipped.cursor);
    expect(rest.docs.some((d) => d.content.includes("After the failure"))).toBe(true);
    expect(rest.deleted).toEqual([]);
    expect(brokenRows()).toHaveLength(1);
  });
  it("is a document no-op unchanged, adds, edits and deletes under the same daily ID", async () => {
    const h = harness();
    const m = msg(NOW - DAY);
    h.server.messages = [m];
    const first = await cycle(h);
    expect(first.docs).toHaveLength(1);
    expect((await cycle(h, first.cursor)).docs).toHaveLength(0);
    h.server.messages = [{ ...m, text: "Revised example", edited: { ts: slackTs(NOW) } }];
    const edited = await cycle(h, first.cursor);
    expect(edited.docs[0].externalId).toBe(first.docs[0].externalId);
    expect(edited.docs[0].content).toContain("Revised example");
    h.server.messages = [];
    const deleted = await cycle(h, edited.cursor);
    expect(deleted.deleted).toEqual([first.docs[0].externalId]);
    expect(h.db.tables.get("slack_messages")).toEqual([]);
  });
  it("reconciles edits beyond a bounded document preview into full message rows", async () => {
    const h = harness();
    const m = msg(NOW - DAY, "x".repeat(210_000) + "original tail");
    h.server.messages = [m];
    const first = await cycle(h);
    expect(first.docs[0].content).toContain("preview truncated");
    h.server.messages = [{ ...m, text: "x".repeat(210_000) + "edited tail" }];
    const edited = await cycle(h, first.cursor);
    expect(edited.docs[0].contentHash).toBe(first.docs[0].contentHash);
    expect(h.db.tables.get("slack_messages")?.[0].text).toContain("edited tail");
    expect((await cycle(h, edited.cursor)).docs).toHaveLength(0);
  });
  it("lands late replies to week-old roots on the root day", async () => {
    const h = harness();
    const root = { ...msg(NOW - 10 * DAY), reply_count: 1, latest_reply: slackTs(NOW - 9 * DAY) };
    h.server.messages = [root, { ...msg(NOW - 9 * DAY, "First reply"), thread_ts: root.ts }];
    const first = await cycle(h);
    h.server.messages.push({ ...msg(NOW - 1000, "Late reply"), thread_ts: root.ts });
    h.server.messages[0] = { ...root, latest_reply: slackTs(NOW - 1000), reply_count: 2 };
    const result = await cycle(h, first.cursor);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].externalId).toBe(first.docs[0].externalId);
    expect(result.docs[0].content).toContain("Late reply");
    const urls = new Map(h.db.tables.get("slack_messages")?.map((r) => [r.text, r.source_url]));
    expect(urls.get("Example message")).toBe(
      `https://example-workshop.slack.com/archives/CEXAMPLE/p${root.ts.replace(".", "")}`,
    );
    expect(urls.get("Late reply")).toMatch(
      new RegExp(
        `/archives/CEXAMPLE/p\\d+\\?thread_ts=${root.ts.replace(".", "\\.")}&cid=CEXAMPLE$`,
      ),
    );
  });
  it("does not expire old indexed history; daily 30-day reconciliation catches an older edit", async () => {
    const h = harness();
    const old = msg(NOW - 20 * DAY);
    h.server.messages = [old, msg(NOW - 179 * DAY, "Retained history")];
    const first = await cycle(h);
    h.advance(DAY + 1000);
    h.server.messages[0] = { ...old, text: "Edited older message" };
    const second = await cycle(h, first.cursor);
    expect(second.docs.some((d) => d.content.includes("Edited older message"))).toBe(true);
    expect(second.deleted).toEqual([]);
    expect(h.db.tables.get("slack_messages")?.some((r) => r.text === "Retained history")).toBe(
      true,
    );
  });
  it("does not advance a failed page or delete on a malformed/outage read", async () => {
    const h = harness();
    h.server.messages = [msg(NOW - DAY)];
    const first = await cycle(h);
    const before = JSON.stringify(first.cursor);
    const start = await h.source.syncStructured(first.cursor);
    h.db.commit(start.analytics);
    h.server.malformed = true;
    await expect(cycle(h, start.cursor)).rejects.toMatchObject({ kind: "transient" });
    expect(JSON.stringify(first.cursor)).toBe(before);
    expect(h.db.tables.get("slack_messages")).toHaveLength(1);
  });
  it("syncs a guest account that may not list user groups, with no memberships", async () => {
    const h = harness(true);
    h.server.restrictedUser = true;
    h.server.messages = [msg(NOW - DAY)];
    const r = await cycle(h);
    expect(r.docs).toHaveLength(1);
    expect(h.db.tables.get("slack_session_usergroups") ?? []).toEqual([]);
  });
  it("auth.test failure only fails this account and keeps its existing rows", async () => {
    const h = harness(true);
    h.server.messages = [msg(NOW - DAY)];
    const first = await cycle(h);
    h.server.authError = true;
    await expect(h.source.syncStructured(first.cursor)).rejects.toMatchObject({ kind: "auth" });
    expect(h.db.tables.get("slack_session_messages")).toHaveLength(1);
    h.server.authError = false;
    await cycle(h, first.cursor);
    expect(h.acquires()).toBeGreaterThan(2);
  });
  it("stores only successfully fetched markers and preserves other valid conversations", async () => {
    const h = harness(true);
    h.server.markers = [{ id: "CEXAMPLE", last_read: slackTs(NOW - DAY) }];
    const first = await cycle(h);
    const rows = structuredClone(h.db.tables.get("slack_session_read_positions"));
    expect(rows).toHaveLength(1);
    h.server.markers = [];
    await cycle(h, first.cursor);
    expect(h.db.tables.get("slack_session_read_positions")).toEqual(rows);
  });
  it("preserves whole-day identities after long offline time", async () => {
    const h = harness();
    const morning = msg(Date.parse("2026-05-20T08:00:00Z"), "Morning before pause");
    h.server.messages = [morning];
    const first = await cycle(h);
    h.advance(45 * DAY);
    h.server.messages.push(
      msg(Date.parse("2026-05-20T18:00:00Z"), "Evening after pause"),
      msg(Date.parse("2026-05-21T08:00:00Z"), "Next morning"),
    );
    const resumed = await cycle(h, first.cursor);
    const original = resumed.docs.find((d) => d.externalId === "CEXAMPLE:2026-05-20")!;
    expect(original.content).toContain("Morning before pause");
    expect(original.content).toContain("Evening after pause");
    expect(original.content).not.toContain("Next morning");
    expect(resumed.docs.find((d) => d.externalId === "CEXAMPLE:2026-05-21")?.content).toContain(
      "Next morning",
    );
  });
  it("skips a permanently forbidden conversation without starving a readable sibling", async () => {
    const h = harness();
    h.server.conversations = [
      { id: "CFORBIDDEN", name: "unreadable", is_member: true },
      ...h.server.conversations,
    ];
    h.server.forbidden.add("CFORBIDDEN");
    h.server.messages = [msg(NOW - DAY)];
    const result = await cycle(h);
    expect(result.docs).toHaveLength(1);
    expect(result.pages.some((p) => p.issues?.some((i) => i.subject === "CFORBIDDEN"))).toBe(true);
    expect(result.deleted).toEqual([]);
  });
});
