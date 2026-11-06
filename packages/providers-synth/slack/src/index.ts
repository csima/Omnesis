// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { z } from "zod";
import realSlack, {
  normalizeDay,
  conversationSchema,
  messageSchema,
  userSchema,
} from "@omnesis/provider-slack";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  loadActiveUniverse,
  loadSourceFixtureJson,
  preDiscoveredAccounts,
  universeAccounts,
  fakeLocalFlow,
} from "@omnesis/providers-synth-common";

const fixtureSchema = z.object({
  identity: z.object({
    team_id: z.string(),
    user_id: z.string(),
    team: z.string(),
    url: z.string(),
  }),
  conversations: z.array(conversationSchema),
  users: z.array(userSchema),
  messages: z.array(messageSchema.extend({ conversation: z.string(), day: z.string() })),
});
const { type: _type, ...rest } = realSlack;
export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "local",
  credentials: undefined,
  authenticate: undefined,
  cleanupCredentials: undefined,
  discover: async () => preDiscoveredAccounts("slack", universeAccounts("slack")),
  authFlow: async () => fakeLocalFlow("slack", universeAccounts("slack")[0] ?? "synthetic"),
  createContext: async () => ({}),
  disposeContext: undefined,
  credentialState: async () => ({ status: "connected" }),
  sources: rest.sources.map((entry) => ({
    ...entry,
    contract: undefined,
    config: undefined,
    params: undefined,
    supportedPlatforms: undefined,
    analyticsSchemas: undefined,
    authType: "local",
    credentials: undefined,
    authenticate: undefined,
    cleanupCredentials: undefined,
    discover: async () => preDiscoveredAccounts("slack", universeAccounts(entry.id)),
    async create({ sourceId, providerId }) {
      return {
        async sync() {
          const data = fixtureSchema.parse(
            loadSourceFixtureJson(loadActiveUniverse(), "slack", "messages.json"),
          );
          const groups = new Map<string, typeof data.messages>();
          for (const m of data.messages) {
            const key = m.conversation + ":" + m.day;
            const group = groups.get(key) ?? [];
            group.push(m);
            groups.set(key, group);
          }
          const documents = [...groups.values()].flatMap((messages) => {
            const first = messages[0];
            const conversation = data.conversations.find((c) => c.id === first.conversation)!;
            const doc = normalizeDay(conversation, first.day, messages, data.users, data.identity, {
              sourceId,
              providerId,
              session: entry.id === "slack-session",
            });
            return doc ? [doc] : [];
          });
          return syncPage(documents, { offset: documents.length });
        },
      };
    },
  })),
});
