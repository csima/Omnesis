// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { config, defineProvider, readConnectionState } from "@omnesis/source-sdk";
import { KondoClient } from "./client.js";
import { grantState, readGrant, StoredTokens } from "./credentials.js";
import { kondoIcon } from "./icons.js";
import { LINKEDIN_LID_PLATFORM } from "./normalizer.js";
import { authenticate, cleanupCredentials, discoverAccounts, isMemberAccount } from "./provider.js";
import { KondoSource } from "./source.js";
import { decodeKondoCursor, kondoStateSpec } from "./state.js";
import { DEFAULT_HISTORY_DAYS } from "./types.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";

export { KondoClient, READ_ONLY_TOOLS } from "./client.js";
export { KondoSource } from "./source.js";
export { normalizeChat, messageId } from "./normalizer.js";
export { kondoStateSpec } from "./state.js";
export type { KondoCursor } from "./state.js";

interface KondoContext {
  accountId: string;
  configDir?: string;
  client: KondoClient;
}

const settings = config.object({
  historyDays: config.number({
    label: "Initial history in days",
    help: "How far back the first sync reads conversations. Leave it at the default to read a year; indexed history does not expire.",
    default: DEFAULT_HISTORY_DAYS,
    min: 1,
    max: 3650,
    integer: true,
  }),
});

/**
 * One conversation document per LinkedIn chat per UTC day.
 *
 * Deliberately undeclared: `extra.conversationId` (a copy of `extra.threadKey`)
 * and `extra.date` (the document's own day).
 *
 * Kondo's read-only MCP tools report no unread, snooze, reminder, draft or
 * pending-invite state, so none is emitted or declared.
 */
export const kondoDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Names of the Kondo labels on the chat. Labels are created by the user, so the set is open.",
    },
    {
      path: "extra.labels",
      type: "string-array",
      description: "Kondo labels on the chat — the same names the tags carry.",
    },
    {
      path: "extra.chatName",
      type: "string",
      identifiesPeople: true,
      description:
        "The other people in the LinkedIn chat, by name, comma-separated; 'LinkedIn conversation' when Kondo names nobody.",
    },
    {
      path: "extra.participants",
      type: "string-array",
      identifiesPeople: true,
      description: "Display name of every other person in the LinkedIn chat.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      semantics: "message-count",
      description: "Messages exchanged in the chat that day.",
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      semantics: "group-conversation",
      description: "Whether the chat has more than one other person in it.",
    },
    {
      path: "extra.archived",
      type: "boolean",
      description: "Whether the chat sits in Kondo's archive rather than the inbox.",
    },
    {
      path: "extra.threadKey",
      type: "string",
      description:
        "Kondo's key for the chat: the identifier a connector names to open or answer it, shared by every day of the same conversation. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.inboxProfileId",
      type: "string",
      identifiesPeople: true,
      description:
        "The LinkedIn member id of the inbox the chat was read from, which is the account owner's own. Opaque; a connector names it as the member a reply is sent as.",
    },
    {
      path: "extra.participantProfileIds",
      type: "string-array",
      identifiesPeople: true,
      description:
        "LinkedIn member ids of the other people in the chat, where Kondo reported them. Opaque; empty when it reported none.",
    },
    {
      path: "extra.direction",
      type: "string",
      description:
        "Whether the account owner wrote anything in this day's conversation (sent) or only others did (received).",
      allowedValues: ["sent", "received"],
    },
    {
      path: "extra.selfMessageCount",
      type: "number",
      description: "How many of the day's messages the owner wrote.",
    },
    {
      path: "extra.lastMessageFromSelf",
      type: "boolean",
      description:
        "Whether the newest message of the day was written by the owner. False means the other side spoke last.",
    },
    {
      path: "extra.lastSelfMessageAt",
      type: "string",
      description:
        "ISO time of the owner's newest message of the day. Absent when they wrote none.",
    },
  ],
};

export default defineProvider<KondoContext>({
  provider: { id: "kondo", name: "Kondo" },
  authType: "oauth",
  experimental: true,

  discover(ctx) {
    return Promise.resolve(discoverAccounts(ctx?.configDir));
  },

  authenticate,

  async cleanupCredentials(accountId, ctx) {
    await cleanupCredentials(accountId, ctx?.configDir);
  },

  createContext({ accountId, host }) {
    const configDir = host?.configDir;
    const client = new KondoClient(new StoredTokens(String(accountId), configDir));
    return Promise.resolve({ accountId: String(accountId), configDir, client });
  },

  credentialState(ctx) {
    return readConnectionState(() => grantState(ctx.accountId, ctx.configDir));
  },

  async disposeContext() {},

  sources: [
    {
      id: "kondo",
      name: "Kondo (LinkedIn messages)",
      description:
        "LinkedIn direct messages through Kondo's read-only MCP server — each chat's day as one searchable conversation, archived chats included",
      unitName: "conversations",
      icon: kondoIcon,
      defaultSyncInterval: "15m",
      config: settings,
      multiDevice: { mode: "exclusive" },
      contentRetention: "best-effort",
      selfIdentity: { aliasPrefix: LINKEDIN_LID_PLATFORM, accountPattern: "^[0-9]+$" },
      documentEventProfile: kondoDocumentProfile,
      contract: {
        apiVersion: 2,
        outputRevision: 1,
        state: kondoStateSpec,
        requires: ["state-envelope", "typed-config"],
      },
      // A chat's URL opens the whole conversation, while a document is one day
      // of it; no pattern can recover the day, so none is declared rather than
      // one resolving links to the wrong document.
      async create(options, ctx) {
        const source = new KondoSource({
          client: ctx.client,
          providerId: options.providerId,
          sourceId: options.sourceId,
          ownerUrn: isMemberAccount(ctx.accountId) ? ctx.accountId : undefined,
          historyDays: Number(options.config?.historyDays ?? DEFAULT_HISTORY_DAYS),
          dataCutoff: options.dataCutoff,
        });
        const label = await readGrant(ctx.accountId, ctx.configDir)
          .then((grant) => grant?.label)
          .catch(() => undefined);
        return {
          icon: kondoIcon,
          ...(label ? { label } : {}),
          sync: (cursor, opts) => source.sync(decodeKondoCursor(cursor), opts),
        };
      },
    },
  ],
});
