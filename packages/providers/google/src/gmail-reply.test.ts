// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, expect, test } from "vitest";
import { gmailDirection, gmailReplyFields, gmailTriage } from "./gmail-reply.js";

describe("gmailReplyFields", () => {
  test("keeps the RFC 5322 identifiers with their brackets", () => {
    expect(
      gmailReplyFields({
        messageId: "<abc@mail.example.com>",
        inReplyTo: "<prev@mail.example.com>",
        references: "<root@mail.example.com>\r\n <prev@mail.example.com>",
      }),
    ).toEqual({
      messageId: "<abc@mail.example.com>",
      inReplyTo: "<prev@mail.example.com>",
      references: ["<root@mail.example.com>", "<prev@mail.example.com>"],
    });
  });

  test("omits identifiers the message does not carry", () => {
    expect(gmailReplyFields({ messageId: "", inReplyTo: "", references: "" })).toEqual({});
  });
});

describe("gmailDirection", () => {
  test("the SENT label means sent", () => {
    expect(gmailDirection(["SENT"], "other@example.com", "me@example.com")).toBe("sent");
  });

  test("the account's own address in From means sent", () => {
    expect(gmailDirection(["INBOX"], "Me <ME@example.com>", "me@example.com")).toBe("sent");
  });

  test("anything else is received", () => {
    expect(gmailDirection(["INBOX"], "a@example.com", "me@example.com")).toBe("received");
    expect(gmailDirection([], "", undefined)).toBe("received");
  });
});

describe("gmailTriage", () => {
  test("an unread inbox message", () => {
    expect(gmailTriage(["INBOX", "UNREAD"])).toEqual({
      unread: true,
      archived: false,
      starred: false,
    });
  });

  test("a read, archived, starred message", () => {
    expect(gmailTriage(["STARRED", "IMPORTANT"])).toEqual({
      unread: false,
      archived: true,
      starred: true,
    });
  });

  test("sent mail and drafts are not archived", () => {
    expect(gmailTriage(["SENT"]).archived).toBe(false);
    expect(gmailTriage(["DRAFT"]).archived).toBe(false);
  });
});
