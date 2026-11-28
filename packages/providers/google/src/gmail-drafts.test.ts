// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
import { gmailDocumentEventProfile } from "./document-event-profiles.js";
import type { GmailSyncCursor } from "./gmail.js";

function apiError(code: number): Error {
  return Object.assign(new Error(`HTTP ${code}`), { code });
}

function draftMessage(
  messageId: string,
  overrides: {
    subject?: string;
    body?: string;
    headers?: Array<{ name: string; value: string }>;
  } = {},
) {
  return {
    id: messageId,
    threadId: `thread-${messageId}`,
    internalDate: "1704067200000",
    labelIds: ["DRAFT"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: overrides.subject ?? "Lunch plans" },
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "Bob <bob@example.com>" },
        { name: "Cc", value: "carol@example.com" },
        ...(overrides.headers ?? []),
      ],
      body: {
        data: Buffer.from(overrides.body ?? "Are you free on Friday?").toString("base64url"),
      },
    },
  };
}

/** A mailbox whose drafts are `drafts`, draftId → message. */
function serveDrafts(gmail: any, drafts: Record<string, ReturnType<typeof draftMessage>>) {
  gmail.users.drafts.list = vi.fn(() =>
    Promise.resolve({
      data: { drafts: Object.entries(drafts).map(([id, m]) => ({ id, message: { id: m.id } })) },
    }),
  );
  gmail.users.drafts.get = vi.fn((params: { id: string }) =>
    drafts[params.id]
      ? Promise.resolve({ data: { id: params.id, message: drafts[params.id] } })
      : Promise.reject(apiError(404)),
  );
}

