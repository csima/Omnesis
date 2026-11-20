// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { JAMIE, MAYA, OWNER, OWNER_URN, msg } from "./fake-kondo.js";
import { linkedinHandle, messageId, normalizeChat } from "./normalizer.js";
import { parseChat } from "./types.js";
import type { NormalizeContext } from "./normalizer.js";

const ctx: NormalizeContext = {
  providerId: ProviderId(`kondo:${OWNER_URN}`),
  sourceId: SourceId(`kondo:${OWNER_URN}`),
  ownerUrn: OWNER_URN,
  labels: { "lbl-hiring": "Hiring" },
  archived: false,
};

function chat(overrides: Record<string, unknown> = {}) {
  const parsed = parseChat({
    profileUrn: OWNER_URN,
    threadKey: "thread-a",
    participants: [OWNER, MAYA],
    messages: [
      msg(MAYA, "2026-03-08T09:15:00.000Z", "Are you open to a Q4 budget review chat?"),
      msg("self", "2026-03-08T09:40:00.000Z", "Sure, Thursday works."),
      msg(MAYA, "2026-03-09T08:05:00.000Z", "Great, sending an invite."),
    ],
    labelKeys: ["lbl-hiring"],
    chatUrl: "https://app.trykondo.com/inboxes/all/thread-a",
    ...overrides,
  });
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

describe("normalizeChat", () => {
  test("renders one conversation document per UTC day", () => {
    const docs = normalizeChat(chat(), ctx);
    expect(docs.map((d) => d.externalId)).toEqual(["thread-a:2026-03-08", "thread-a:2026-03-09"]);
    const first = docs[0];
    expect(first.title).toBe("LinkedIn chat with Maya Reeves — 2026-03-08");
    expect(first.content).toBe(
      [
        "# LinkedIn chat with Maya Reeves — 2026-03-08",
        "",
        "**09:15** Maya Reeves: Are you open to a Q4 budget review chat?",
        "**09:40** Sarah Mendez: Sure, Thursday works.",
      ].join("\n"),
    );
    expect(first.sourceCreatedAt).toBe("2026-03-08T09:15:00.000Z");
    expect(first.sourceUpdatedAt).toBe("2026-03-08T09:40:00.000Z");
    expect(first.metadata.sourceUrl).toBe("https://app.trykondo.com/inboxes/all/thread-a");
    expect(first.metadata.documentType).toBe("conversation");
    expect(first.metadata.tags).toEqual(["Hiring"]);
    expect(first.metadata.extra).toEqual({
      threadKey: "thread-a",
      conversationId: "thread-a",
      chatName: "Maya Reeves",
      isGroup: false,
      messageCount: 2,
      participants: ["Maya Reeves"],
      labels: ["Hiring"],
      archived: false,
      date: "2026-03-08",
    });
  });

  test("names the owner by the inbox's member id and everyone else by theirs and their handle", () => {
    const [doc] = normalizeChat(chat(), ctx);
    expect(doc.metadata.people).toEqual([
      {
        role: "participant",
        name: "Sarah Mendez",
        lids: ["linkedin:100000001", "linkedin-in:sarah-mendez-example"],
      },
      {
        role: "participant",
        name: "Maya Reeves",
        lids: ["linkedin:100000002", "linkedin-in:maya-reeves-example"],
      },
    ]);
  });

  test("a group chat lists every member, and a sender absent from the roster cannot create a person", () => {
    const [doc] = normalizeChat(
      chat({
        participants: [OWNER, MAYA, JAMIE],
        messages: [
          msg(JAMIE, "2026-03-08T10:00:00.000Z", "Adding David to the thread."),
          { sender: "David Lin", self: false, time: "2026-03-08T10:05:00.000Z", text: "Hi all" },
        ],
      }),
      ctx,
    );
    expect(doc.metadata.extra).toMatchObject({
      isGroup: true,
      chatName: "Maya Reeves, Jamie Lopez, David Lin",
      participants: ["Maya Reeves", "Jamie Lopez", "David Lin"],
    });
    expect(doc.metadata.people?.at(-1)).toEqual({
      role: "participant",
      name: "David Lin",
      allowPersonCreation: false,
    });
  });

  test("LinkedIn's placeholder for an unnamed member is not a person's name", () => {
    const [doc] = normalizeChat(
      chat({
        participants: [OWNER, { fullName: "LinkedIn Member", profileUrn: "100000009" }],
        messages: [
          {
            sender: "LinkedIn Member",
            self: false,
            time: "2026-03-08T10:00:00.000Z",
            text: "Hello",
          },
        ],
      }),
      ctx,
    );
    expect(doc.metadata.people?.[1]).toEqual({ role: "participant", lids: ["linkedin:100000009"] });
    expect(doc.metadata.extra?.participants).toEqual([]);
  });

  test("the owner is recognised by the name on their own messages when the member ids differ", () => {
    const [doc] = normalizeChat(
      chat({ participants: [{ ...OWNER, profileUrn: "ACoAAExample" }, MAYA] }),
      ctx,
    );
    expect(doc.metadata.extra?.participants).toEqual(["Maya Reeves"]);
    expect(doc.metadata.people?.[0]).toMatchObject({
      name: "Sarah Mendez",
      lids: expect.arrayContaining(["linkedin:100000001", "linkedin:ACoAAExample"]),
    });
  });

  test("without a known owner the self sender is marked isSelf rather than given an identity", () => {
    const [doc] = normalizeChat(chat({ participants: [MAYA] }), { ...ctx, ownerUrn: undefined });
    expect(doc.metadata.people?.[0]).toEqual({ role: "participant", isSelf: true });
  });

  test("renders only days from the floor's day on", () => {
    const docs = normalizeChat(chat(), ctx, "2026-03-09");
    expect(docs.map((d) => d.externalId)).toEqual(["thread-a:2026-03-09"]);
  });

  test("a message Kondo returns twice is rendered once", () => {
    const repeated = msg(MAYA, "2026-03-08T09:15:00.000Z", "Hello");
    const [doc] = normalizeChat(chat({ messages: [repeated, { ...repeated }] }), ctx);
    expect(doc.metadata.extra?.messageCount).toBe(1);
  });

  test("a day with only empty messages produces no document", () => {
    expect(
      normalizeChat(chat({ messages: [msg(MAYA, "2026-03-08T09:15:00.000Z", "   ")] }), ctx),
    ).toEqual([]);
  });

  test("a chat URL outside Kondo's app is not used as the document link", () => {
    const [doc] = normalizeChat(chat({ chatUrl: "https://example.com/elsewhere" }), ctx);
    expect(doc.metadata.sourceUrl).toBeUndefined();
    const [bare] = normalizeChat(chat({ chatUrl: "app.trykondo.com/inboxes/all/thread-a" }), ctx);
    expect(bare.metadata.sourceUrl).toBe("https://app.trykondo.com/inboxes/all/thread-a");
  });

  test("the content hash changes when a day gains a message and not otherwise", () => {
    const [a] = normalizeChat(chat(), ctx);
    const [b] = normalizeChat(chat(), ctx);
    expect(a.contentHash).toBe(b.contentHash);
    const grown = chat();
    grown.messages.push(msg(MAYA, "2026-03-08T11:00:00.000Z", "One more thing"));
    expect(normalizeChat(grown, ctx)[0].contentHash).not.toBe(a.contentHash);
  });
});

describe("parseChat", () => {
  test("skips an unreadable message and keeps the rest", () => {
    const parsed = parseChat({
      profileUrn: OWNER_URN,
      threadKey: "thread-a",
      participants: [MAYA, { fullName: 42 }],
      messages: [msg(MAYA, "2026-03-08T09:15:00.000Z", "ok"), { sender: "x", time: "not a date" }],
    });
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.participants).toHaveLength(1);
    expect(parsed?.skippedMessages).toBe(1);
  });

  test("rejects a chat without a thread key", () => {
    expect(parseChat({ profileUrn: OWNER_URN, messages: [] })).toBeNull();
  });
});

describe("helpers", () => {
  test("messageId is stable and depends on direction and text", () => {
    const m = msg(MAYA, "2026-03-08T09:15:00.000Z", "Hello");
    expect(messageId("t", m)).toBe(messageId("t", { ...m, time: "2026-03-08T09:15:00Z" }));
    expect(messageId("t", m)).not.toBe(messageId("t", { ...m, self: true }));
    expect(messageId("t", m)).not.toBe(messageId("u", m));
  });

  test("linkedinHandle reads only linkedin.com/in URLs", () => {
    expect(linkedinHandle("https://www.linkedin.com/in/Maya-Reeves-Example/")).toBe(
      "maya-reeves-example",
    );
    expect(linkedinHandle("https://www.linkedin.com/company/example")).toBeUndefined();
    expect(linkedinHandle("https://example.com/in/maya")).toBeUndefined();
    expect(linkedinHandle("not a url")).toBeUndefined();
  });
});
