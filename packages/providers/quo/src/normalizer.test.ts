// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { DAVID, FAKE_ORG_ID, JAMIE, MAIN_LINE, MAYA, SUPPORT_LINE } from "./fake-quo.js";
import { normalizeMessage, QUO_MESSAGE_URL_PATTERN, quoLid, quoMessageUrl } from "./normalizer.js";
import { quoMessageSchema } from "./schemas.js";
import type { NormalizeContext } from "./normalizer.js";
import type { QuoMessage } from "./schemas.js";

const ctx: NormalizeContext = {
  providerId: ProviderId(`quo:${FAKE_ORG_ID}`),
  sourceId: SourceId(`quo-messages:${FAKE_ORG_ID}`),
  organizationId: FAKE_ORG_ID,
  lines: new Map([
    [MAIN_LINE.id, { id: MAIN_LINE.id, number: MAIN_LINE.phoneNumber, name: MAIN_LINE.name }],
    [SUPPORT_LINE.id, { id: SUPPORT_LINE.id, number: SUPPORT_LINE.phoneNumber }],
  ]),
};

const SELF_LID = { kind: "lid", value: quoLid(FAKE_ORG_ID) };

function message(overrides: Partial<QuoMessage> & Pick<QuoMessage, "direction">): QuoMessage {
  const outgoing = overrides.direction === "outgoing";
  return quoMessageSchema.parse({
    id: "ACtest0001",
    from: outgoing ? MAIN_LINE.phoneNumber : MAYA,
    to: outgoing ? [MAYA] : [MAIN_LINE.phoneNumber],
    text: "Is the rehearsal still at six?",
    phoneNumberId: MAIN_LINE.id,
    conversationId: "CNmaya0001",
    userId: outgoing ? "USowner001" : null,
    status: outgoing ? "delivered" : "received",
    createdAt: "2026-10-04T18:30:00Z",
    updatedAt: "2026-10-04T18:30:02Z",
    media: [],
    ...overrides,
  });
}