describe("Gmail drafts", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
  });

  test("first sync indexes each active draft under its own document id", async () => {
    serveDrafts(gmail, {
      "r-1": draftMessage("m-1", {
        headers: [
          { name: "Message-ID", value: "<d1@mail.example.com>" },
          { name: "In-Reply-To", value: "<prev@mail.example.com>" },
          { name: "References", value: "<root@mail.example.com> <prev@mail.example.com>" },
        ],
      }),
    });
    const result = await createGmailSource(gmail).sync(null);

    const draft = result.documents.find((d) => d.externalId === "gmail-draft:r-1")!;
    expect(draft).toBeDefined();
    expect(draft.title).toBe("Lunch plans");
    expect(draft.content).toContain("Are you free on Friday?");
    expect(draft.content).toContain("**To:** Bob <bob@example.com>");
    expect(draft.metadata.documentType).toBe("email");
    expect(draft.metadata.tags).toEqual(["DRAFT"]);
    expect(draft.metadata.extra).toEqual({
      isDraft: true,
      draftId: "r-1",
      threadId: "thread-m-1",
      direction: "sent",
      unread: false,
      archived: false,
      starred: false,
      messageId: "<d1@mail.example.com>",
      inReplyTo: "<prev@mail.example.com>",
      references: ["<root@mail.example.com>", "<prev@mail.example.com>"],
    });
    expect(draft.metadata.people?.map((p) => p.role).sort()).toEqual([
      "recipient",
      "recipient",
      "sender",
    ]);
    expect(draft.sourceUpdatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect((result.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-1" });
  });

  test("every extra field a draft carries is declared in the profile", async () => {
    serveDrafts(gmail, {
      "r-1": draftMessage("m-1", {
        headers: [
          { name: "Message-ID", value: "<d1@mail.example.com>" },
          { name: "In-Reply-To", value: "<prev@mail.example.com>" },
          { name: "References", value: "<root@mail.example.com>" },
        ],
      }),
    });
    const result = await createGmailSource(gmail).sync(null);
    const draft = result.documents.find((d) => d.externalId === "gmail-draft:r-1")!;
    const declared = new Set(
      gmailDocumentEventProfile.metadataFields?.map((f) => f.path.replace(/^extra\./, "")),
    );
    for (const key of Object.keys(draft.metadata.extra as object)) expect(declared).toContain(key);
    const types = Object.fromEntries(
      (gmailDocumentEventProfile.metadataFields ?? []).map((f) => [f.path, f.type]),
    );
    expect(types["extra.isDraft"]).toBe("boolean");
    expect(types["extra.draftId"]).toBe("string");
  });

  test("an unchanged draft is not read again; an edited one replaces its document", async () => {
    const source = createGmailSource(gmail);
    serveDrafts(gmail, { "r-1": draftMessage("m-1") });
    const first = await source.sync(null);

    serveDrafts(gmail, { "r-1": draftMessage("m-1") });
    const second = await source.sync(first.cursor);
    expect(second.documents.filter((d) => d.externalId.startsWith("gmail-draft:"))).toEqual([]);
    expect(gmail.users.drafts.get).not.toHaveBeenCalled();

    // Gmail gives an edited draft a new message; the draft id stays.
    serveDrafts(gmail, { "r-1": draftMessage("m-2", { body: "Friday at noon works." }) });
    const third = await source.sync(second.cursor);
    const edited = third.documents.filter((d) => d.externalId.startsWith("gmail-draft:"));
    expect(edited).toHaveLength(1);
    expect(edited[0]!.externalId).toBe("gmail-draft:r-1");
    expect(edited[0]!.content).toContain("Friday at noon works.");
    expect(edited[0]!.contentHash).not.toBe(first.documents[0]!.contentHash);
    expect(third.deletedExternalIds).toEqual([]);
    expect((third.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-2" });
  });

  test("a draft that was sent or discarded is deleted, and only that one", async () => {
    const source = createGmailSource(gmail);
    serveDrafts(gmail, { "r-1": draftMessage("m-1"), "r-2": draftMessage("m-2") });
    const first = await source.sync(null);

    serveDrafts(gmail, { "r-2": draftMessage("m-2") });
    const second = await source.sync(first.cursor);
    expect(second.deletedExternalIds).toEqual(["gmail-draft:r-1"]);
    expect((second.cursor as GmailSyncCursor).drafts).toEqual({ "r-2": "m-2" });

    serveDrafts(gmail, {});
    const third = await source.sync(second.cursor);
    expect(third.deletedExternalIds).toEqual(["gmail-draft:r-2"]);
    expect((third.cursor as GmailSyncCursor).drafts).toBeUndefined();

    const fourth = await source.sync(third.cursor);
    expect(fourth.deletedExternalIds).toEqual([]);
  });

  test("a draft discarded between listing and reading leaves no document", async () => {
    gmail.users.drafts.list = vi.fn(() =>
      Promise.resolve({ data: { drafts: [{ id: "r-1", message: { id: "m-1" } }] } }),
    );
    gmail.users.drafts.get = vi.fn(() => Promise.reject(apiError(404)));
    const result = await createGmailSource(gmail).sync(null);
    expect(result.documents).toEqual([]);
    expect((result.cursor as GmailSyncCursor).drafts).toBeUndefined();
  });

  test("a sent draft's message keeps its own id and never collides with the draft document", async () => {
    const source = createGmailSource(gmail);
    serveDrafts(gmail, { "r-1": draftMessage("m-1") });
    const first = await source.sync(null);
    const draftDoc = first.documents.find((d) => d.externalId === "gmail-draft:r-1")!;

    // Sent: the draft disappears and its message arrives as sent mail under its message id.
    serveDrafts(gmail, {});
    const cursor = { ...(first.cursor as GmailSyncCursor), phase: "incremental", historyId: "h-1" };
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({
        data: { history: [{ labelsRemoved: [{ message: { id: "m-1" }, labelIds: ["DRAFT"] }] }] },
      }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: makeGmailMessage("m-1", { labelIds: ["SENT"], from: "alice@example.com" }),
      }),
    );
    const sent = await source.sync(cursor);
    expect(sent.deletedExternalIds).toEqual(["gmail-draft:r-1"]);
    const mail = sent.documents.find((d) => d.externalId === "m-1")!;
    expect(mail.externalId).not.toBe(draftDoc.externalId);
    const extra = mail.metadata.extra as Record<string, unknown>;
    expect(extra.isDraft).toBeUndefined();
    expect(extra.draftId).toBeUndefined();
  });

  test("regular messages are unaffected and carry no draft fields", async () => {
    gmail.users.messages.list = vi.fn(() => Promise.resolve({ data: { messages: [{ id: "a" }] } }));
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: makeGmailMessage("a") }));
    serveDrafts(gmail, { "r-1": draftMessage("m-1") });
    const result = await createGmailSource(gmail).sync(null);

    const ids = result.documents.map((d) => d.externalId).sort();
    expect(ids).toEqual(["a", "gmail-draft:r-1"]);
    const extra = result.documents.find((d) => d.externalId === "a")!.metadata.extra as Record<
      string,
      unknown
    >;
    expect("isDraft" in extra).toBe(false);
    expect("draftId" in extra).toBe(false);
  });

  test("drafts are read on the first bootstrap page and carried through the rest, then refreshed once incremental", async () => {
    const source = createGmailSource(gmail);
    gmail.users.messages.get = vi.fn((p: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(p.id) }),
    );
    gmail.users.messages.list = vi.fn((p: { pageToken?: string }) =>
      Promise.resolve({
        data: p.pageToken
          ? { messages: [{ id: "b" }] }
          : { messages: [{ id: "a" }], nextPageToken: "2" },
      }),
    );
    serveDrafts(gmail, { "r-1": draftMessage("m-1") });

    const first = await source.sync(null);
    expect(first.hasMore).toBe(true);
    expect(first.documents.map((d) => d.externalId)).toContain("gmail-draft:r-1");

    const second = await source.sync(first.cursor);
    expect(second.hasMore).toBe(false);
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(1);
    expect(second.deletedExternalIds).toEqual([]);
    expect((second.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-1" });

    // The first incremental sync after the walk reads them again.
    serveDrafts(gmail, {});
    const third = await source.sync(second.cursor);
    expect(third.deletedExternalIds).toEqual(["gmail-draft:r-1"]);
  });

  test("a mid-bootstrap page carries the draft map without listing drafts", async () => {
    const source = createGmailSource(gmail);
    gmail.users.messages.get = vi.fn((p: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(p.id) }),
    );
    gmail.users.messages.list = vi.fn((p: { pageToken?: string }) =>
      Promise.resolve({
        data:
          p.pageToken === "2"
            ? { messages: [{ id: "b" }], nextPageToken: "3" }
            : { messages: [{ id: "a" }], nextPageToken: "2" },
      }),
    );
    serveDrafts(gmail, { "r-1": draftMessage("m-1") });
    const first = await source.sync(null);
    const second = await source.sync(first.cursor);
    expect(second.hasMore).toBe(true);
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(1);
    expect((second.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-1" });
  });

  test("a mailbox that refuses drafts (403) still syncs its messages and keeps known drafts", async () => {
    gmail.users.messages.list = vi.fn(() => Promise.resolve({ data: { messages: [{ id: "a" }] } }));
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: makeGmailMessage("a") }));
    gmail.users.drafts.list = vi.fn(() => Promise.reject(apiError(403)));
    const source = createGmailSource(gmail);
    const result = await source.sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual(["a"]);
    expect(result.deletedExternalIds).toEqual([]);

    const known = { ...(result.cursor as GmailSyncCursor), drafts: { "r-1": "m-1" } };
    const later = await source.sync(known);
    expect(later.deletedExternalIds).toEqual([]);
    expect((later.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-1" });
  });

  test("a 404 on the draft listing degrades the same way", async () => {
    gmail.users.drafts.list = vi.fn(() => Promise.reject(apiError(404)));
    const result = await createGmailSource(gmail).sync(null);
    expect(result.documents).toEqual([]);
  });

  test("a draft refused on read (403) keeps its previous document and the others still sync", async () => {
    const source = createGmailSource(gmail);
    serveDrafts(gmail, { "r-1": draftMessage("m-1"), "r-2": draftMessage("m-2") });
    const first = await source.sync(null);

    serveDrafts(gmail, { "r-1": draftMessage("m-3"), "r-2": draftMessage("m-4") });
    gmail.users.drafts.get = vi.fn((p: { id: string }) =>
      p.id === "r-1"
        ? Promise.reject(apiError(403))
        : Promise.resolve({ data: { id: "r-2", message: draftMessage("m-4") } }),
    );
    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual(["gmail-draft:r-2"]);
    expect(second.deletedExternalIds).toEqual([]);
    expect((second.cursor as GmailSyncCursor).drafts).toEqual({ "r-1": "m-1", "r-2": "m-4" });
  });

  test("a rate limit on drafts is not swallowed", async () => {
    gmail.users.drafts.list = vi.fn(() =>
      Promise.reject(Object.assign(new Error("slow down"), { code: 429 })),
    );
    await expect(createGmailSource(gmail).sync(null)).rejects.toThrow();
  });

  test("lists at most 500 drafts and deletes nothing it did not get to see", async () => {
    const page = (start: number, n: number, next?: string) => ({
      data: {
        drafts: Array.from({ length: n }, (_, i) => ({
          id: `r-${start + i}`,
          message: { id: `m-${start + i}` },
        })),
        nextPageToken: next,
      },
    });
    gmail.users.drafts.list = vi.fn((p: { pageToken?: string }) => {
      const start = p.pageToken ? Number(p.pageToken) : 0;
      return Promise.resolve(page(start, 100, String(start + 100)));
    });
    gmail.users.drafts.get = vi.fn((p: { id: string }) =>
      Promise.resolve({ data: { id: p.id, message: draftMessage(`m-${p.id.slice(2)}`) } }),
    );
    const source = createGmailSource(gmail);
    const known = { "r-900": "m-900" };
    const result = await source.sync({ phase: "bootstrap", drafts: known } as GmailSyncCursor);
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(5);
    expect(result.documents.filter((d) => d.externalId.startsWith("gmail-draft:"))).toHaveLength(
      500,
    );
    expect(result.deletedExternalIds).toEqual([]);
    expect((result.cursor as GmailSyncCursor).drafts!["r-900"]).toBe("m-900");
  });
});
