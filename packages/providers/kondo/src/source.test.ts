// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, expect, test } from "vitest";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { KondoClient, TAB_REMEDIATION } from "./client.js";
import { MemoryTokens } from "./credentials.js";
import { DAVID, FakeKondo, ISSUER, JAMIE, MAYA, OWNER, OWNER_URN, msg } from "./fake-kondo.js";
import { KondoSource } from "./source.js";
import type { DocumentInput } from "@omnesis/types";
import type { KondoCursor } from "./state.js";
import type { KondoSourceOptions } from "./source.js";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");

function source(fake: FakeKondo, overrides: Partial<KondoSourceOptions> = {}): KondoSource {
  const grant = fake.issueGrant();
  const tokens = new MemoryTokens(
    { accessToken: grant.accessToken, refreshToken: grant.refreshToken },
    `${ISSUER}/oauth/token`,
    grant.clientId,
    { fetchImpl: fake.fetch },
  );
  return new KondoSource({
    client: new KondoClient(tokens, { fetchImpl: fake.fetch, callGapMs: 0 }),
    providerId: ProviderId(`kondo:${OWNER_URN}`),
    sourceId: SourceId(`kondo:${OWNER_URN}`),
    ownerUrn: OWNER_URN,
    historyDays: 30,
    now: () => NOW,
    tuning: { listPageSize: 2, readBatchSize: 2, chatsPerCall: 3 },
    ...overrides,
  });
}

/** Drive one whole cycle, as the engine does while the source says `hasMore`. */
async function cycle(
  src: KondoSource,
  cursor: KondoCursor | null,
): Promise<{ docs: DocumentInput[]; cursor: KondoCursor; calls: number }> {
  const docs: DocumentInput[] = [];
  let next = cursor;
  for (let calls = 1; calls <= 200; calls++) {
    const page = await src.sync(next);
    docs.push(...page.documents);
    expect(page.deletedExternalIds).toEqual([]);
    expect(page.presentExternalIds).toBeUndefined();
    next = page.cursor;
    if (!page.hasMore) return { docs, cursor: next, calls };
  }
  throw new Error("cycle did not finish");
}

function populated(): FakeKondo {
  const fake = new FakeKondo();
  fake.addChat({
    threadKey: "t-maya",
    participants: [OWNER, MAYA],
    labelKeys: ["lbl-hiring"],
    messages: [
      msg(MAYA, "2026-03-08T09:00:00.000Z", "Hi Sarah, quick question about the role"),
      msg("self", "2026-03-08T09:30:00.000Z", "Happy to help"),
      msg(MAYA, "2026-03-09T10:00:00.000Z", "Thanks!"),
    ],
  });
  fake.addChat({
    threadKey: "t-jamie",
    participants: [OWNER, JAMIE],
    messages: [msg(JAMIE, "2026-03-07T15:00:00.000Z", "Marathon entry form is attached")],
  });
  fake.addChat({
    threadKey: "t-group",
    participants: [OWNER, JAMIE, DAVID],
    messages: [msg(DAVID, "2026-03-06T08:00:00.000Z", "Kickoff notes for Studio Northstar")],
  });
  fake.addChat({
    threadKey: "t-archived",
    participants: [OWNER, DAVID],
    archived: true,
    messages: [msg(DAVID, "2026-03-05T12:00:00.000Z", "Archived but not forgotten")],
  });
  fake.addChat({
    threadKey: "t-ancient",
    participants: [OWNER, MAYA],
    messages: [msg(MAYA, "2025-06-01T12:00:00.000Z", "Outside the history window")],
  });
  return fake;
}

