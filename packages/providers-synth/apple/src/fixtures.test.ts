// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";

vi.mock("@omnesis/providers-synth-common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/providers-synth-common")>();
  const people = {
    self: { id: "owner", name: "Jamie Lopez" },
    owner: { id: "owner", name: "Jamie Lopez" },
    maya: { id: "maya", name: "Maya Reeves" },
    david: { id: "david", name: "David Lin" },
  };
  const getPerson = (ref: string) => {
    const person = people[ref as keyof typeof people];
    if (!person) throw new Error(`Unknown persona ${ref}`);
    return person;
  };
  return {
    ...actual,
    getPerson,
    personMention: (ref: string, role: string) => ({
      ...getPerson(ref),
      role,
      emails: [],
      phones: [],
      lids: [],
      isSelf: getPerson(ref).id === "owner",
    }),
  };
});
import { mapChat } from "./fixtures.js";

const ctx = {
  sourceId: SourceId("apple-imessage:fiction@example.com"),
  providerId: ProviderId("apple:fiction@example.com"),
};
const fixture = {
  externalId: "chat-day",
  chatId: "group",
  chatTitle: "Weekend plans",
  date: "2026-10-03",
  counterparty: "maya",
  messages: [
    { from: "self", at: "2026-10-03T10:00:00Z", text: "Which day?" },
    { from: "maya", at: "2026-10-03T10:01:00Z", text: "Saturday." },
    { from: "david", at: "2026-10-03T10:02:00Z", text: "Correction: Sunday." },
  ],
};
const first = (result: ReturnType<typeof mapChat>) => (Array.isArray(result) ? result[0]! : result);

describe("synthetic conversation identity", () => {
  test("group speakers and all participants resolve through cast once", () => {
    const doc = first(
      mapChat({ ...fixture, participants: ["owner", "maya", "maya", "david"] }, ctx),
    );
    expect(doc.content).toContain("You: Which day?");
    expect(doc.content).toContain("Maya Reeves: Saturday.");
    expect(doc.content).toContain("David Lin: Correction: Sunday.");
    expect(doc.metadata.people?.map((person) => person.name)).toEqual([
      "Jamie Lopez",
      "Maya Reeves",
      "David Lin",
    ]);
  });
  test("legacy conversations retain their chat-title speaker and counterpart", () => {
    const doc = first(mapChat(fixture, ctx));
    expect(doc.content).toContain("Weekend plans: Saturday.");
    expect(doc.metadata.people?.map((person) => person.name)).toEqual([
      "Jamie Lopez",
      "Maya Reeves",
    ]);
  });
  test("undeclared group sender is included, but unknown cast sender fails loudly", () => {
    expect(
      first(mapChat({ ...fixture, participants: ["maya"] }, ctx)).metadata.people,
    ).toHaveLength(3);
    expect(() =>
      mapChat(
        {
          ...fixture,
          participants: ["maya"],
          messages: [{ from: "missing", at: "2026-10-03T10:00:00Z", text: "Hello" }],
        },
        ctx,
      ),
    ).toThrow("Unknown persona");
  });
});

describe("synthetic conversation attachments", () => {
  const withFiles = {
    ...fixture,
    messages: [
      {
        from: "maya",
        guid: "GUID-1",
        at: "2026-10-03T10:01:00Z",
        text: "Photo from the ridge.",
        attachments: [{ filename: "ridge.jpg", mimeType: "image/jpeg", sizeBytes: 4096 }],
      },
      {
        from: "self",
        at: "2026-10-03T10:05:00Z",
        text: "Plan attached.",
        attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 2048 }],
      },
    ],
  };

  test("each file is a child linked to its message, named by a marker on the day", () => {
    const [day, photo, pdf] = mapChat(withFiles, ctx);
    const infos = day!.metadata.extra?.attachments as Array<{ attachmentId: string }>;
    expect(infos.map((info) => `chat-day/att/${info.attachmentId}`)).toEqual([
      photo!.externalId,
      pdf!.externalId,
    ]);
    expect(day!.content).toContain("ridge.jpg");
    expect(photo!.metadata.sourceUrl).toBe("messages://open?message-guid=GUID-1");
    // A message without a guid leaves the child the day's own link (none here).
    expect(pdf!.metadata.sourceUrl).toBeUndefined();
  });

  test("the day's hash follows its markers", () => {
    const plain = first(mapChat(fixture, ctx));
    const [day] = mapChat(withFiles, ctx);
    expect(day!.contentHash).not.toBe(plain.contentHash);
    expect(first(mapChat(withFiles, ctx)).contentHash).toBe(day!.contentHash);
  });
});