describe("normalizeMessage", () => {
  test("an incoming text: the other party sends, the workspace's line receives", () => {
    const doc = normalizeMessage(message({ direction: "incoming" }), ctx);

    expect(doc.externalId).toBe("ACtest0001");
    expect(doc.title).toBe(`Text from ${MAYA}`);
    expect(doc.content.split("\n")[0]).toBe("Is the rehearsal still at six?");
    expect(doc.content).toContain(
      "Incoming text, received on the Quo number +15550100100 (Main line)",
    );
    expect(doc.sourceCreatedAt).toBe("2026-10-04T18:30:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-10-04T18:30:02.000Z");
    expect(doc.metadata).toMatchObject({
      documentType: "conversation",
      sourceUrl: "https://my.quo.com/inbox/PNmainline01/c/CNmaya0001?at=ACtest0001",
      extra: {
        direction: "incoming",
        threadId: "CNmaya0001",
        isGroup: false,
        deliveryStatus: "received",
        counterparts: [MAYA],
        quoNumber: MAIN_LINE.phoneNumber,
        quoNumberName: "Main line",
      },
    });
    expect(doc.metadata.automatedSender).toBeUndefined();
    expect(doc.metadata.people).toEqual([
      {
        role: "recipient",
        identifiers: [SELF_LID, { kind: "phone", value: MAIN_LINE.phoneNumber }],
      },
      { role: "sender", identifiers: [{ kind: "phone", value: MAYA }] },
    ]);
  });

  test("an outgoing text is the owner's own: the self LID sends from the line", () => {
    const doc = normalizeMessage(message({ direction: "outgoing", text: "Yes, six sharp." }), ctx);

    expect(doc.title).toBe(`Text to ${MAYA}`);
    expect(doc.content).toContain(
      "Outgoing text, sent from the Quo number +15550100100 (Main line)",
    );
    expect(doc.metadata.extra).toMatchObject({
      direction: "outgoing",
      deliveryStatus: "delivered",
    });
    expect(doc.metadata.people).toEqual([
      { role: "sender", identifiers: [SELF_LID, { kind: "phone", value: MAIN_LINE.phoneNumber }] },
      { role: "recipient", identifiers: [{ kind: "phone", value: MAYA }] },
    ]);
    expect(doc.metadata.people!.some((p) => p.isSelf)).toBe(false);
  });

  test("an incoming group text names every other member, and only the sender sends", () => {
    const doc = normalizeMessage(
      message({
        direction: "incoming",
        from: JAMIE,
        to: [MAIN_LINE.phoneNumber, MAYA, DAVID],
        conversationId: "CNgroup0001",
      }),
      ctx,
    );
    expect(doc.title).toBe(`Group text from ${JAMIE}`);
    expect(doc.metadata.extra).toMatchObject({
      isGroup: true,
      threadId: "CNgroup0001",
      counterparts: [JAMIE, MAYA, DAVID],
    });
    expect(doc.metadata.people!.map((p) => [p.role, p.identifiers?.at(-1)?.value])).toEqual([
      ["recipient", MAIN_LINE.phoneNumber],
      ["sender", JAMIE],
      ["recipient", MAYA],
      ["recipient", DAVID],
    ]);
  });

  test("an outgoing group text and the group's incoming texts share one thread", () => {
    const out = normalizeMessage(
      message({ direction: "outgoing", to: [MAYA, JAMIE, DAVID], conversationId: "CNgroup0001" }),
      ctx,
    );
    const back = normalizeMessage(
      message({
        id: "ACtest0002",
        direction: "incoming",
        from: MAYA,
        to: [MAIN_LINE.phoneNumber, JAMIE, DAVID],
        conversationId: "CNgroup0001",
      }),
      ctx,
    );
    expect(out.title).toBe(`Group text to ${MAYA}, ${JAMIE}, ${DAVID}`);
    expect(out.metadata.extra?.isGroup).toBe(true);
    expect(out.metadata.extra?.threadId).toBe(back.metadata.extra?.threadId);
    expect(out.metadata.people!.filter((p) => p.role === "recipient")).toHaveLength(3);
  });

  test("a short code or a sender name is an automated sender, never a person", () => {
    for (const from of ["72345", "ACMEBANK"]) {
      const doc = normalizeMessage(message({ direction: "incoming", from }), ctx);
      expect(doc.metadata.automatedSender).toBe(true);
      expect(doc.metadata.people).toEqual([
        {
          role: "recipient",
          identifiers: [SELF_LID, { kind: "phone", value: MAIN_LINE.phoneNumber }],
        },
      ]);
      expect(doc.metadata.extra?.counterparts).toEqual([from]);
    }
  });

  test("a withheld caller is no person and no automated sender", () => {
    const doc = normalizeMessage(message({ direction: "incoming", from: "Anonymous" }), ctx);
    expect(doc.title).toBe("Text from a withheld number");
    expect(doc.metadata.automatedSender).toBeUndefined();
    expect(doc.metadata.people).toHaveLength(1);
  });

  test("a line Quo no longer lists is recognised from the message itself", () => {
    const bare: NormalizeContext = { ...ctx, lines: new Map() };
    const out = normalizeMessage(
      message({ direction: "outgoing", phoneNumberId: "PNgone0001" }),
      bare,
    );
    expect(out.metadata.extra?.quoNumber).toBe(MAIN_LINE.phoneNumber);
    expect(out.metadata.extra?.quoNumberName).toBeUndefined();
    expect(out.metadata.extra?.counterparts).toEqual([MAYA]);

    const unknownIncoming = normalizeMessage(
      message({ direction: "incoming", phoneNumberId: null }),
      bare,
    );
    expect(unknownIncoming.metadata.sourceUrl).toBeUndefined();
    expect(unknownIncoming.metadata.extra?.quoNumber).toBeUndefined();
    expect(unknownIncoming.content).toContain("received on the Quo number of this workspace");
  });

  test("attachments are summarised by type; their URLs stay out of the document", () => {
    const doc = normalizeMessage(
      message({
        direction: "incoming",
        text: "",
        media: [
          { url: "https://media.example.com/a?sig=secret", type: "image/jpeg" },
          { url: "https://media.example.com/b?sig=secret", type: "image/jpeg" },
        ],
      }),
      ctx,
    );
    expect(doc.content.split("\n").slice(0, 2)).toEqual([
      "_(no text)_",
      "_2 attachments (image/jpeg)_",
    ]);
    expect(JSON.stringify(doc)).not.toContain("sig=secret");
  });

  test("an update stamp older than creation never moves the document back in time", () => {
    const doc = normalizeMessage(
      message({ direction: "incoming", updatedAt: "2026-10-04T18:29:00Z" }),
      ctx,
    );
    expect(doc.sourceUpdatedAt).toBe(doc.sourceCreatedAt);
  });

  test("the content hash follows the text", () => {
    const a = normalizeMessage(message({ direction: "incoming" }), ctx);
    const b = normalizeMessage(message({ direction: "incoming", text: "Different" }), ctx);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(normalizeMessage(message({ direction: "incoming" }), ctx).contentHash).toBe(
      a.contentHash,
    );
  });
});

describe("deep links", () => {
  test("the declared URL pattern recovers the external id from an emitted sourceUrl", () => {
    const doc = normalizeMessage(message({ direction: "outgoing" }), ctx);
    const match = new RegExp(QUO_MESSAGE_URL_PATTERN).exec(doc.metadata.sourceUrl!);
    expect(match?.[1]).toBe(doc.externalId);
  });

  test("the pattern also matches with other query parameters, and nothing without a message", () => {
    const re = new RegExp(QUO_MESSAGE_URL_PATTERN);
    expect(re.exec("https://my.quo.com/inbox/PNa1/c/CNb2?foo=1&at=ACc3")?.[1]).toBe("ACc3");
    expect(re.exec("https://my.quo.com/inbox/PNa1/c/CNb2")).toBeNull();
    expect(re.exec("https://my.quo.com/contacts/CT123")).toBeNull();
  });

  test("a message without a number has no inbox to open", () => {
    expect(quoMessageUrl(message({ direction: "incoming", phoneNumberId: null }))).toBeUndefined();
  });
});

describe("the message schema at the boundary", () => {
  test("accepts Quo's documented shape and ignores fields it does not know", () => {
    const parsed = quoMessageSchema.safeParse({
      ...message({ direction: "incoming" }),
      somethingNew: { nested: true },
      media: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.media).toEqual([]);
  });

  test.each([
    ["an id without its prefix", { id: "12345" }],
    ["an unknown direction", { direction: "sideways" }],
    ["an unreadable timestamp", { createdAt: "yesterday" }],
    ["recipients that are not a list", { to: MAYA }],
  ])("rejects %s", (_label, patch) => {
    expect(
      quoMessageSchema.safeParse({ ...message({ direction: "incoming" }), ...patch }).success,
    ).toBe(false);
  });
});