describe("KondoSource — bootstrap", () => {
  test("indexes every chat-day in the window across the inbox and the archive", async () => {
    const fake = populated();
    const { docs, cursor } = await cycle(source(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "t-archived:2026-03-05",
      "t-group:2026-03-06",
      "t-jamie:2026-03-07",
      "t-maya:2026-03-08",
      "t-maya:2026-03-09",
    ]);
    const archived = docs.find((d) => d.externalId.startsWith("t-archived"))!;
    expect(archived.metadata.extra?.archived).toBe(true);
    const maya = docs.find((d) => d.externalId === "t-maya:2026-03-08")!;
    expect(maya.metadata.tags).toEqual(["Hiring"]);
    expect(cursor.pass).toBeUndefined();
    expect(cursor.watermark).toBe(Date.parse("2026-03-09T10:00:00.000Z"));
    expect(fake.forbidden).toEqual([]);
    expect(new Set(fake.calls.map((c) => c.name))).toEqual(
      new Set(["read_status", "list_inbox", "list_inboxes", "read_chat"]),
    );
  });

  test("pages back through an inbox larger than one page using the paging hint", async () => {
    const fake = new FakeKondo();
    for (let i = 0; i < 7; i++) {
      fake.addChat({
        threadKey: `t-${i}`,
        participants: [OWNER, MAYA],
        messages: [msg(MAYA, `2026-03-0${i + 1}T10:00:00.000Z`, `message ${i}`)],
      });
    }
    const { docs } = await cycle(source(fake), null);
    expect(docs).toHaveLength(7);
    const lists = fake.toolCalls("list_inbox").filter((c) => c.args.inbox === "all");
    expect(lists.length).toBeGreaterThanOrEqual(4);
    expect(lists.every((c) => c.args.limit === 2)).toBe(true);
  });

  test("chats sharing one activity instant across a page boundary are all read once", async () => {
    const fake = new FakeKondo();
    for (const key of ["a", "b", "c"]) {
      fake.addChat({
        threadKey: `t-${key}`,
        participants: [OWNER, MAYA],
        messages: [msg(MAYA, "2026-03-08T10:00:00.000Z", `same instant ${key}`)],
      });
    }
    const { docs } = await cycle(source(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "t-a:2026-03-08",
      "t-b:2026-03-08",
      "t-c:2026-03-08",
    ]);
  });

  test("ignores chats that belong to another LinkedIn member on the same Kondo account", async () => {
    const fake = populated();
    fake.addChat({
      threadKey: "t-other-owner",
      profileUrn: "100000099",
      participants: [MAYA],
      messages: [msg(MAYA, "2026-03-09T11:00:00.000Z", "for someone else")],
    });
    const { docs } = await cycle(source(fake), null);
    expect(docs.some((d) => d.externalId.startsWith("t-other-owner"))).toBe(false);
  });

  test("the data cutoff bounds both the listing floor and the emitted days", async () => {
    const fake = populated();
    const { docs } = await cycle(source(fake, { dataCutoff: "2026-03-08T00:00:00.000Z" }), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "t-maya:2026-03-08",
      "t-maya:2026-03-09",
    ]);
  });
});

describe("KondoSource — incremental", () => {
  test("an unchanged inbox yields nothing and reads no chat", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await cycle(src, null);
    const readsBefore = fake.toolCalls("read_chat").length;
    const second = await cycle(src, first.cursor);
    expect(second.docs).toEqual([]);
    expect(fake.toolCalls("read_chat").length).toBe(readsBefore);
    expect(second.cursor.watermark).toBe(first.cursor.watermark);
  });

  test("a new message re-emits only its chat's days from the watermark's day on", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await cycle(src, null);
    fake.post("t-jamie", msg(JAMIE, "2026-03-10T09:00:00.000Z", "Any update?"));
    const second = await cycle(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["t-jamie:2026-03-10"]);
    expect(second.cursor.watermark).toBe(Date.parse("2026-03-10T09:00:00.000Z"));
    const listed = fake.toolCalls("list_inbox").at(-1)!;
    expect(listed.args.after).toBe(first.cursor.watermark);
  });

  test("a message on the watermark's own day re-renders that whole day", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await cycle(src, null);
    fake.post("t-maya", msg("self", "2026-03-09T18:00:00.000Z", "You're welcome"));
    const second = await cycle(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["t-maya:2026-03-09"]);
    expect(second.docs[0].content).toContain("Thanks!");
    expect(second.docs[0].content).toContain("You're welcome");
  });

  test("a chat archived with new activity is found in the archive inbox", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await cycle(src, null);
    fake.post("t-group", msg(JAMIE, "2026-03-10T07:00:00.000Z", "Wrapping this up"));
    fake.archive("t-group");
    const second = await cycle(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["t-group:2026-03-10"]);
    expect(second.docs[0].metadata.extra?.archived).toBe(true);
  });

  test("an upstream that never changes settles and stops emitting", async () => {
    const fake = populated();
    const src = source(fake);
    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      async step(cursor) {
        const result = await cycle(src, cursor as KondoCursor | null);
        return {
          records: result.docs.map((doc) => ({
            table: "documents",
            row: { externalId: doc.externalId, contentHash: doc.contentHash },
          })),
          cursor: result.cursor,
          hasMore: false,
        };
      },
      primaryKey: () => ["externalId"],
      settleSteps: 3,
    });
  });
});

