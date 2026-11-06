// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { SlackSource } from "./source.js";
import { CREDENTIAL, FakeSlack, MemoryAnalytics } from "./fake-slack.js";
import { DAY, slackTs } from "./types.js";
import type { SlackCursor } from "./state.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
const NOW = Date.parse("2026-05-20T12:00:00Z");
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
    acquire: async () => {
      acquires++;
      return CREDENTIAL;
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
  it("bootstraps 180 days, resumes mid-import with a new instance and pins every boundary", async () => {
    const h = harness();
    h.server.messages = [msg(NOW - 181 * DAY), msg(NOW - 179 * DAY), msg(NOW - DAY)];
    const first = await h.source.syncStructured(null);
    h.db.commit(first.analytics);
    const page = await h.source.syncStructured(first.cursor);
    h.db.commit(page.analytics);
    h.source.dispose();
    const replacement = new SlackSource(h.options);
    h.source = replacement;
    const result = await cycle(h, page.cursor);
    expect(result.docs).toHaveLength(2);
    for (const call of h.server.calls.filter((c) => c.method === "conversations.history"))
      for (const key of ["oldest", "latest"]) expect(call.params.get(key)).toMatch(/^\d+\.\d{6}$/);
    expect(
      Math.min(
        ...h.server.calls
          .filter((c) => c.method === "conversations.history")
          .map((c) => Number(c.params.get("oldest")) * 1000),
      ),
    ).toBe(NOW - 180 * DAY);
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
