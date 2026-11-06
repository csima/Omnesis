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
