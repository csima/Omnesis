// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { encodeSourceState, resolveSourceState } from "@omnesis/source-sdk";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { QuoClient } from "./client.js";
import { FAKE_API_KEY, FAKE_ORG_ID, FakeQuo, JAMIE, MAIN_LINE, MAYA } from "./fake-quo.js";
import { QuoMessagesSource } from "./source.js";
import { quoMessagesStateSpec } from "./state.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { QuoCursor } from "./state.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function setup(
  opts: { target?: number; pageLimit?: number; historyDays?: number; dataCutoff?: string } = {},
) {
  const fake = new FakeQuo();
  const sleeps: number[] = [];
  const client = new QuoClient(FAKE_API_KEY, {
    fetchImpl: fake.fetch,
    minSpacingMs: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const make = () =>
    new QuoMessagesSource({
      client,
      providerId: ProviderId(`quo:${FAKE_ORG_ID}`),
      sourceId: SourceId(`quo-messages:${FAKE_ORG_ID}`),
      organizationId: FAKE_ORG_ID,
      host: fakeSourceHost({ now: NOW }),
      historyDays: opts.historyDays ?? 180,
      dataCutoff: opts.dataCutoff,
      targetDocumentsPerCall: opts.target ?? 200,
      pageLimit: opts.pageLimit ?? 50,
    });
  return { fake, sleeps, source: make(), make };
}

/**
 * Run sync until `hasMore` is false, as the engine does, passing every cursor
 * through the state envelope the host stores it in.
 */
async function drain(source: QuoMessagesSource, cursor: QuoCursor | null) {
  const pages: SyncResult<QuoCursor>[] = [];
  let current = cursor;
  for (let i = 0; i < 100; i++) {
    const page = await source.sync(current);
    pages.push(page);
    current = roundTrip(page.cursor);
    if (!page.hasMore) {
      const documents = pages.flatMap((p) => p.documents);
      return { documents, ids: documents.map((d) => d.externalId), cursor: current, pages };
    }
  }
  throw new Error("sync never finished");
}

function roundTrip(cursor: QuoCursor): QuoCursor {
  const stored = JSON.parse(JSON.stringify(encodeSourceState(quoMessagesStateSpec, cursor)));
  const outcome = resolveSourceState(quoMessagesStateSpec, stored, { sourceId: "quo-messages" });
  expect(outcome.kind).toBe("resume");
  return (outcome as { state: QuoCursor }).state;
}

function at(iso: string) {
  return { createdAt: iso, updatedAt: iso };
}

describe("bootstrap", () => {
  test("backfills every message in the history window, both directions and every number", async () => {
    const { fake, source } = setup();
    fake.add({ direction: "incoming", text: "Is the studio open Saturday?" });
    fake.add({ direction: "outgoing", text: "Yes, from ten." });
    fake.add({
      direction: "incoming",
      from: JAMIE,
      to: ["+15550100200"],
      phoneNumberId: "PNsupport02",
      conversationId: "CNjamie0001",
    });

    const { ids, documents, cursor } = await drain(source, null);

    expect(ids.sort()).toEqual(["ACmsg0001", "ACmsg0002", "ACmsg0003"]);
    expect(documents.map((d) => d.metadata.extra?.direction).sort()).toEqual([
      "incoming",
      "incoming",
      "outgoing",
    ]);
    expect(cursor.walk).toBeUndefined();
    expect(cursor.watermark).toEqual({ at: "2026-10-01T09:00:03.000Z", ids: ["ACmsg0003"] });
  });

  test("walks a long history over several calls without losing or repeating a message", async () => {
    const { fake, source } = setup({ target: 7, pageLimit: 3 });
    for (let i = 0; i < 40; i++) fake.add({ direction: i % 3 ? "incoming" : "outgoing" });

    const { ids, pages } = await drain(source, null);

    expect(pages.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(40);
    expect(ids).toHaveLength(40);
    // The page cursor Quo hands out is followed only within one call.
    for (const page of pages) expect(JSON.stringify(page.cursor)).not.toContain("nextCursor");
  });

  test("reads no further back than the history window or the data cutoff, whichever is later", async () => {
    const { fake, source } = setup({ historyDays: 30 });
    fake.add({ direction: "incoming", ...at("2026-08-01T00:00:00.000Z") });
    fake.add({ direction: "incoming", ...at("2026-09-20T00:00:00.000Z") });
    fake.add({ direction: "incoming", ...at("2026-10-10T00:00:00.000Z") });
    expect((await drain(source, null)).ids.sort()).toEqual(["ACmsg0002", "ACmsg0003"]);

    const cut = setup({ historyDays: 365, dataCutoff: "2026-10-01T00:00:00.000Z" });
    cut.fake.add({ direction: "incoming", ...at("2026-09-20T00:00:00.000Z") });
    cut.fake.add({ direction: "incoming", ...at("2026-10-10T00:00:00.000Z") });
    expect((await drain(cut.source, null)).ids).toEqual(["ACmsg0002"]);
  });

  test("an empty workspace settles on the history floor and later finds its first message", async () => {
    const { fake, source } = setup();
    const first = await drain(source, null);
    expect(first.documents).toEqual([]);
    expect(first.cursor.watermark?.ids).toEqual([]);

    fake.add({ direction: "incoming" });
    expect((await drain(source, first.cursor)).ids).toEqual(["ACmsg0001"]);
  });
});

describe("incremental", () => {
  test("a second sync with the first cursor yields nothing; a new message yields only itself", async () => {
    const { fake, source } = setup();
    fake.add({ direction: "incoming" });
    fake.add({ direction: "outgoing" });
    const first = await drain(source, null);

    const again = await drain(source, first.cursor);
    expect(again.documents).toEqual([]);
    expect(again.cursor).toEqual(first.cursor);

    fake.add({ direction: "outgoing", text: "See you then." });
    const third = await drain(source, again.cursor);
    expect(third.ids).toEqual(["ACmsg0003"]);
    expect(third.documents[0]!.metadata.extra?.direction).toBe("outgoing");
  });

  test("asks Quo only for messages from the watermark's millisecond on", async () => {
    const { fake, source } = setup();
    fake.add({ direction: "incoming", ...at("2026-10-02T08:00:00.000Z") });
    const first = await drain(source, null);
    fake.requests.length = 0;
    await drain(source, first.cursor);
    expect(fake.requests.filter((r) => r.startsWith("/messages"))).toEqual([
      "/messages?limit=50&createdAt[gt]=2026-10-02T07:59:59.999Z",
    ]);
  });

  test("a gap larger than one call resumes below where the call stopped, then advances", async () => {
    const { fake, source } = setup({ target: 5, pageLimit: 2 });
    fake.add({ direction: "incoming" });
    const first = await drain(source, null);
    for (let i = 0; i < 23; i++) fake.add({ direction: i % 2 ? "outgoing" : "incoming" });

    const catchUp = await drain(source, first.cursor);
    expect(catchUp.pages.length).toBeGreaterThan(1);
    expect(new Set(catchUp.ids).size).toBe(23);
    expect(catchUp.ids).not.toContain("ACmsg0001");
    expect(catchUp.cursor.watermark?.ids).toEqual(["ACmsg0024"]);
  });

  test("a message arriving while a walk is in progress is read by the next walk", async () => {
    const { fake, source } = setup({ target: 2, pageLimit: 2 });
    for (let i = 0; i < 5; i++) fake.add({ direction: "incoming" });
    const partial = await source.sync(null);
    expect(partial.hasMore).toBe(true);
    fake.add({ direction: "outgoing", text: "Late reply" });

    const rest = await drain(source, roundTrip(partial.cursor));
    const next = await drain(source, rest.cursor);
    const all = [...partial.documents, ...rest.documents, ...next.documents].map(
      (d) => d.externalId,
    );
    expect(all.sort()).toEqual([
      "ACmsg0001",
      "ACmsg0002",
      "ACmsg0003",
      "ACmsg0004",
      "ACmsg0005",
      "ACmsg0006",
    ]);
  });
});

describe("messages sharing one instant", () => {
  const SAME = "2026-10-03T10:00:00.000Z";

  test("ties split across a call boundary are neither lost nor duplicated", async () => {
    const { fake, source } = setup({ target: 2, pageLimit: 2 });
    fake.add({ direction: "incoming", ...at("2026-10-03T10:00:05.000Z") });
    for (let i = 0; i < 5; i++)
      fake.add({ direction: i % 2 ? "outgoing" : "incoming", ...at(SAME) });
    fake.add({ direction: "incoming", ...at("2026-10-03T09:59:55.000Z") });

    const { ids, pages } = await drain(source, null);

    expect(pages.length).toBeGreaterThan(2);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  test("a message created later in the watermark's millisecond is picked up exactly once", async () => {
    const { fake, source } = setup();
    fake.add({ direction: "incoming", ...at(SAME) });
    fake.add({ direction: "outgoing", ...at(SAME) });
    const first = await drain(source, null);
    expect(first.cursor.watermark).toEqual({
      at: SAME,
      ids: expect.arrayContaining(["ACmsg0001", "ACmsg0002"]),
    });

    fake.add({ direction: "incoming", ...at(SAME) });
    const second = await drain(source, first.cursor);
    expect(second.ids).toEqual(["ACmsg0003"]);
    expect(second.cursor.watermark?.ids.sort()).toEqual(["ACmsg0001", "ACmsg0002", "ACmsg0003"]);

    const third = await drain(source, second.cursor);
    expect(third.documents).toEqual([]);
  });

  test("timestamps are compared by instant, whatever precision Quo writes them in", async () => {
    const { fake, source } = setup();
    fake.add({
      direction: "incoming",
      createdAt: "2026-10-03T10:00:00Z",
      updatedAt: "2026-10-03T10:00:00Z",
    });
    const first = await drain(source, null);
    fake.add({ direction: "incoming", ...at("2026-10-03T10:00:00.000Z") });
    expect((await drain(source, first.cursor)).ids).toEqual(["ACmsg0002"]);
  });
});

describe("errors", () => {
  async function seeded() {
    const ctx = setup();
    ctx.fake.add({ direction: "incoming" });
    const first = await drain(ctx.source, null);
    ctx.fake.add({ direction: "outgoing" });
    return { ...ctx, cursor: first.cursor };
  }

  async function failure(promise: Promise<unknown>): Promise<SyncError> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncError);
    return err as SyncError;
  }

  test("a rejected key needs a new one, for the whole connection, and the cursor still resumes", async () => {
    const { fake, source, cursor } = await seeded();
    fake.failNext.push({ match: "/messages", status: 401 });
    const err = await failure(source.sync(cursor));
    expect(err.kind).toBe("auth");
    expect(err.scope).toBe("connection");
    expect(err.remediation?.steps.join(" ")).toContain("Workspace Settings");

    expect((await drain(source, cursor)).ids).toEqual(["ACmsg0002"]);
  });

  test("a refused workspace is a permission failure with a remedy, not a re-auth", async () => {
    const { fake, source, cursor } = await seeded();
    fake.failNext.push({ match: "/messages", status: 403 });
    const err = await failure(source.sync(cursor));
    expect(err.kind).toBe("permission");
    expect(err.remediation).toBeDefined();
  });

  test("a rate limit honours Retry-After inline when short, and hands a long one to the scheduler", async () => {
    const { fake, source, cursor, sleeps } = await seeded();
    fake.failNext.push({ match: "/messages", status: 429, headers: { "retry-after": "2" } });
    expect((await drain(source, cursor)).ids).toEqual(["ACmsg0002"]);
    expect(sleeps).toContain(2000);

    fake.failNext.push({ match: "/messages", status: 429, headers: { "retry-after": "120" } });
    const err = await failure(source.sync(cursor));
    expect(err.kind).toBe("rate-limit");
    expect(err.retryAfterMs).toBe(120_000);
    expect(err.quota).toEqual({ kind: "account" });
  });

  test("a server error is retried with backoff, and an outage that outlasts the retries is transient", async () => {
    const { fake, source, cursor, sleeps } = await seeded();
    fake.failNext.push({ match: "/messages", status: 503 });
    expect((await drain(source, cursor)).ids).toEqual(["ACmsg0002"]);
    expect(sleeps).toContain(1000);

    fake.outage = 500;
    const err = await failure(source.sync(cursor));
    expect(err.kind).toBe("transient");
    fake.outage = undefined;
    expect((await drain(source, cursor)).ids).toEqual(["ACmsg0002"]);
  });

  test("a malformed message is skipped while its neighbours land and the cursor moves on", async () => {
    const { fake, source, cursor } = await seeded();
    fake.addRaw({ id: "ACbroken01", direction: "sideways", createdAt: "2026-10-01T09:00:03.000Z" });
    fake.add({ direction: "incoming", ...at("2026-10-01T09:00:04.000Z") });

    const result = await drain(source, cursor);
    expect(result.ids.sort()).toEqual(["ACmsg0002", "ACmsg0003"]);
    expect(result.cursor.watermark?.ids).toEqual(["ACmsg0003"]);
  });

  test("a malformed list fails the page without touching the cursor", async () => {
    const { fake, source, cursor } = await seeded();
    fake.failNext.push({ match: "/messages", status: 200, body: JSON.stringify({ items: [] }) });
    const err = await failure(source.sync(cursor));
    expect(err.kind).toBe("unknown");
    expect((await drain(source, cursor)).ids).toEqual(["ACmsg0002"]);
  });

  test("a sync that can only read unreadable records says so instead of spinning", async () => {
    const { fake, source } = setup({ pageLimit: 1, target: 50 });
    for (let i = 0; i < 20; i++) {
      fake.failNext.push({
        match: "/messages",
        status: 200,
        body: JSON.stringify({ data: [{ id: `broken-${i}` }], nextCursor: `page-${i}` }),
      });
    }
    const err = await failure(source.sync(null));
    expect(err.message).toContain("20 unreadable");
  });

  test("a cursor Quo repeats stops the sync instead of looping", async () => {
    const { fake, source } = setup({ pageLimit: 1, target: 50 });
    fake.add({ direction: "incoming" });
    fake.add({ direction: "incoming" });
    const loop = JSON.stringify({ data: [], nextCursor: "same" });
    fake.failNext.push(
      { match: "/messages", status: 200, body: loop },
      { match: "/messages", status: 200, body: loop },
    );
    const err = await failure(source.sync(null));
    expect(err.message).toContain("same message page twice");
  });
});

describe("normalized output on the sync path", () => {
  test("each message carries its number, thread, direction and people", async () => {
    const { fake, source } = setup();
    fake.add({ direction: "incoming", text: "Can we move to 3pm?" });
    fake.add({ direction: "outgoing", text: "Sure." });
    const docs: DocumentInput[] = (await drain(source, null)).documents;
    const byId = new Map(docs.map((d) => [d.externalId, d]));
    const incoming = byId.get("ACmsg0001")!;
    const outgoing = byId.get("ACmsg0002")!;

    expect(incoming.metadata.extra).toMatchObject({
      direction: "incoming",
      threadId: "CNmaya0001",
      quoNumber: MAIN_LINE.phoneNumber,
      quoNumberName: "Main line",
    });
    expect(outgoing.metadata.extra?.threadId).toBe(incoming.metadata.extra?.threadId);
    expect(outgoing.metadata.people).toEqual([
      {
        role: "sender",
        identifiers: [
          { kind: "lid", value: `quo:${FAKE_ORG_ID}` },
          { kind: "phone", value: MAIN_LINE.phoneNumber },
        ],
      },
      { role: "recipient", identifiers: [{ kind: "phone", value: MAYA }] },
    ]);
  });
});
