// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import type { DocumentEventProfile } from "@omnesis/source-sdk";
export const slackDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant", "mentioned"],
  metadataFields: [
    {
      path: "extra.workspaceName",
      type: "string",
      description: "Slack workspace containing this conversation.",
    },
    {
      path: "extra.conversationName",
      type: "string",
      description: "Slack channel or direct conversation name.",
    },
    {
      path: "extra.conversationKind",
      type: "string",
      description: "Slack conversation kind.",
      allowedValues: ["channel", "private-channel", "dm", "group-dm"],
    },
    {
      path: "extra.participants",
      type: "string-array",
      identifiesPeople: true,
      description: "People who contributed messages or thread replies.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      semantics: "message-count",
      description: "Messages including thread replies, attached to the root day.",
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      semantics: "group-conversation",
      description: "Whether the conversation is shared by several members.",
    },
    {
      path: "extra.direction",
      type: "string",
      description:
        "Whether the account owner posted anything in this day's conversation (sent) or only others did (received).",
      allowedValues: ["sent", "received"],
    },
    {
      path: "extra.selfMessageCount",
      type: "number",
      description: "How many of the day's messages, thread replies included, the owner posted.",
    },
    {
      path: "extra.lastMessageFromSelf",
      type: "boolean",
      description:
        "Whether the newest message in the day, thread replies included, was posted by the owner.",
    },
    {
      path: "extra.lastSelfMessageAt",
      type: "string",
      description:
        "ISO time of the owner's newest message in the day. Absent when they posted none.",
    },
    {
      path: "extra.workspaceId",
      type: "string",
      description: "Slack team id (T…) of the workspace. Opaque; what a connector posts into.",
    },
    {
      path: "extra.channelId",
      type: "string",
      description: "Slack conversation id (C…, G… or D…) a reply is posted to. Opaque.",
    },
    {
      path: "extra.threadTs",
      type: "string-array",
      description:
        "The thread_ts of every thread with messages in the day, oldest first: a root's own ts for a top-level message or thread, the parent's ts for replies. Reply in a thread by posting with its value.",
    },
    {
      path: "extra.unansweredThreadTs",
      type: "string-array",
      description:
        "The threadTs entries whose newest message in the day was not posted by the owner.",
    },
    {
      path: "extra.latestTs",
      type: "string",
      description: "The Slack ts of the newest message in the day, thread replies included.",
    },
  ],
};

export function profileFor(session: boolean): DocumentEventProfile {
  return {
    ...slackDocumentProfile,
    metadataFields: [
      ...(slackDocumentProfile.metadataFields ?? []),
      {
        path: "extra.connectionMode",
        type: "string",
        description: "Credential kind used to observe the workspace.",
        allowedValues: [session ? "session" : "official"],
      },
    ],
  };
}