describe("KondoSource — errors", () => {
  test("a closed Kondo tab fails the cycle start with the tab remedy and keeps the cursor", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await cycle(src, null);
    fake.tabConnected = false;
    const err = await src.sync(first.cursor).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("transient");
    expect((err as SyncError).remediation).toBe(TAB_REMEDIATION);
    expect((err as SyncError).kind).not.toBe("auth");
  });

  test("a tab closed mid-cycle stops the page; reopening it resumes from the last cursor", async () => {
    const fake = populated();
    const src = source(fake);
    let cursor: KondoCursor | null = null;
    const docs: DocumentInput[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await src.sync(cursor);
      docs.push(...page.documents);
      cursor = page.cursor;
    }
    expect(cursor?.pass).toBeDefined();
    fake.tabConnected = false;
    await expect(src.sync(cursor)).rejects.toMatchObject({ remediation: TAB_REMEDIATION });
    fake.tabConnected = true;
    const rest = await cycle(src, cursor);
    const all = [...docs, ...rest.docs].map((d) => d.externalId);
    expect(new Set(all).size).toBe(5);
    expect(rest.cursor.watermark).toBe(Date.parse("2026-03-09T10:00:00.000Z"));
  });

  test("an expired access token is renewed and the sync carries on", async () => {
    const fake = populated();
    const src = source(fake);
    const first = await src.sync(null);
    fake.expireAccessTokens();
    const rest = await cycle(src, first.cursor);
    expect(rest.docs).toHaveLength(5);
  });

  test("a revoked grant surfaces as an auth failure", async () => {
    const fake = populated();
    const src = source(fake);
    fake.expireAccessTokens();
    fake.refreshRefused = true;
    await expect(src.sync(null)).rejects.toMatchObject({ kind: "auth" });
  });

  test("rate limits and outages are typed and leave the prior cursor to the engine", async () => {
    const fake = populated();
    const src = source(fake);
    fake.failNext.push(429);
    await expect(src.sync(null)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 30_000,
    });
    fake.failNext.push(502);
    await expect(src.sync(null)).rejects.toMatchObject({ kind: "transient" });
    expect((await cycle(src, null)).docs).toHaveLength(5);
  });

  test("a chat Kondo cannot return is skipped without failing the page", async () => {
    const fake = populated();
    const src = source(fake);
    const original = fake.fetch;
    const dropping: typeof fetch = async (input, init) => {
      const res = await original(input, init);
      const body = init?.body ? String(init.body) : "";
      if (!body.includes('"read_chat"')) return res;
      const message = (await res.json()) as {
        result: { content: Array<{ type: string; text: string }> };
      };
      const payload = JSON.parse(message.result.content[0].text) as {
        data: Array<{ threadKey: string }>;
      };
      payload.data = payload.data.map((c) =>
        c.threadKey === "t-jamie" ? ({ broken: true } as never) : c,
      );
      message.result.content[0].text = JSON.stringify(payload);
      return new Response(JSON.stringify(message), {
        headers: { "content-type": "application/json" },
      });
    };
    const grant = fake.issueGrant();
    const tolerant = new KondoSource({
      client: new KondoClient(
        new MemoryTokens(
          { accessToken: grant.accessToken },
          `${ISSUER}/oauth/token`,
          grant.clientId,
        ),
        { fetchImpl: dropping, callGapMs: 0 },
      ),
      providerId: ProviderId(`kondo:${OWNER_URN}`),
      sourceId: SourceId(`kondo:${OWNER_URN}`),
      ownerUrn: OWNER_URN,
      historyDays: 30,
      now: () => NOW,
    });
    const { docs } = await cycle(tolerant, null);
    expect(docs.map((d) => d.externalId)).not.toContain("t-jamie:2026-03-07");
    expect(docs).toHaveLength(4);
    expect(src).toBeDefined();
  });
});
