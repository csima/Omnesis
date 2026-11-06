// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { normalizeDay, MAX_CONTENT_CHARS } from "./normalizer.js";
import { CHANNEL, IDENTITY } from "./fake-slack.js";
import { slackTs } from "./types.js";
const ids = {
  providerId: ProviderId("slack:TEXAMPLE-USELF00"),
  sourceId: SourceId("slack:TEXAMPLE-USELF00"),
};
describe("daily Slack normalizer", () => {
  it("attaches replies, people, self, emails, file links and exact permalinks", () => {
    const root = slackTs(Date.parse("2026-05-19T10:00:00Z"));
    const doc = normalizeDay(
      CHANNEL,
      "2026-05-19",
      [
        { ts: root, text: "Hello <@USELF00>", user: "UOTHER0" },
        {
          ts: slackTs(Date.parse("2026-05-20T10:00:00Z")),
          thread_ts: root,
          text: "Reply",
          user: "USELF00",
          files: [{ name: "example.txt", permalink: "https://example.com/file" }],
        },
      ],
      [
        { id: "USELF00", name: "alex", profile: { email: "alex@example.com" } },
        { id: "UOTHER0", name: "river" },
      ],
      IDENTITY,
      ids,
    )!;
    expect(doc.externalId).toBe("CEXAMPLE:2026-05-19");
    expect(doc.content).toContain("↳");
    expect(doc.content).toContain("example.txt");
    expect(doc.metadata.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isSelf: true,
          lids: ["slack:TEXAMPLE-USELF00"],
          emails: ["alex@example.com"],
        }),
      ]),
    );
    expect(doc.metadata.sourceUrl).toBe(
      `https://example-workshop.slack.com/archives/CEXAMPLE/p${root.replace(".", "")}`,
    );
    expect(doc.metadata.extra).toMatchObject({
      messageCount: 2,
      conversationKind: "channel",
      isGroup: true,
    });
  });
  it("bounds large previews while preserving the full message count", () => {
    const doc = normalizeDay(
      CHANNEL,
      "2026-05-19",
      [
        {
          ts: "1779184800.000000",
          user: "UOTHER0",
          text: "x".repeat(MAX_CONTENT_CHARS + 100),
        },
      ],
      [],
      IDENTITY,
      ids,
    )!;
    expect(doc.content.length).toBe(MAX_CONTENT_CHARS);
    expect(doc.content).toContain("preview truncated");
    expect(doc.metadata.extra).toMatchObject({ messageCount: 1 });
  });
  it("returns no document for an empty confirmed day", () => {
    expect(normalizeDay(CHANNEL, "2026-05-19", [], [], IDENTITY, ids)).toBeNull();
  });
});
