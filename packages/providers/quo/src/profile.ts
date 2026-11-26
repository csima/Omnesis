// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * One document per text message, either direction, on any of the workspace's
 * Quo numbers. The workspace's own side is the sender of an outgoing message
 * and a recipient of an incoming one; the other party, or every other member
 * of a group text, is the other role. Each document is one message, so no
 * field counts messages.
 *
 * Deliberately undeclared: opaque Quo ids (phone-number, user, message), and
 * `sourceUrl`.
 */
export const quoDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["sender", "recipient"],
  metadataFields: [
    {
      path: "extra.direction",
      type: "string",
      description:
        "Whether the text was received on a Quo number (incoming) or sent from one (outgoing). Outgoing texts are the workspace owner's side of the conversation.",
      allowedValues: ["incoming", "outgoing"],
      valueAliases: {
        incoming: ["received", "inbound", "from them"],
        outgoing: ["sent", "outbound", "reply", "replied", "from me"],
      },
    },
    {
      path: "extra.threadId",
      type: "string",
      description:
        "Quo conversation the text belongs to. Every text exchanged with the same person, or the same group, on the same Quo number shares it. It is Quo's conversationId, the identifier a reply names. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      semantics: "group-conversation",
      description: "Whether the text was exchanged with more than one other party.",
    },
    {
      path: "extra.quoNumber",
      type: "string",
      identifiesPeople: true,
      description:
        "The workspace's own Quo number the text was sent from or received on, in E.164 form such as +15550100100.",
    },
    {
      path: "extra.quoNumberId",
      type: "string",
      description:
        "Quo's id (PN…) for the workspace number the conversation is on. Opaque; a connector names it as the line a reply is sent from. Absent when Quo reported no number.",
    },
    {
      path: "extra.fromSelf",
      type: "boolean",
      description:
        "True when the text was sent from the workspace, false when it was received. The reliable test for whether the owner already answered a conversation: compare the newest fromSelf text with the newest incoming one.",
    },
    {
      path: "extra.quoNumberName",
      type: "string",
      description:
        "The name the workspace gave that Quo number, such as Main line or Support. Absent when the number has none.",
    },
    {
      path: "extra.counterparts",
      type: "string-array",
      identifiesPeople: true,
      description:
        "The other parties to the text, by number: the sender and any other recipients of an incoming text, the recipients of an outgoing one. Phone numbers are E.164; a short code or a sender name stays as Quo reported it.",
    },
    {
      path: "extra.deliveryStatus",
      type: "string",
      description:
        "Quo's delivery status for the text when it was indexed. Incoming texts are received; an outgoing text moves from queued to sent to delivered, or ends undelivered or failed, and a later change is not picked up.",
      canonicalValues: ["received", "queued", "sent", "delivered", "undelivered", "failed"],
    },
    {
      path: "automatedSender",
      type: "boolean",
      description:
        "True on an incoming text from a short code or a named sender id — verification codes, alerts and other automated senders that expect no human reply. Absent, never false, on the rest.",
    },
  ],
};
